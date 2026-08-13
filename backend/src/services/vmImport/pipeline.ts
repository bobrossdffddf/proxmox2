/**
 * The import pipeline: uploaded bundle in, Proxmox template out.
 *
 *   package  → flatten the archive into a single OVA (writing an OVF descriptor
 *              first if the bundle didn't ship one)
 *   transfer → stream that OVA into a storage with the `import` content type
 *   create   → create the VM, letting Proxmox convert the disks in place via
 *              `import-from`
 *   prep     → stop and hand back to the admin: a VMware guest has no QEMU
 *              guest agent, and without one the range can never learn its IP
 *   template → convert to a template and publish the dashboard tile
 *
 * The pause before `template` is deliberate and is the one step that can't be
 * automated away — see finalizeImport().
 *
 * Requires Proxmox VE 8.2+, which is where storage-level `import` content and
 * `qm create --scsiN …,import-from=…` landed. probeNode() checks for that up
 * front so the wizard can say so plainly instead of failing halfway through.
 */
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { env, getNodes, getTemplates } from "../../config";
import { logger } from "../logger";
import { proxmox, ProxmoxStorage } from "../proxmox";
import { upsertImportedTemplate } from "../importedTemplates";
import { ensureAllStagedVms } from "../stagingMaintainer";
import { audit } from "../audit";
import {
  bufferSource,
  detectArchiveKind,
  listEntries,
  openEntry,
  readEntry,
  tarSize,
  tarStream,
  ArchiveEntry,
  ArchiveKind,
  STREAM_CHUNK,
  TarInput,
} from "../archive";
import { registerPullArtifact, releasePullArtifact } from "./artifactServer";
import { buildOvf, rewriteOvfHrefs } from "./ovfBuilder";
import * as store from "./store";
import type { BundleFile, BundleInspection, ImportSettings, ImportStage } from "./types";

/**
 * Run a promise we deliberately don't await — progress writes, best-effort
 * cleanup — without letting a rejection reach the process. An unhandled
 * rejection terminates Node, and losing the whole backend because a progress
 * row failed to update would be absurd.
 */
function detach(promise: Promise<unknown>): void {
  promise.catch((err) => logger.warn({ err: String(err) }, "background import task failed"));
}

/** Per-bus device limits in Proxmox. */
const BUS_LIMITS: Record<string, number> = { sata: 6, scsi: 31, ide: 4, virtio: 16 };

export interface NodeCapabilities {
  node: string;
  /** Host and port from nodes.yaml, so the UI can link to the Proxmox console. */
  host: string;
  port: number;
  reachable: boolean;
  version: string | null;
  /** PVE 8.2+, where storage `import` content and `import-from` arrived. */
  supportsApiImport: boolean;
  /** Storages that can hold an uploaded OVA. */
  importStorages: ProxmoxStorage[];
  /** Storages that can hold the converted VM disks. */
  imageStorages: ProxmoxStorage[];
  /** ISO volumes that look like virtio-win driver discs. */
  virtioIsos: string[];
  bridges: string[];
  /** Human-readable reasons the API path is unavailable, if it is. */
  blockers: string[];
}

/**
 * What a node can do for us. The wizard calls this before showing its form so
 * it can preselect sane targets — and refuse early, with a reason, rather than
 * uploading 40 GB and then discovering the cluster is too old.
 */
export async function probeNode(node: string): Promise<NodeCapabilities> {
  const configured = getNodes().find((n) => n.name === node);
  const result: NodeCapabilities = {
    node,
    host: configured?.host ?? node,
    port: configured?.port ?? 8006,
    reachable: false,
    version: null,
    supportsApiImport: false,
    importStorages: [],
    imageStorages: [],
    virtioIsos: [],
    bridges: [],
    blockers: [],
  };

  try {
    const version = await proxmox.getVersion(node);
    result.reachable = true;
    result.version = version.version;

    const [major, minor] = version.version.split(".").map((n) => parseInt(n, 10));
    const modernEnough = major > 8 || (major === 8 && minor >= 2);
    if (!modernEnough) {
      result.blockers.push(
        `Proxmox ${version.version} predates the storage import API (needs 8.2 or newer). ` +
          `Use the generated commands below over SSH instead.`
      );
    }

    const storages = await proxmox.listStorages(node);
    result.importStorages = storages.filter((s) => s.active && s.content.includes("import"));
    result.imageStorages = storages.filter((s) => s.active && s.content.includes("images"));

    if (result.importStorages.length === 0) {
      result.blockers.push(
        `No storage on ${node} has the "import" content type enabled. ` +
          `Add it under Datacenter → Storage (the "local" directory storage is the usual choice).`
      );
    }
    if (result.imageStorages.length === 0) {
      result.blockers.push(`No storage on ${node} accepts disk images.`);
    }

    result.supportsApiImport = modernEnough && result.blockers.length === 0;

    result.bridges = await proxmox.listBridges(node).catch(() => []);
    if (result.bridges.length === 0) result.bridges = ["vmbr0"];

    // Windows guests need VirtIO drivers before they'll boot from a virtio
    // disk or see a virtio NIC, so surface any driver ISO already on the node.
    for (const storage of storages.filter((s) => s.active && s.content.includes("iso"))) {
      const volumes = await proxmox.listStorageContent(node, storage.storage, "iso").catch(() => []);
      for (const volume of volumes) {
        if (/virtio[-_]?win.*\.iso$/i.test(volume.volid)) result.virtioIsos.push(volume.volid);
      }
    }
  } catch (err) {
    result.blockers.push(`Node ${node} is not reachable: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

/**
 * Commands equivalent to what the pipeline would do over the API — shown when
 * a cluster is too old for the automated path, so the admin still gets exact,
 * bundle-specific steps rather than a generic template to fill in.
 */
export function manualCommands(settings: ImportSettings, inspection: BundleInspection, uploadName: string): string[] {
  const bus = chooseBus(settings, inspection);
  const disks = importableDisks(inspection);
  const dir = `/var/lib/vz/import/${settings.templateId}`;

  const lines = [
    `mkdir -p ${dir}`,
    `# copy ${uploadName} to ${dir} on node ${settings.node}, then:`,
    inspection.container === "zip" ? `unzip -j ${dir}/${uploadName} -d ${dir}` : `tar -xvf ${dir}/${uploadName} -C ${dir}`,
    `qm create ${settings.vmid} --name ${settings.templateId} --memory ${settings.memoryMb} ` +
      `--cores ${settings.cores} --ostype ${settings.ostype} --bios ${settings.firmware} ` +
      `--scsihw virtio-scsi-single --net0 ${inspection.spec.nicModel},bridge=${settings.bridge}`,
  ];

  disks.forEach((disk, i) => {
    lines.push(
      `qm set ${settings.vmid} --${bus}${i} ${settings.storage}:0,import-from=${dir}/${path.posix.basename(disk.flatName)}`
    );
  });

  lines.push(
    `qm set ${settings.vmid} --boot order=${bus}0 --agent enabled=1`,
    `# boot the VM, install the QEMU guest agent and enable ${settings.protocol.toUpperCase()}, then shut down`,
    `qm template ${settings.vmid}`
  );
  return lines;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** Small helper so each step can log, set progress, and check for cancellation. */
class Run {
  constructor(readonly importId: number, readonly startedAt = Date.now()) {}

  async say(message: string, level: "info" | "warn" | "error" = "info"): Promise<void> {
    // Log to stdout *first* and at the matching level. The import log lives in
    // Postgres, which shares a disk with the staging area — so the one failure
    // most likely to need explaining is also the one most likely to stop the
    // explanation being written. docker logs still gets it.
    logger[level]({ importId: this.importId }, message);
    await store.appendLog(this.importId, level, message).catch((err) => {
      logger.error({ importId: this.importId, err: String(err) }, "could not write to the import log");
    });
  }

  async stage(stage: ImportStage, progress: number, message: string): Promise<void> {
    await store.setStage(this.importId, stage, progress);
    await this.say(message);
  }

  /** Throws if an admin cancelled the job while we were busy. */
  async assertNotCancelled(): Promise<void> {
    const row = await store.getImport(this.importId);
    if (row?.status === "cancelled") throw new CancelledError();
  }
}

class CancelledError extends Error {
  constructor() {
    super("Import cancelled by an administrator");
  }
}

/**
 * Run everything up to (but not including) templating. Ends with the VM created
 * and stopped, waiting for guest prep.
 */
export async function runImport(importId: number): Promise<void> {
  const run = new Run(importId);
  const row = await store.getImport(importId);
  if (!row) throw new Error(`Import ${importId} not found`);
  if (!row.settings || !row.inspection || !row.upload_path) {
    throw new Error("Import is missing its upload, inspection or settings");
  }

  const settings = row.settings;
  const inspection = row.inspection;
  let createdVmid: number | null = null;
  const uploadedVolids: string[] = [];

  try {
    // -- package ------------------------------------------------------------
    await run.stage("package", 2, `Packaging ${row.original_filename} for import`);
    const artifacts = await packageBundle(run, row.upload_path, inspection, settings);
    await run.assertNotCancelled();

    // -- transfer -----------------------------------------------------------
    await run.stage("transfer", 10, `Uploading to ${settings.importStorage} on ${settings.node}`);
    await assertRoomOnNode(run, settings, artifacts.reduce((sum, a) => sum + a.bytes, 0));
    for (const [index, artifact] of artifacts.entries()) {
      const volid = await transferArtifact(run, settings, artifact, index, artifacts.length);
      uploadedVolids.push(volid);
    }
    await run.assertNotCancelled();

    // -- create -------------------------------------------------------------
    await run.stage("create", 55, "Creating the VM and converting its disks");
    const created = await createVm(run, settings, inspection, artifacts, uploadedVolids);
    createdVmid = created.vmid;
    await run.assertNotCancelled();

    // -- configure ----------------------------------------------------------
    await run.stage("configure", 88, "Applying final VM options");
    await configureVm(run, settings, created.vmid);

    // Landing-zone copies are pure overhead once the disks are converted.
    if (!settings.keepUpload) {
      for (const volid of uploadedVolids) {
        await proxmox.deleteVolume(settings.node, volid).catch((err) => {
          detach(run.say(`Could not remove the uploaded copy ${volid}: ${err}`, "warn"));
        });
      }
      await fs.promises.rm(row.upload_path, { force: true }).catch(() => undefined);
    }

    // setStage forces status back to 'running', so the status update goes last.
    await store.setStage(importId, "prep", 90);
    await store.setStatus(importId, "awaiting_prep");

    await run.say(
      `VM ${created.vmid} created on ${settings.node}. Boot it, install the QEMU guest agent, ` +
        `enable ${settings.protocol.toUpperCase()}, shut it down, then finish the import.`
    );
    await audit({
      action: "admin.import_vm_created",
      details: { importId, vmid: created.vmid, node: settings.node, file: row.original_filename },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (err instanceof CancelledError) {
      await run.say(message, "warn");
    } else {
      await run.say(message, "error");
      await store.markFailed(importId, message);
    }

    // A half-created VM is worse than none: it holds a VMID and its disks.
    if (createdVmid !== null) {
      await run.say(`Removing the partially created VM ${createdVmid}`, "warn");
      await proxmox
        .deleteVM(settings.node, createdVmid)
        .then((upid) => proxmox.waitForTask(settings.node, upid, 300_000))
        .catch((cleanupErr) => detach(run.say(`Could not remove VM ${createdVmid}: ${cleanupErr}`, "warn")));
    }
    for (const volid of uploadedVolids) {
      await proxmox.deleteVolume(settings.node, volid).catch(() => undefined);
    }
    throw err;
  }
}

/**
 * Second half, run once the admin says the guest is ready: convert to a
 * template and publish the tile.
 */
export async function finalizeImport(importId: number): Promise<{ templateId: string | null; vmid: number }> {
  const run = new Run(importId);
  const row = await store.getImport(importId);
  if (!row?.settings) throw new Error("Import is missing its settings");
  const settings = row.settings;
  const vmid = settings.vmid;

  try {
    const status = await proxmox.getVmStatus(settings.node, vmid);
    if (status === "running") {
      await run.say("VM is still running — shutting it down before templating");
      const upid = await proxmox.powerOff(settings.node, vmid, false);
      await proxmox.waitForTask(settings.node, upid, 180_000).catch(() => undefined);
    }

    await run.stage("template", 94, `Converting VM ${vmid} to a Proxmox template`);
    await proxmox.convertToTemplate(settings.node, vmid);

    let templateId: string | null = null;
    if (settings.registerTemplate) {
      await run.stage("register", 98, `Publishing the "${settings.templateName}" tile`);
      await upsertImportedTemplate({
        id: settings.templateId,
        name: settings.templateName,
        description: settings.description,
        icon: settings.icon,
        proxmoxTemplateId: vmid,
        proxmoxTemplateIds: { [settings.node]: vmid },
        protocol: settings.protocol,
        port: settings.port,
        username: settings.username,
        password: settings.password,
        cpuCores: settings.cores,
        memoryMb: settings.memoryMb,
        stagingPoolSize: settings.stagingPoolSize,
        sourceImportId: importId,
      });
      templateId = settings.templateId;

      if (settings.stagingPoolSize > 0) {
        await run.say(`Warming ${settings.stagingPoolSize} staged VM(s) for the new template`);
        await ensureAllStagedVms().catch((err) => {
          detach(run.say(`Staging could not start yet: ${err}`, "warn"));
        });
      }
    }

    await store.markSucceeded(importId, {
      vmid,
      node: settings.node,
      templateId,
      storage: settings.storage,
      disks: [],
      durationMs: Date.now() - new Date(row.created_at).getTime(),
    });
    await run.say(`Import complete. Template ${vmid} is ready.`);
    await audit({
      action: "admin.import_vm_finalized",
      details: { importId, vmid, node: settings.node, templateId },
    });

    return { templateId, vmid };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await run.say(message, "error");
    await store.markFailed(importId, message);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Stage: package
// ---------------------------------------------------------------------------

/**
 * Something to be uploaded, described rather than materialised.
 *
 * Nothing is written to scratch disk: `open()` produces the bytes on demand,
 * pulled out of the uploaded archive as the HTTP upload consumes them. An
 * earlier version extracted every disk and then built the OVA beside them,
 * which needed roughly 2.5× the payload in free space and ran out silently.
 */
interface Artifact {
  /** Name it will have in the Proxmox import storage. */
  filename: string;
  bytes: number;
  open: () => Readable | Promise<Readable>;
  /** True for the artifact the VM is created from. */
  primary: boolean;
}

async function packageBundle(
  run: Run,
  uploadPath: string,
  inspection: BundleInspection,
  settings: ImportSettings
): Promise<Artifact[]> {
  // A bare image needs no repackaging — it goes to the import storage as-is.
  if (inspection.container === "raw") {
    const { size } = await fs.promises.stat(uploadPath);
    const filename = safeFilename(inspection.files[0]?.flatName ?? "disk.img", settings.vmid);
    await run.say(`Uploading the disk image directly (${formatBytes(size)})`);
    return [
      {
        filename,
        bytes: size,
        open: () => fs.createReadStream(uploadPath, { highWaterMark: STREAM_CHUNK }),
        primary: true,
      },
    ];
  }

  const kind = (await detectArchiveKind(uploadPath)) as ArchiveKind;
  const entries = await listEntries(uploadPath, kind);
  const entryByName = new Map(entries.map((e) => [e.name, e]));

  const disks = inspection.files.filter((f) => f.role === "disk" || f.role === "disk-extent");
  if (disks.length === 0) throw new Error("No disk images in the bundle");

  const entryFor = (file: BundleFile): ArchiveEntry => {
    const entry = entryByName.get(file.name);
    if (!entry) throw new Error(`Archive entry missing for ${file.name}`);
    return entry;
  };

  if (settings.strategy === "disk") {
    // Upload each disk file on its own, straight out of the archive. Split
    // disks need their extents beside the descriptor for qemu-img to follow.
    return disks.map((file) => ({
      filename: file.flatName,
      bytes: file.size,
      open: () => openEntry(uploadPath, kind, entryFor(file)),
      primary: file.role === "disk",
    }));
  }

  // Strategy "ova": one tar of the descriptor plus every disk file, assembled
  // as it's uploaded.
  const ovfFile = inspection.files.find((f) => f.role === "ovf");
  const ovfName = ovfFile ? ovfFile.flatName : `${sanitizeStem(inspection.spec.name)}.ovf`;
  let ovfXml: string;

  if (ovfFile) {
    const original = (await readEntry(uploadPath, kind, entryFor(ovfFile), 4 * 1024 * 1024)).toString("utf8");
    const { xml, rewritten } = rewriteOvfHrefs(original, inspection.files);
    ovfXml = xml;
    if (rewritten.length > 0) {
      await run.say(`Rewrote ${rewritten.length} disk reference(s) in the OVF: ${rewritten.join(", ")}`);
    }
  } else {
    // No descriptor in the bundle — write one from what the VMX told us.
    const primaryDisks = inspection.files.filter((f) => f.role === "disk");
    ovfXml = buildOvf(
      inspection.spec,
      primaryDisks.map((f) => ({
        flatName: f.flatName,
        size: f.size,
        capacityBytes: inspection.spec.disks.find((d) => d.file === f.name)?.capacityBytes ?? null,
      }))
    );
    await run.say(`Generated an OVF descriptor for ${primaryDisks.length} disk(s) (the bundle had none)`);
  }

  const members: TarInput[] = [
    bufferSource(ovfName, Buffer.from(ovfXml, "utf8")),
    ...disks.map((file) => ({
      name: file.flatName,
      size: file.size,
      open: () => openEntry(uploadPath, kind, entryFor(file)),
    })),
  ];

  const ovaName = safeFilename(`wcta-import-${settings.vmid}.ova`, settings.vmid);
  const bytes = tarSize(members);
  await run.say(
    `Assembling ${ovaName} from ${members.length} file(s) — ${formatBytes(bytes)}, streamed directly to ${settings.node}`
  );

  return [{ filename: ovaName, bytes, open: () => tarStream(members), primary: true }];
}

// ---------------------------------------------------------------------------
// Stage: transfer
// ---------------------------------------------------------------------------

/**
 * Free space on the node's landing storage, checked before a byte is sent.
 *
 * Discovering there's no room 7 GB into a 10 GB upload costs twenty minutes and
 * reports itself as `write EPIPE`, which explains nothing.
 */
async function assertRoomOnNode(run: Run, settings: ImportSettings, totalBytes: number): Promise<void> {
  const storages = await proxmox.listStorages(settings.node).catch(() => []);
  const target = storages.find((s) => s.storage === settings.importStorage);

  if (!target || target.avail === null) {
    await run.say(`Could not read free space on ${settings.importStorage}; continuing anyway`, "warn");
    return;
  }

  await run.say(
    `${settings.importStorage} on ${settings.node} reports ${formatBytes(target.avail)} free; ` +
      `this transfer needs ${formatBytes(totalBytes)}`
  );

  if (target.avail < totalBytes * 1.02) {
    throw new Error(
      `Not enough room on ${settings.importStorage} (${settings.node}): ${formatBytes(target.avail)} free, ` +
        `and the image needs ${formatBytes(totalBytes)}. Free space on that storage, or pick a different ` +
        `landing storage in the import plan.`
    );
  }
}

/**
 * Where a Proxmox node should come to fetch an artifact from us.
 *
 * The backend runs in a container, so its own socket address is a Docker
 * bridge IP the node can't route to. PUBLIC_URL is the address the outside
 * world already uses for this machine, so its host plus the published backend
 * port is the reliable derivation — and IMPORT_PULL_URL_BASE overrides it for
 * anything unusual.
 */
function pullBaseUrl(): string | null {
  if (env.IMPORT_PULL_URL_BASE) return env.IMPORT_PULL_URL_BASE.replace(/\/+$/, "");
  try {
    const host = new URL(env.PUBLIC_URL).hostname;
    if (!host || host === "localhost" || host === "127.0.0.1") return null;
    return `http://${host}:${env.BACKEND_PORT}`;
  } catch {
    return null;
  }
}

/**
 * Have the node fetch the image from us instead of pushing it into pveproxy.
 *
 * pveproxy stages an upload in a temporary file before moving it into the
 * storage, and that staging area is often far smaller than a VM image — on
 * many installs it's a tmpfs sized from RAM. A push then dies partway with
 * nothing but EPIPE. `download-url` writes straight into the target storage,
 * so nothing is staged and the size ceiling disappears.
 */
async function transferByPull(run: Run, settings: ImportSettings, artifact: Artifact): Promise<string> {
  const base = pullBaseUrl();
  if (!base) {
    throw new Error(
      "Cannot use the pull transfer: no address for this backend that the node could reach. " +
        "Set IMPORT_PULL_URL_BASE (e.g. http://192.168.1.10:3000) in .env and restart the backend."
    );
  }

  const token = registerPullArtifact({
    importId: run.importId,
    filename: artifact.filename,
    size: artifact.bytes,
    open: artifact.open,
  });
  const url = `${base}/api/import-pull/${token}`;

  try {
    await run.say(`Asking ${settings.node} to fetch the image from ${base} instead`);
    const upid = await proxmox.downloadUrlToStorage({
      node: settings.node,
      storage: settings.importStorage,
      content: "import",
      url,
      filename: artifact.filename,
      verifyCertificates: false,
    });

    let lastNote = 0;
    await proxmox.waitForLongTask(settings.node, upid, {
      timeoutMs: env.IMPORT_TASK_TIMEOUT_MINUTES * 60 * 1000,
      pollMs: 10_000,
      onProgress: (elapsed) => {
        const minutes = Math.floor(elapsed / 60_000);
        if (minutes >= lastNote + 2) {
          lastNote = minutes;
          detach(store.appendLog(run.importId, "info", `Node is still downloading… ${minutes} minutes elapsed`));
        }
      },
    });

    await run.say(`${artifact.filename} is on ${settings.importStorage}`);
    return `${settings.importStorage}:import/${artifact.filename}`;
  } finally {
    releasePullArtifact(token);
  }
}

async function transferArtifact(
  run: Run,
  settings: ImportSettings,
  artifact: Artifact,
  index: number,
  artifactCount: number
): Promise<string> {
  let lastLogged = 0;
  let sentBytes = 0;

  let upid: string;
  try {
    upid = await proxmox.uploadToStorage({
      node: settings.node,
      storage: settings.importStorage,
      content: "import",
      source: { size: artifact.bytes, open: artifact.open },
      filename: artifact.filename,
      onProgress: (sent, total) => {
        sentBytes = sent;
        const percent = Math.floor((sent / total) * 100);
        if (percent >= lastLogged + 10) {
          lastLogged = percent;
          // Transfer spans 10–50% of the overall bar, shared between artifacts.
          const share = 40 / artifactCount;
          detach(store.setProgress(run.importId, 10 + index * share + (percent / 100) * share));
          detach(store.appendLog(run.importId, "info", `Uploaded ${percent}% of ${artifact.filename}`));
        }
      },
    });
  } catch (err) {
    const explanation = await explainTransferFailure(err, settings, artifact, sentBytes);

    // A half-sent upload still occupies its full share of the node's disk. Left
    // behind, each retry makes the space problem it was caused by worse.
    const partial = `${settings.importStorage}:import/${artifact.filename}`;
    await proxmox
      .deleteVolume(settings.node, partial)
      .then(() => run.say(`Removed the partial upload ${partial}`, "warn"))
      .catch(() => undefined);

    // A push that dies partway is usually pveproxy's staging area filling up,
    // not the storage. Having the node pull instead skips that staging
    // entirely, so it's worth one automatic attempt before giving up.
    const hungUp = /EPIPE|ECONNRESET|socket hang up|aborted/i.test(
      err instanceof Error ? err.message : String(err)
    );
    if (hungUp && pullBaseUrl()) {
      await run.say(explanation, "warn");
      await run.say("Retrying with the node pulling the image instead of us pushing it");
      try {
        return await transferByPull(run, settings, artifact);
      } catch (pullErr) {
        throw new Error(
          `${explanation}\n\nThe pull transfer also failed: ` +
            `${pullErr instanceof Error ? pullErr.message : String(pullErr)}`
        );
      }
    }

    throw new Error(explanation);
  }

  await proxmox.waitForLongTask(settings.node, upid, { timeoutMs: 60 * 60 * 1000, pollMs: 5000 });
  await run.say(`${artifact.filename} is on ${settings.importStorage}`);
  return `${settings.importStorage}:import/${artifact.filename}`;
}

/**
 * Turn a socket-level upload failure into something actionable.
 *
 * EPIPE/ECONNRESET partway through means the node hung up on us. By far the
 * most common reason is that it ran out of room — and note that Proxmox stages
 * an upload in a temporary file before moving it into the storage, so the
 * *root* filesystem needs the space too, even when the target storage has
 * plenty.
 */
async function explainTransferFailure(
  err: unknown,
  settings: ImportSettings,
  artifact: Artifact,
  sentBytes: number
): Promise<string> {
  const raw = err instanceof Error ? err.message : String(err);
  const hungUp = /EPIPE|ECONNRESET|socket hang up|aborted/i.test(raw);
  if (!hungUp) return raw;

  const progress = `${formatBytes(sentBytes)} of ${formatBytes(artifact.bytes)}`;
  let freeNow = "";
  try {
    const storages = await proxmox.listStorages(settings.node);
    const target = storages.find((s) => s.storage === settings.importStorage);
    if (target?.avail !== null && target?.avail !== undefined) {
      freeNow = ` ${settings.importStorage} now reports ${formatBytes(target.avail)} free.`;
    }
  } catch {
    // The node may be unhappy enough not to answer; the advice below still holds.
  }

  return (
    `${settings.node} closed the connection after ${progress} (${raw}).${freeNow} ` +
    `This almost always means the node ran out of disk while receiving the image. ` +
    `Proxmox writes an upload to a temporary file before moving it into the storage, so check free ` +
    `space on the node's root filesystem as well as on ${settings.importStorage} — run "df -h /" ` +
    `and "df -h /var/lib/vz" on ${settings.node}.`
  );
}

// ---------------------------------------------------------------------------
// Stage: create
// ---------------------------------------------------------------------------

async function createVm(
  run: Run,
  settings: ImportSettings,
  inspection: BundleInspection,
  artifacts: Artifact[],
  volids: string[]
): Promise<{ vmid: number }> {
  const primaryVolid = volids[artifacts.findIndex((a) => a.primary)] ?? volids[0];

  // Proxmox's own OVF parser is the authority on what's inside the OVA, so
  // prefer its answer for the disk volumes and fall back to composing them.
  let diskVolids: string[] = [];
  if (settings.strategy === "ova") {
    try {
      const metadata = await proxmox.getImportMetadata(settings.node, settings.importStorage, primaryVolid);
      diskVolids = Object.keys(metadata.disks ?? {})
        .sort()
        .map((key) => {
          const entry = metadata.disks![key];
          return typeof entry === "string" ? entry : entry.volid;
        })
        .filter(Boolean);
      if (diskVolids.length > 0) {
        await run.say(`Proxmox read ${diskVolids.length} disk(s) from the OVA`);
      }
      for (const warning of metadata.warnings ?? []) {
        const text = typeof warning === "string" ? warning : `${warning.type ?? "warning"} ${warning.key ?? ""} ${warning.value ?? ""}`;
        await run.say(`Proxmox import warning: ${text.trim()}`, "warn");
      }
    } catch (err) {
      await run.say(`Could not read import metadata (${err}); composing disk paths instead`, "warn");
    }

    if (diskVolids.length === 0) {
      diskVolids = importableDisks(inspection).map((f) => `${primaryVolid}/${f.flatName}`);
    }
  } else {
    diskVolids = artifacts.filter((a) => a.primary).map((a) => `${settings.importStorage}:import/${a.filename}`);
  }

  if (diskVolids.length === 0) throw new Error("No importable disks were identified");

  const bus = chooseBus(settings, inspection);
  const limit = BUS_LIMITS[bus] ?? 6;
  const attachable = diskVolids.slice(0, limit);
  if (attachable.length < diskVolids.length) {
    await run.say(
      `Only the first ${limit} disk(s) fit on the ${bus} bus; ${diskVolids.length - limit} were left out`,
      "warn"
    );
  }

  const net = [
    inspection.spec.nicModel,
    `bridge=${settings.bridge}`,
    settings.vlanTag ? `tag=${settings.vlanTag}` : null,
  ]
    .filter(Boolean)
    .join(",");

  const config: Record<string, string | number> = {
    vmid: settings.vmid,
    name: settings.templateId,
    cores: settings.cores,
    sockets: 1,
    memory: settings.memoryMb,
    ostype: settings.ostype,
    bios: settings.firmware,
    scsihw: "virtio-scsi-single",
    net0: net,
    agent: "enabled=1",
    boot: `order=${bus}0`,
    description: importDescription(settings),
    start: 0,
  };

  // UEFI guests need somewhere to keep their variables, and q35 is the chipset
  // Proxmox pairs with OVMF.
  if (settings.firmware === "ovmf") {
    config.machine = "q35";
    // Proxmox sizes the EFI vars disk itself; the 1 is the placeholder its own
    // UI sends. Secure Boot keys are left un-enrolled so an imported guest with
    // an unsigned bootloader still starts.
    config.efidisk0 = `${settings.storage}:1,efitype=4m,pre-enrolled-keys=0`;
  }
  if (settings.addTpm) {
    config.tpmstate0 = `${settings.storage}:1,version=v2`;
  }
  if (settings.virtioIso) {
    // Drivers on ide2 (Proxmox's conventional CD slot) so a Windows guest can
    // install the guest agent without hunting for the ISO.
    config.ide2 = `${settings.virtioIso},media=cdrom`;
  }

  attachable.forEach((volid, i) => {
    config[`${bus}${i}`] = `${settings.storage}:0,import-from=${volid}`;
  });

  await run.say(
    `Creating VM ${settings.vmid}: ${settings.cores} cores, ${settings.memoryMb} MB, ` +
      `${attachable.length} disk(s) on ${bus}, ${settings.firmware === "ovmf" ? "UEFI" : "BIOS"}`
  );

  const upid = await proxmox.createVm(settings.node, config);

  // Disk conversion happens inside this task and is the long pole: an 80 GB
  // Windows image can take well over an hour on spinning storage.
  const timeoutMs = env.IMPORT_TASK_TIMEOUT_MINUTES * 60 * 1000;
  let lastNote = 0;
  await proxmox.waitForLongTask(settings.node, upid, {
    timeoutMs,
    pollMs: 10_000,
    onProgress: (elapsed) => {
      const minutes = Math.floor(elapsed / 60_000);
      if (minutes >= lastNote + 5) {
        lastNote = minutes;
        detach(store.appendLog(run.importId, "info", `Still converting disks… ${minutes} minutes elapsed`));
        detach(store.setProgress(run.importId, Math.min(85, 55 + (elapsed / timeoutMs) * 30)));
      }
    },
  });

  await run.say(`VM ${settings.vmid} created`);
  return { vmid: settings.vmid };
}

async function configureVm(run: Run, settings: ImportSettings, vmid: number): Promise<void> {
  // Best-effort polish. None of it is worth failing a finished import over.
  const extras: Record<string, string | number> = {
    onboot: 0,
    tablet: 1,
  };
  await proxmox.updateVmConfig(settings.node, vmid, extras).catch((err) => {
    detach(run.say(`Could not apply optional VM settings: ${err}`, "warn"));
  });

  if (settings.startAfterImport) {
    await run.say("Starting the VM so you can prepare the guest");
    await proxmox
      .powerOn(settings.node, vmid)
      .then((upid) => proxmox.waitForTask(settings.node, upid, 120_000))
      .catch((err) => detach(run.say(`Could not start the VM: ${err}`, "warn")));
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Which bus to attach the imported disks to.
 *
 * This matters more than it looks. A Windows image straight out of VMware has
 * no VirtIO storage driver, so booting it from virtio-scsi gives an instant
 * INACCESSIBLE_BOOT_DEVICE. SATA is emulated well enough for Windows to boot
 * unmodified, and the admin can switch to virtio later once the drivers are in.
 * Linux has had virtio in-tree for years and gets the faster path immediately.
 */
export function chooseBus(settings: ImportSettings, inspection: BundleInspection): string {
  if (settings.busType && settings.busType !== "auto") return settings.busType;
  return inspection.spec.family === "windows" ? "sata" : "scsi";
}

/** Disk descriptors only — extents ride along inside the package. */
function importableDisks(inspection: BundleInspection): BundleFile[] {
  return inspection.files.filter((f) => f.role === "disk");
}

function importDescription(settings: ImportSettings): string {
  return [
    `Imported by WCTARange on ${new Date().toISOString()}`,
    `Template id: ${settings.templateId}`,
    `Console: ${settings.protocol.toUpperCase()} on port ${settings.port}`,
    "",
    "Before this can serve range sessions the guest needs:",
    "  1. QEMU guest agent installed and running",
    `  2. ${settings.protocol === "rdp" ? "Remote Desktop enabled" : "a VNC server listening"}`,
    `  3. the ${settings.username} account set to the password stored in WCTARange`,
  ].join("\n");
}

/** Proxmox is fussy about upload filenames; keep them boring. */
function safeFilename(name: string, vmid: number): string {
  const cleaned = path.basename(name).replace(/[^A-Za-z0-9._-]/g, "-");
  return cleaned.length > 3 ? cleaned : `import-${vmid}.ova`;
}

function sanitizeStem(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "-") || "vm";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/**
 * A free VMID for an imported template. Deliberately drawn from a range above
 * the clone pool so imports never collide with session VMs.
 */
export async function allocateImportVmid(): Promise<number> {
  const taken = new Set<number>();
  try {
    for (const vm of await proxmox.listClusterVms()) {
      if (vm.vmid) taken.add(vm.vmid);
    }
  } catch {
    // An unreachable cluster is caught properly later; don't block on it here.
  }
  for (const template of getTemplates()) {
    taken.add(template.proxmox_template_id);
    for (const id of Object.values(template.proxmox_template_ids ?? {})) taken.add(id);
  }

  for (let id = env.IMPORT_VMID_RANGE_START; id <= env.IMPORT_VMID_RANGE_END; id++) {
    if (!taken.has(id)) return id;
  }
  throw new Error(
    `No free VMID between ${env.IMPORT_VMID_RANGE_START} and ${env.IMPORT_VMID_RANGE_END} for the imported template`
  );
}
