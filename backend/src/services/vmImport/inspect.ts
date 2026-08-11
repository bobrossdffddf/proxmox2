/**
 * Work out what an uploaded bundle actually contains.
 *
 * The three shapes we see in practice:
 *   - `.ova`            — a tar of an OVF descriptor plus its disks
 *   - `.zip`            — someone zipped the whole VMware VM folder
 *                         (`.vmx` + `.vmdk`s, usually no OVF at all)
 *   - a bare disk image — `.vmdk`, `.qcow2`, `.raw`
 *
 * All three come out of here as a `BundleInspection`: a file list with roles
 * assigned, plus a `GuestSpec` of CPU/RAM/disks/OS read from whichever
 * descriptor was present. Nothing here talks to Proxmox — it's pure inspection,
 * so the wizard can show the admin what it found before anything is committed.
 */
import fs from "fs";
import path from "path";
import {
  ArchiveEntry,
  ArchiveKind,
  detectArchiveKind,
  listEntries,
  readEntry,
  readEntryHead,
} from "../archive";
import { detectOs, minimumMemoryMb } from "./guestOs";
import { attr, findAll, findFirst, parseXml, textOf, XmlNode } from "./xml";
import type { BundleFile, BundleFileRole, BundleInspection, DiskSpec, GuestSpec } from "./types";

/** Junk that macOS and Windows sprinkle into zips. Never interesting. */
const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|\._)/i;

/**
 * VMware splits big disks into extents and stores a small text descriptor
 * alongside them. Only the descriptor may be handed to the converter, so the
 * extents have to be recognised and excluded as import candidates — but still
 * carried along in the package, since the descriptor references them.
 */
const VMDK_EXTENT = /(-s\d+|-f\d+|-flat|-delta|-\d{6})\.vmdk$/i;

const DISK_EXT = /\.(vmdk|qcow2|raw|img|vhd|vhdx|vdi)$/i;

export async function inspectBundle(filePath: string, originalName: string): Promise<BundleInspection> {
  const kind = await detectArchiveKind(filePath);
  const warnings: string[] = [];

  if (!kind) {
    return inspectBareImage(filePath, originalName, warnings);
  }

  const entries = (await listEntries(filePath, kind)).filter(
    (e) => !e.isDirectory && !JUNK.test(e.name) && e.size > 0
  );
  if (entries.length === 0) {
    throw new Error("Archive is empty (or contains only directories)");
  }

  const files = classify(entries);
  const container = kind === "zip" ? "zip" : "ova";

  const ovf = files.find((f) => f.role === "ovf");
  const vmx = files.find((f) => f.role === "vmx");

  let spec: GuestSpec;
  if (ovf) {
    const entry = entryFor(entries, ovf);
    const xml = (await readEntry(filePath, kind, entry, 4 * 1024 * 1024)).toString("utf8");
    spec = parseOvf(xml, files, warnings);
  } else if (vmx) {
    const entry = entryFor(entries, vmx);
    const text = (await readEntry(filePath, kind, entry, 1024 * 1024)).toString("utf8");
    spec = parseVmx(text, files, warnings);
    warnings.push(
      "No OVF descriptor in this bundle — specs were read from the .vmx and an OVF will be generated for the import."
    );
  } else {
    spec = heuristicSpec(files, originalName, warnings);
    warnings.push("No .ovf or .vmx descriptor found — CPU, memory and OS are guesses. Check them before importing.");
  }

  await fillDiskCapacities(filePath, kind, entries, files, spec);
  finalize(spec, files, warnings);

  return {
    container,
    files,
    spec,
    totalDiskBytes: files
      .filter((f) => f.role === "disk" || f.role === "disk-extent")
      .reduce((sum, f) => sum + f.size, 0),
    warnings,
  };
}

/** A raw `.vmdk`/`.qcow2` handed over with no wrapper around it. */
async function inspectBareImage(
  filePath: string,
  originalName: string,
  warnings: string[]
): Promise<BundleInspection> {
  if (!DISK_EXT.test(originalName)) {
    throw new Error(
      `Unrecognised upload "${originalName}". Expected a .zip, .ova, .ovf bundle, or a disk image (.vmdk, .qcow2, .raw).`
    );
  }

  const { size } = await fs.promises.stat(filePath);
  const base = path.basename(originalName);
  const file: BundleFile = { name: base, flatName: base, size, role: "disk" };

  const spec = heuristicSpec([file], originalName, warnings);
  const head = await fs.promises.open(filePath, "r").then(async (h) => {
    try {
      const buf = Buffer.alloc(Math.min(2048, size));
      await h.read(buf, 0, buf.length, 0);
      return buf;
    } finally {
      await h.close();
    }
  });
  spec.disks = [{ file: base, capacityBytes: readImageCapacity(head), slot: 0 }];

  warnings.push("A bare disk image carries no CPU, memory or OS information — set those yourself below.");
  finalize(spec, [file], warnings);

  return { container: "raw", files: [file], spec, totalDiskBytes: size, warnings };
}

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

function classify(entries: ArchiveEntry[]): BundleFile[] {
  const used = new Set<string>();

  return entries.map((entry) => {
    const base = path.posix.basename(entry.name);

    // Repackaging flattens the tree, so collisions between same-named files in
    // different folders have to be broken here rather than silently later.
    let flat = base;
    for (let n = 2; used.has(flat.toLowerCase()); n++) {
      const ext = path.posix.extname(base);
      flat = `${base.slice(0, base.length - ext.length)}-${n}${ext}`;
    }
    used.add(flat.toLowerCase());

    return { name: entry.name, flatName: flat, size: entry.size, role: roleOf(base) };
  });
}

function roleOf(base: string): BundleFileRole {
  const lower = base.toLowerCase();
  if (lower.endsWith(".ovf")) return "ovf";
  if (lower.endsWith(".vmx")) return "vmx";
  if (lower.endsWith(".mf")) return "manifest";
  if (lower.endsWith(".nvram")) return "nvram";
  if (lower.endsWith(".iso")) return "iso";
  if (lower.endsWith(".vmdk")) return VMDK_EXTENT.test(lower) ? "disk-extent" : "disk";
  if (DISK_EXT.test(lower)) return "disk";
  return "other";
}

function entryFor(entries: ArchiveEntry[], file: BundleFile): ArchiveEntry {
  const found = entries.find((e) => e.name === file.name);
  if (!found) throw new Error(`Internal error: no archive entry for ${file.name}`);
  return found;
}

// ---------------------------------------------------------------------------
// OVF
// ---------------------------------------------------------------------------

function parseOvf(xml: string, files: BundleFile[], warnings: string[]): GuestSpec {
  const root = parseXml(xml);

  // References map an id ("file1") to a stored file name ("disk-0.vmdk"),
  // and DiskSection maps a disk id to one of those references plus a capacity.
  const hrefById = new Map<string, string>();
  for (const ref of findAll(root, "File")) {
    const id = attr(ref, "id");
    const href = attr(ref, "href");
    if (id && href) hrefById.set(id, decodeURIComponent(href));
  }

  interface OvfDisk { href: string; capacity: number | null }
  const diskById = new Map<string, OvfDisk>();
  for (const disk of findAll(root, "Disk")) {
    const id = attr(disk, "diskid");
    const fileRef = attr(disk, "fileref");
    if (!id || !fileRef) continue;
    const href = hrefById.get(fileRef);
    if (!href) continue;
    const capacity = Number(attr(disk, "capacity") ?? "");
    const units = unitMultiplier(attr(disk, "capacityallocationunits"));
    diskById.set(id, {
      href,
      capacity: Number.isFinite(capacity) && capacity > 0 ? capacity * units : null,
    });
  }

  const system = findFirst(root, "VirtualSystem");
  const name = textOf(system ?? root, "Name") ?? attr(system, "id") ?? "imported-vm";

  const osSection = findFirst(root, "OperatingSystemSection");
  const profile = detectOs(
    attr(osSection, "ostype"),
    osSection ? textOf(osSection, "Description") : undefined,
    osSection?.text,
    textOf(root, "Product"),
    name
  );

  let cores = 0;
  let memoryMb = 0;
  let nicModel = "";
  let scsiSubType = "";
  const attachedDisks: DiskSpec[] = [];

  for (const item of findAll(root, "Item")) {
    const type = Number(textOf(item, "ResourceType") ?? "");
    const quantity = Number(textOf(item, "VirtualQuantity") ?? "");
    const subType = textOf(item, "ResourceSubType") ?? "";

    if (type === 3 && quantity > 0) {
      cores = quantity;
    } else if (type === 4 && quantity > 0) {
      const bytes = quantity * unitMultiplier(textOf(item, "AllocationUnits"));
      memoryMb = Math.round(bytes / (1024 * 1024));
    } else if (type === 10) {
      nicModel = subType;
    } else if (type === 6) {
      scsiSubType = subType;
    } else if (type === 17) {
      // HostResource points back into DiskSection: "ovf:/disk/vmdisk1".
      const host = textOf(item, "HostResource") ?? "";
      const diskId = host.split("/").pop() ?? "";
      const disk = diskById.get(diskId);
      if (disk) {
        const slot = Number(textOf(item, "AddressOnParent") ?? "");
        attachedDisks.push({
          file: disk.href,
          capacityBytes: disk.capacity,
          slot: Number.isFinite(slot) ? slot : attachedDisks.length,
        });
      }
    }
  }

  // Some exporters omit the disk Items entirely and only fill DiskSection.
  const disks: DiskSpec[] =
    attachedDisks.length > 0
      ? attachedDisks
      : Array.from(diskById.values()).map((d, i) => ({
          file: d.href,
          capacityBytes: d.capacity,
          slot: i,
        }));

  const firmware = findAll(root, "Config").some(
    (c) => (attr(c, "key") ?? "").toLowerCase() === "firmware" && /efi/i.test(attr(c, "value") ?? "")
  )
    ? "ovmf"
    : "seabios";

  if (cores === 0) warnings.push("OVF did not declare a CPU count; defaulted to 2 cores.");
  if (memoryMb === 0) warnings.push("OVF did not declare memory; defaulted from the detected OS.");

  return {
    name: sanitizeName(name),
    ostype: profile.ostype,
    osLabel: profile.label,
    family: profile.family,
    icon: profile.icon,
    protocol: profile.protocol,
    port: profile.port,
    defaultUsername: profile.defaultUsername,
    cores: cores || 2,
    memoryMb: memoryMb || minimumMemoryMb(profile.family),
    firmware,
    scsihw: mapScsiHw(scsiSubType),
    nicModel: mapNicModel(nicModel, profile.family),
    disks: resolveDisks(disks, files, warnings),
    source: "ovf",
  };
}

// ---------------------------------------------------------------------------
// VMX
// ---------------------------------------------------------------------------

function parseVmx(text: string, files: BundleFile[], warnings: string[]): GuestSpec {
  const config = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([\w.:]+)\s*=\s*"?([^"]*)"?\s*$/.exec(line);
    if (match) config.set(match[1].toLowerCase(), match[2].trim());
  }

  const profile = detectOs(config.get("guestos"), config.get("displayname"));
  const cores = Number(config.get("numvcpus") ?? "") || 0;
  const memoryMb = Number(config.get("memsize") ?? "") || 0;

  // Disk backings are spread across `<bus><n>:<unit>.fileName` keys. A key only
  // counts if its device isn't explicitly absent and isn't a CD-ROM backing.
  const disks: DiskSpec[] = [];
  const busOrder: Record<string, number> = { nvme: 0, scsi: 1, sata: 2, ide: 3 };
  for (const [key, value] of config) {
    const match = /^(nvme|scsi|sata|ide)(\d+):(\d+)\.filename$/.exec(key);
    if (!match) continue;
    const device = `${match[1]}${match[2]}:${match[3]}`;
    if ((config.get(`${device}.present`) ?? "true").toLowerCase() === "false") continue;
    const deviceType = (config.get(`${device}.devicetype`) ?? "").toLowerCase();
    if (deviceType.includes("cdrom") || /\.iso$/i.test(value)) continue;
    if (!value || /^(auto detect|emptybackingstring)$/i.test(value)) continue;

    disks.push({
      file: value.replace(/\\/g, "/"),
      capacityBytes: null,
      slot: (busOrder[match[1]] ?? 9) * 1000 + Number(match[2]) * 16 + Number(match[3]),
    });
  }
  disks.sort((a, b) => a.slot - b.slot);

  if (cores === 0) warnings.push("VMX did not declare numvcpus; defaulted to 2 cores.");
  if (memoryMb === 0) warnings.push("VMX did not declare memSize; defaulted from the detected OS.");

  return {
    name: sanitizeName(config.get("displayname") ?? "imported-vm"),
    ostype: profile.ostype,
    osLabel: profile.label,
    family: profile.family,
    icon: profile.icon,
    protocol: profile.protocol,
    port: profile.port,
    defaultUsername: profile.defaultUsername,
    cores: cores || 2,
    memoryMb: memoryMb || minimumMemoryMb(profile.family),
    firmware: (config.get("firmware") ?? "").toLowerCase() === "efi" ? "ovmf" : "seabios",
    scsihw: mapScsiHw(config.get("scsi0.virtualdev") ?? ""),
    nicModel: mapNicModel(config.get("ethernet0.virtualdev") ?? "", profile.family),
    disks: resolveDisks(disks, files, warnings),
    source: "vmx",
  };
}

// ---------------------------------------------------------------------------
// No descriptor at all
// ---------------------------------------------------------------------------

function heuristicSpec(files: BundleFile[], originalName: string, _warnings: string[]): GuestSpec {
  const diskFiles = files.filter((f) => f.role === "disk");
  const profile = detectOs(originalName, ...files.map((f) => f.name));

  return {
    name: sanitizeName(path.basename(originalName).replace(/\.(zip|ova|ovf|vmdk|qcow2|raw|img)$/i, "")),
    ostype: profile.ostype,
    osLabel: profile.label,
    family: profile.family,
    icon: profile.icon,
    protocol: profile.protocol,
    port: profile.port,
    defaultUsername: profile.defaultUsername,
    cores: 2,
    memoryMb: minimumMemoryMb(profile.family),
    firmware: "seabios",
    scsihw: "virtio-scsi-single",
    nicModel: profile.family === "windows" ? "e1000" : "virtio",
    disks: diskFiles.map((f, i) => ({ file: f.name, capacityBytes: null, slot: i })),
    source: "heuristic",
  };
}

// ---------------------------------------------------------------------------
// Cross-checking the descriptor against what's really in the archive
// ---------------------------------------------------------------------------

/**
 * Descriptors reference disks by their own path conventions, which rarely match
 * the archive's layout byte for byte. Match on basename, and drop references to
 * files that simply aren't here.
 */
function resolveDisks(disks: DiskSpec[], files: BundleFile[], warnings: string[]): DiskSpec[] {
  const byBase = new Map<string, BundleFile>();
  for (const file of files) {
    if (file.role === "disk" || file.role === "disk-extent") {
      byBase.set(path.posix.basename(file.name).toLowerCase(), file);
    }
  }

  const resolved: DiskSpec[] = [];
  for (const disk of disks) {
    const base = path.posix.basename(disk.file.replace(/\\/g, "/")).toLowerCase();
    const match = byBase.get(base);
    if (!match) {
      warnings.push(`Descriptor references "${disk.file}", which is not in the bundle. Skipping that disk.`);
      continue;
    }
    if (match.role === "disk-extent") {
      warnings.push(`"${match.flatName}" looks like a split-disk extent; importing its descriptor instead.`);
      continue;
    }
    resolved.push({ ...disk, file: match.name });
  }

  if (resolved.length === 0) {
    // Better to import every candidate disk than to fail outright over a
    // descriptor whose paths we couldn't line up.
    const fallback = files.filter((f) => f.role === "disk");
    if (fallback.length > 0) {
      warnings.push("Could not match the descriptor's disks to the archive; using every disk image found instead.");
      return fallback.map((f, i) => ({ file: f.name, capacityBytes: null, slot: i }));
    }
    throw new Error("No disk images found in the bundle — nothing to import.");
  }

  return resolved.sort((a, b) => a.slot - b.slot);
}

/** Fill in provisioned sizes by peeking at each disk's own header. */
async function fillDiskCapacities(
  filePath: string,
  kind: ArchiveKind,
  entries: ArchiveEntry[],
  files: BundleFile[],
  spec: GuestSpec
): Promise<void> {
  for (const disk of spec.disks) {
    if (disk.capacityBytes) continue;
    const file = files.find((f) => f.name === disk.file);
    const entry = file && entries.find((e) => e.name === file.name);
    if (!entry) continue;
    try {
      const head = await readEntryHead(filePath, kind, entry, 2048);
      disk.capacityBytes = readImageCapacity(head);
    } catch {
      // A capacity we can't read is cosmetic — the import still works.
    }
  }
}

/**
 * Provisioned size straight out of a disk image header. Covers the VMDK sparse
 * header, the VMDK text descriptor used by split disks, and qcow2.
 */
export function readImageCapacity(head: Buffer): number | null {
  if (head.length >= 20 && head.subarray(0, 4).toString("latin1") === "KDMV") {
    return Number(head.readBigUInt64LE(12)) * 512;
  }
  if (head.length >= 32 && head.subarray(0, 4).toString("latin1") === "QFI\xfb") {
    return Number(head.readBigUInt64BE(24));
  }
  const text = head.toString("latin1");
  if (text.includes("# Disk DescriptorFile")) {
    let sectors = 0;
    for (const m of text.matchAll(/^\s*RW\s+(\d+)\s/gim)) sectors += Number(m[1]);
    if (sectors > 0) return sectors * 512;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Last pass over a parsed spec: clamp the silly values, and pick device models
 * the guest can actually boot from.
 */
function finalize(spec: GuestSpec, files: BundleFile[], warnings: string[]): void {
  spec.cores = clamp(Math.round(spec.cores), 1, 64);
  spec.memoryMb = clamp(Math.round(spec.memoryMb), 512, 262_144);

  const floor = minimumMemoryMb(spec.family);
  if (spec.memoryMb < floor) {
    warnings.push(`Raised memory to ${floor} MB — ${spec.osLabel} is unusable below that over a remote console.`);
    spec.memoryMb = floor;
  }

  if (files.some((f) => f.role === "nvram") && spec.firmware === "seabios") {
    warnings.push("Bundle contains an .nvram file, which usually means UEFI. Switched firmware to OVMF (UEFI).");
    spec.firmware = "ovmf";
  }
}

function sanitizeName(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || "imported-vm";
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * OVF sizes carry their own units, most often the literal string
 * "byte * 2^20". Anything unrecognised is treated as plain bytes.
 */
function unitMultiplier(units: string | undefined): number {
  if (!units) return 1;
  const power = /byte\s*\*\s*2\s*\^\s*(\d+)/i.exec(units);
  if (power) return 2 ** Number(power[1]);
  if (/^kilobytes?$|^kb$/i.test(units)) return 1024;
  if (/^megabytes?$|^mb$/i.test(units)) return 1024 ** 2;
  if (/^gigabytes?$|^gb$/i.test(units)) return 1024 ** 3;
  return 1;
}

/** VMware controller names → Proxmox `scsihw` values. */
function mapScsiHw(subType: string): string {
  const value = subType.toLowerCase();
  if (value.includes("lsilogicsas") || value.includes("sas")) return "megasas";
  if (value.includes("lsilogic") || value.includes("buslogic")) return "lsi";
  if (value.includes("pvscsi") || value.includes("virtualscsi")) return "pvscsi";
  return "virtio-scsi-single";
}

/**
 * VMware NIC names → Proxmox `net0` models. Windows images keep e1000 because
 * an imported guest has no VirtIO driver yet and would come up with no network
 * at all; Linux gets virtio, which its kernel has had for years.
 */
function mapNicModel(subType: string, family: GuestSpec["family"]): string {
  const value = subType.toLowerCase();
  if (value.includes("vmxnet3")) return "vmxnet3";
  if (value.includes("e1000e")) return "e1000e";
  if (value.includes("e1000")) return "e1000";
  return family === "windows" ? "e1000" : "virtio";
}

/** Exported for the OVF generator, which needs the same node-walking helpers. */
export type { XmlNode };
