/**
 * Shared shapes for the VM import pipeline. The frontend mirrors these in
 * `frontend/src/api.ts`, so keep the two in step.
 */
import type { OsFamily, TileIcon } from "./guestOs";

/** What a file inside the uploaded bundle turned out to be. */
export type BundleFileRole = "ovf" | "vmx" | "disk" | "disk-extent" | "nvram" | "manifest" | "iso" | "other";

export interface BundleFile {
  name: string;
  /** Flat name we'll use when repackaging (basename, de-duplicated). */
  flatName: string;
  size: number;
  role: BundleFileRole;
}

export interface DiskSpec {
  /** Bundle file name of the disk's descriptor (not its extents). */
  file: string;
  /** Provisioned size, if the source told us. */
  capacityBytes: number | null;
  /** Bus ordering from the source: scsi0:1 sorts after scsi0:0. */
  slot: number;
}

/** Everything we managed to learn about the guest from the bundle. */
export interface GuestSpec {
  name: string;
  ostype: string;
  osLabel: string;
  family: OsFamily;
  icon: TileIcon;
  protocol: "rdp" | "vnc";
  port: number;
  defaultUsername: string;
  cores: number;
  memoryMb: number;
  firmware: "seabios" | "ovmf";
  scsihw: string;
  nicModel: string;
  disks: DiskSpec[];
  /** Which descriptor the numbers came from. */
  source: "ovf" | "vmx" | "heuristic";
}

export interface BundleInspection {
  container: "zip" | "ova" | "raw";
  files: BundleFile[];
  spec: GuestSpec;
  totalDiskBytes: number;
  warnings: string[];
}

/** The `import` strategy chosen for a job. */
export type ImportStrategy = "ova" | "disk";

export type ImportStatus =
  | "inspecting"
  | "ready"
  | "queued"
  | "running"
  /** VM exists and is stopped; waiting for the admin to prepare the guest. */
  | "awaiting_prep"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ImportStage =
  | "upload"
  | "inspect"
  | "package"
  | "transfer"
  | "create"
  | "configure"
  | "prep"
  | "template"
  | "register"
  | "done";

export const IMPORT_STAGES: ImportStage[] = [
  "upload",
  "inspect",
  "package",
  "transfer",
  "create",
  "configure",
  "prep",
  "template",
  "register",
  "done",
];

/** Disk bus for the imported disks. "auto" picks per guest OS — see chooseBus(). */
export type ImportBus = "auto" | "sata" | "scsi" | "ide" | "virtio";

/** Admin-supplied settings that turn an inspection into a real import. */
export interface ImportSettings {
  templateId: string;
  templateName: string;
  description: string;
  icon: TileIcon;
  node: string;
  /** Storage that receives the converted disks. */
  storage: string;
  /** Storage with `import` content enabled, used as the landing zone. */
  importStorage: string;
  bridge: string;
  vlanTag: number | null;
  vmid: number;
  cores: number;
  memoryMb: number;
  ostype: string;
  firmware: "seabios" | "ovmf";
  protocol: "rdp" | "vnc";
  port: number;
  username: string;
  password: string;
  stagingPoolSize: number;
  strategy: ImportStrategy;
  /** Which bus the disks are attached to. Windows defaults to SATA. */
  busType: ImportBus;
  /** Add a virtual TPM — Windows 11 expects one. */
  addTpm: boolean;
  /** Volid of a virtio-win driver ISO to mount on ide2, if one is available. */
  virtioIso: string | null;
  /** Leave the landing-zone copy in place after a successful import. */
  keepUpload: boolean;
  /** Register a dashboard tile once the template exists. */
  registerTemplate: boolean;
  /** Boot the VM once the disks land, so the admin can prepare the guest. */
  startAfterImport: boolean;
}
