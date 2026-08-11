/**
 * Admin endpoints for importing a VM from a VMware/OVA bundle.
 *
 * The flow the wizard drives:
 *   POST   /upload            stream the bundle up; get back what's inside it
 *                             plus a fully populated suggested configuration
 *   POST   /:id/start         confirm that configuration; the worker takes over
 *   GET    /:id               poll status and the tail of the log
 *   POST   /:id/finalize      after guest prep: template it and publish the tile
 *
 * Uploads arrive as a raw octet-stream body rather than multipart. There's one
 * file per request and it can be 40 GB, so there's nothing to gain from a
 * multipart parser — this way the request body streams straight to disk.
 */
import fs from "fs";
import path from "path";
import { Router } from "express";
import { z } from "zod";
import { env, getNodes, getTemplates } from "../config";
import { AuthedRequest, requireAdmin, requireAuth } from "../middleware/auth";
import { HttpError } from "../middleware/errorHandler";
import { audit } from "../services/audit";
import { logger } from "../services/logger";
import { inspectBundle } from "../services/vmImport/inspect";
import {
  allocateImportVmid,
  finalizeImport,
  formatBytes,
  manualCommands,
  NodeCapabilities,
  probeNode,
} from "../services/vmImport/pipeline";
import * as store from "../services/vmImport/store";
import type { BundleInspection, ImportSettings } from "../services/vmImport/types";
import { importQueue } from "../jobs/queues";
import {
  deleteImportedTemplate,
  listImportedTemplates,
  setImportedTemplateEnabled,
} from "../services/importedTemplates";

const router = Router();
router.use(requireAuth, requireAdmin);

const UPLOAD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

async function importDir(): Promise<string> {
  await fs.promises.mkdir(env.IMPORT_DIR, { recursive: true });
  return env.IMPORT_DIR;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * What each node can accept, so the wizard can preselect storages and warn
 * about an unsupported cluster before anything is uploaded.
 */
router.get("/capabilities", async (_req, res) => {
  const nodes: NodeCapabilities[] = [];
  for (const node of getNodes()) {
    if (!node.enabled) continue;
    nodes.push(await probeNode(node.name));
  }

  let freeBytes: number | null = null;
  try {
    const stats = await fs.promises.statfs(await importDir());
    freeBytes = Number(stats.bavail) * Number(stats.bsize);
  } catch {
    // statfs is unavailable on some filesystems; the number is advisory only.
  }

  res.json({
    nodes,
    staging: {
      dir: env.IMPORT_DIR,
      freeBytes,
      freeLabel: freeBytes === null ? null : formatBytes(freeBytes),
      maxUploadGb: env.IMPORT_MAX_UPLOAD_GB,
    },
    vmidRange: { start: env.IMPORT_VMID_RANGE_START, end: env.IMPORT_VMID_RANGE_END },
  });
});

// ---------------------------------------------------------------------------
// Upload + inspect
// ---------------------------------------------------------------------------

/**
 * Stream an uploaded bundle to disk, then inspect it.
 *
 * The body is the file itself; the name comes in as `?filename=`. Everything
 * is written before anything is parsed, so a truncated upload fails here rather
 * than halfway through an import.
 */
router.post("/upload", async (req, res) => {
  const filename = String(req.query.filename ?? "").trim();
  if (!UPLOAD_NAME.test(filename)) {
    throw new HttpError(400, "filename must be a plain file name (letters, digits, dot, dash, underscore)");
  }
  if (!/\.(zip|ova|ovf|vmdk|qcow2|raw|img|tar)$/i.test(filename)) {
    throw new HttpError(400, `Unsupported file type "${path.extname(filename)}". Upload a .zip, .ova, or a disk image.`);
  }

  const auth = (req as unknown as AuthedRequest).auth;
  const record = await store.createImport({ originalFilename: filename, createdBy: auth.sub });
  const dest = path.join(await importDir(), `${record.public_id}-${filename}`);

  const maxBytes = env.IMPORT_MAX_UPLOAD_GB * 1024 ** 3;
  let received = 0;
  let aborted: string | null = null;

  try {
    await new Promise<void>((resolve, reject) => {
      const sink = fs.createWriteStream(dest);

      req.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > maxBytes) {
          aborted = `Upload exceeded the ${env.IMPORT_MAX_UPLOAD_GB} GB limit (IMPORT_MAX_UPLOAD_GB)`;
          req.destroy();
        }
      });
      // A dropped connection must not leave a truncated file looking complete.
      req.on("aborted", () => reject(new Error(aborted ?? "Upload aborted by the client")));
      req.on("error", (err) => reject(aborted ? new Error(aborted) : err));
      sink.on("error", reject);
      sink.on("finish", () => resolve());
      req.pipe(sink);
    });

    if (received === 0) throw new HttpError(400, "Upload was empty");

    await store.setUploadResult(record.id, dest, received);
    await store.appendLog(record.id, "info", `Received ${filename} (${formatBytes(received)})`);

    const inspection = await inspectBundle(dest, filename);
    await store.setInspection(record.id, inspection);
    for (const warning of inspection.warnings) {
      await store.appendLog(record.id, "warn", warning);
    }
    await store.appendLog(
      record.id,
      "info",
      `Detected ${inspection.spec.osLabel} — ${inspection.spec.cores} cores, ${inspection.spec.memoryMb} MB, ` +
        `${inspection.spec.disks.length} disk(s) via ${inspection.spec.source}`
    );

    const suggested = await suggestSettings(inspection, filename);
    const fresh = await store.getImport(record.id);

    await audit({
      action: "admin.import_uploaded",
      details: { importId: record.id, filename, bytes: received, os: inspection.spec.osLabel },
      ipAddress: req.ip,
    });

    res.status(201).json({ import: view(fresh!), suggested });
  } catch (err) {
    await fs.promises.rm(dest, { force: true }).catch(() => undefined);
    const message = aborted ?? (err instanceof Error ? err.message : String(err));
    await store.appendLog(record.id, "error", message).catch(() => undefined);
    await store.markFailed(record.id, message).catch(() => undefined);
    logger.warn({ importId: record.id, err: message }, "upload/inspection failed");

    if (err instanceof HttpError) throw err;
    throw new HttpError(400, message);
  }
});

// ---------------------------------------------------------------------------
// Listing and status
// ---------------------------------------------------------------------------

router.get("/", async (_req, res) => {
  const rows = await store.listImports(25);
  res.json(rows.map(view));
});

router.get("/templates", async (_req, res) => {
  const rows = await listImportedTemplates();
  res.json(
    rows.map((row) => ({
      id: row.id,
      name: row.name,
      icon: row.icon,
      protocol: row.protocol,
      proxmoxTemplateId: row.proxmox_template_id,
      cpuCores: row.cpu_cores,
      memoryMb: row.memory_mb,
      stagingPoolSize: row.staging_pool_size,
      enabled: row.enabled,
      createdAt: row.created_at,
    }))
  );
});

router.get("/:publicId", async (req, res) => {
  const record = await mustFind(req.params.publicId);
  const since = Number(req.query.since ?? 0);
  const log = await store.getLog(record.id, Number.isFinite(since) ? since : 0);

  // An import that was uploaded but never started has no stored settings yet.
  // Recompute the suggestion so reopening it from the history list lands on a
  // filled-in form rather than an empty one.
  const suggested =
    !record.settings && record.inspection && record.status === "ready"
      ? await suggestSettings(record.inspection, record.original_filename)
      : null;

  res.json({ import: view(record), log, suggested });
});

/** The equivalent shell commands, for clusters too old for the API path. */
router.get("/:publicId/commands", async (req, res) => {
  const record = await mustFind(req.params.publicId);
  if (!record.inspection) throw new HttpError(400, "this import has not been inspected yet");

  const settings = record.settings ?? (await suggestSettings(record.inspection, record.original_filename));
  res.json({ commands: manualCommands(settings, record.inspection, record.original_filename) });
});

// ---------------------------------------------------------------------------
// Start / finalize / cancel
// ---------------------------------------------------------------------------

const settingsSchema = z.object({
  templateId: z.string().regex(/^[a-z0-9_-]+$/, "template id must be lowercase letters, digits, dashes, underscores").max(64),
  templateName: z.string().min(1).max(128),
  description: z.string().max(300).default(""),
  icon: z.enum(["windows", "server", "linux", "network", "generic"]),
  node: z.string().min(1),
  storage: z.string().min(1),
  importStorage: z.string().min(1),
  bridge: z.string().min(1),
  vlanTag: z.number().int().min(1).max(4094).nullable().default(null),
  vmid: z.number().int().min(100).max(999_999_999),
  cores: z.number().int().min(1).max(64),
  memoryMb: z.number().int().min(512).max(262_144),
  ostype: z.string().min(1).max(16),
  firmware: z.enum(["seabios", "ovmf"]),
  protocol: z.enum(["rdp", "vnc"]),
  port: z.number().int().min(1).max(65_535),
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(256),
  stagingPoolSize: z.number().int().min(0).max(20),
  strategy: z.enum(["ova", "disk"]),
  busType: z.enum(["auto", "sata", "scsi", "ide", "virtio"]),
  addTpm: z.boolean(),
  virtioIso: z.string().max(300).nullable().default(null),
  keepUpload: z.boolean(),
  registerTemplate: z.boolean(),
  startAfterImport: z.boolean(),
});

router.post("/:publicId/start", async (req, res) => {
  const record = await mustFind(req.params.publicId);
  if (!record.inspection) throw new HttpError(400, "this import has not been inspected yet");
  if (!["ready", "failed"].includes(record.status)) {
    throw new HttpError(409, `import is ${record.status}; only a ready or failed import can be started`);
  }
  // The upload is deleted once its disks are converted, so a failure *after*
  // that point can't be restarted from the top — say so rather than failing
  // deep in the worker with an ENOENT.
  if (!record.upload_path || !fs.existsSync(record.upload_path)) {
    throw new HttpError(
      409,
      vmAlreadyCreated(record)
        ? `The uploaded bundle has already been converted into VM ${record.settings?.vmid}. ` +
          `Finish that VM instead, or delete it on ${record.settings?.node} and upload the bundle again.`
        : "The uploaded file is no longer on disk. Upload the bundle again."
    );
  }

  const parse = settingsSchema.safeParse(req.body);
  if (!parse.success) throw new HttpError(400, "invalid import settings", parse.error.flatten());
  const settings = parse.data as ImportSettings;

  // The target must actually be able to take it — checked here rather than in
  // the worker so the admin gets a straight answer while they're still looking.
  const capabilities = await probeNode(settings.node);
  if (!capabilities.reachable) throw new HttpError(400, `node ${settings.node} is not reachable`);
  if (!capabilities.supportsApiImport) {
    throw new HttpError(400, `node ${settings.node} cannot run API imports: ${capabilities.blockers.join(" ")}`);
  }
  if (!capabilities.importStorages.some((s) => s.storage === settings.importStorage)) {
    throw new HttpError(400, `storage ${settings.importStorage} does not accept "import" content on ${settings.node}`);
  }
  if (!capabilities.imageStorages.some((s) => s.storage === settings.storage)) {
    throw new HttpError(400, `storage ${settings.storage} does not accept disk images on ${settings.node}`);
  }

  const clash = getTemplates().find((t) => t.id === settings.templateId);
  if (settings.registerTemplate && clash && clash.proxmox_template_id !== settings.vmid) {
    throw new HttpError(409, `template id "${settings.templateId}" is already in use`);
  }

  await store.setSettings(record.id, settings);
  await store.setStatus(record.id, "queued");
  await store.appendLog(record.id, "info", `Queued for import to ${settings.node} as VM ${settings.vmid}`);
  await importQueue.add("import", { importId: record.id }, { jobId: `vm-import-${record.id}` });

  await audit({
    action: "admin.import_started",
    details: {
      importId: record.id,
      node: settings.node,
      vmid: settings.vmid,
      templateId: settings.templateId,
      strategy: settings.strategy,
    },
    ipAddress: req.ip,
  });

  res.json({ ok: true, import: view((await store.getImport(record.id))!) });
});

router.post("/:publicId/finalize", async (req, res) => {
  const record = await mustFind(req.params.publicId);
  // Also allowed after a failed finalize — the VM exists either way, and
  // templating it is the only way forward from there.
  if (record.status !== "awaiting_prep" && !(record.status === "failed" && vmAlreadyCreated(record))) {
    throw new HttpError(409, `import is ${record.status}; only an import awaiting guest prep can be finalized`);
  }

  const result = await finalizeImport(record.id);
  await audit({
    action: "admin.import_finalize",
    details: { importId: record.id, ...result },
    ipAddress: req.ip,
  });
  res.json({ ok: true, ...result, import: view((await store.getImport(record.id))!) });
});

router.post("/:publicId/cancel", async (req, res) => {
  const record = await mustFind(req.params.publicId);
  if (["succeeded", "cancelled"].includes(record.status)) {
    throw new HttpError(409, `import is already ${record.status}`);
  }

  // The worker notices between stages; an in-flight Proxmox task still has to
  // finish before it can, so this isn't instant.
  await store.markCancelled(record.id, "Cancelled by an administrator");
  await store.appendLog(record.id, "warn", "Cancellation requested");
  await importQueue.remove(`vm-import-${record.id}`).catch(() => undefined);

  await audit({ action: "admin.import_cancelled", details: { importId: record.id }, ipAddress: req.ip });
  res.json({ ok: true });
});

router.delete("/:publicId", async (req, res) => {
  const record = await mustFind(req.params.publicId);
  if (record.status === "running") throw new HttpError(409, "cancel the import before deleting it");

  if (record.upload_path) {
    await fs.promises.rm(record.upload_path, { force: true }).catch(() => undefined);
  }
  await fs.promises
    .rm(path.join(env.IMPORT_DIR, `job-${record.public_id}`), { recursive: true, force: true })
    .catch(() => undefined);
  await store.deleteImport(record.id);

  await audit({ action: "admin.import_deleted", details: { importId: record.id }, ipAddress: req.ip });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Imported template tiles
// ---------------------------------------------------------------------------

router.post("/templates/:id/enabled", async (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  const ok = await setImportedTemplateEnabled(req.params.id, enabled);
  if (!ok) throw new HttpError(404, "imported template not found");

  await audit({
    action: "admin.imported_template_enabled",
    details: { id: req.params.id, enabled },
    ipAddress: req.ip,
  });
  res.json({ ok: true });
});

/** Removes the tile only. The Proxmox template VM is left in place. */
router.delete("/templates/:id", async (req, res) => {
  const ok = await deleteImportedTemplate(req.params.id);
  if (!ok) throw new HttpError(404, "imported template not found");

  await audit({ action: "admin.imported_template_deleted", details: { id: req.params.id }, ipAddress: req.ip });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** True once the pipeline is past disk creation, so a VM exists on the node. */
function vmAlreadyCreated(record: store.ImportRow): boolean {
  return Boolean(record.settings) && ["prep", "template", "register", "done"].includes(record.stage);
}

async function mustFind(publicId: string): Promise<store.ImportRow> {
  const record = await store.getImportByPublicId(publicId);
  if (!record) throw new HttpError(404, "import not found");
  return record;
}

/** The wire shape. `upload_path` is a server path and stays server-side. */
function view(row: store.ImportRow) {
  return {
    id: row.public_id,
    originalFilename: row.original_filename,
    uploadBytes: Number(row.upload_bytes),
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    inspection: row.inspection,
    settings: row.settings,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

/**
 * Turn an inspection into a complete, ready-to-submit configuration.
 *
 * This is what makes the wizard a one-click affair in the common case: every
 * field below is chosen from what the bundle and the cluster actually say, so
 * the admin confirms rather than fills in.
 */
async function suggestSettings(inspection: BundleInspection, filename: string): Promise<ImportSettings> {
  const { spec } = inspection;

  const existing = new Set(getTemplates().map((t) => t.id));
  let templateId = spec.name.replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "") || "imported-vm";
  for (let n = 2; existing.has(templateId); n++) templateId = `${templateId.replace(/-\d+$/, "")}-${n}`;

  // First node that can actually take an import wins; otherwise fall back to
  // the first configured one so the form still renders with its blockers shown.
  let chosen: NodeCapabilities | null = null;
  for (const node of getNodes()) {
    if (!node.enabled) continue;
    const capability = await probeNode(node.name);
    if (!chosen) chosen = capability;
    if (capability.supportsApiImport) {
      chosen = capability;
      break;
    }
  }

  const preferStorage = (list: Array<{ storage: string }>, ...preferred: string[]) => {
    for (const name of preferred) {
      const hit = list.find((s) => s.storage === name);
      if (hit) return hit.storage;
    }
    return list[0]?.storage ?? "";
  };

  return {
    templateId,
    templateName: titleCase(spec.name),
    description: `Imported from ${filename}`,
    icon: spec.icon,
    node: chosen?.node ?? getNodes()[0]?.name ?? "",
    storage: preferStorage(chosen?.imageStorages ?? [], "local-zfs", "local-lvm"),
    importStorage: preferStorage(chosen?.importStorages ?? [], "local"),
    bridge: chosen?.bridges.includes("vmbr0") ? "vmbr0" : chosen?.bridges[0] ?? "vmbr0",
    vlanTag: null,
    vmid: await allocateImportVmid(),
    cores: spec.cores,
    memoryMb: spec.memoryMb,
    ostype: spec.ostype,
    firmware: spec.firmware,
    protocol: spec.protocol,
    port: spec.port,
    username: spec.defaultUsername,
    password: "",
    stagingPoolSize: 1,
    strategy: inspection.container === "raw" ? "disk" : "ova",
    busType: "auto",
    addTpm: spec.ostype === "win11",
    virtioIso: spec.family === "windows" ? chosen?.virtioIsos[0] ?? null : null,
    keepUpload: false,
    registerTemplate: true,
    startAfterImport: true,
  };
}

function titleCase(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export default router;
