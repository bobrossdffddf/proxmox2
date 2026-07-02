/**
 * VM lifecycle endpoints.
 *
 *   POST   /vm/request                  -> claim a ready staged VM
 *   GET    /vm/sessions                 -> list this user's active sessions
 *   GET    /vm/sessions/:publicId       -> single session (status + RDP info)
 *   POST   /vm/sessions/:publicId/heartbeat
 *   DELETE /vm/sessions/:publicId       -> user-initiated stop
 */
import { Router } from "express";
import { z } from "zod";
import { env, getTemplate } from "../config";
import { one } from "../db/client";
import { cleanupQueue } from "../jobs/queues";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { HttpError } from "../middleware/errorHandler";
import { audit } from "../services/audit";
import { redis } from "../services/redis";
import { proxmox } from "../services/proxmox";
import {
  countActiveSessions,
  createRunningSessionFromStaged,
  extendSession,
  getSessionByPublicId,
  listActiveSessionsForUser,
  publicView,
  setSessionNotes,
  touchHeartbeat,
} from "../services/sessionManager";
import { claimReadyStagedVm } from "../services/staging";
import { ensureStagedVm } from "../services/stagingMaintainer";

const router = Router();
router.use(requireAuth);

const requestSchema = z.object({ templateId: z.string().min(1).max(64) });

router.post("/request", async (req, res) => {
  const parse = requestSchema.safeParse(req.body);
  if (!parse.success) throw new HttpError(400, "templateId required");

  const auth = (req as unknown as AuthedRequest).auth;
  const templateId = parse.data.templateId;

  const template = getTemplate(templateId);
  if (!template || !template.enabled) {
    throw new HttpError(404, "unknown template");
  }

  const userCfg = await one<{ max_vms: number; allowed_templates: string }>(
    `SELECT max_vms, allowed_templates FROM users WHERE id=$1`,
    [auth.sub]
  );
  const allowed = (userCfg?.allowed_templates ?? "*").split(",").map((v) => v.trim()).filter(Boolean);
  if (!(allowed.includes("*") || allowed.includes(templateId))) {
    throw new HttpError(403, "You do not have access to this template");
  }

  const maxForUser = userCfg?.max_vms ?? env.MAX_VMS_PER_USER;
  const active = await listActiveSessionsForUser(auth.sub);
  if (active.length >= maxForUser) {
    throw new HttpError(
      429,
      `You already have ${active.length} active VMs (limit ${maxForUser}). Stop one and try again.`
    );
  }

  const cluster = await countActiveSessions();
  if (cluster >= env.MAX_CLUSTER_VMS) {
    throw new HttpError(
      503,
      `Cluster is at capacity (${cluster}/${env.MAX_CLUSTER_VMS}). Try again in a few minutes.`
    );
  }

  const requestLockKey = `vm:req-lock:user:${auth.sub}`;
  const lock = await redis.set(requestLockKey, String(Date.now()), "EX", 5, "NX");
  if (!lock) throw new HttpError(429, "A VM request is already being processed. Please wait a few seconds.");

  try {
    await audit({
      userId: auth.sub,
      username: auth.username,
      action: "vm.requested",
      ipAddress: req.ip,
      details: { templateId },
    });

    const staged = await claimReadyStagedVm(templateId);
    if (!staged) {
      await ensureStagedVm(templateId);
      throw new HttpError(503, "This VM is still warming up. Try again in a moment.");
    }

    const session = await createRunningSessionFromStaged({
      userId: auth.sub,
      templateId: staged.template_id,
      templateName: staged.template_name,
      protocol: staged.protocol,
      proxmoxNode: staged.proxmox_node,
      proxmoxVmid: staged.proxmox_vmid,
      proxmoxTemplateId: staged.proxmox_template_id,
      snapshotName: staged.snapshot_name,
      guestIp: staged.guest_ip,
      guestPort: staged.guest_port,
      guestUsername: staged.guest_username,
      guestPassword: staged.guest_password,
    });

    await cleanupQueue.add(
      "cleanup",
      { sessionId: session.id, reason: "hard_timeout" },
      { delay: env.SESSION_HARD_TIMEOUT_MINUTES * 60 * 1000 }
    );
    await audit({
      userId: auth.sub,
      username: auth.username,
      action: "vm.claimed_staged",
      sessionId: session.id,
      ipAddress: req.ip,
      details: { templateId, stagedVmId: staged.id, vmId: staged.proxmox_vmid },
    });

    await ensureStagedVm(templateId);

    res.status(201).json({
      sessionId: session.public_id,
      templateId,
      status: "running",
      source: "staged",
    });
  } finally {
    await redis.del(requestLockKey);
  }
});

router.get("/sessions", async (req, res) => {
  const auth = (req as unknown as AuthedRequest).auth;
  const rows = await listActiveSessionsForUser(auth.sub);
  res.json(rows.map(publicView));
});

router.get("/sessions/:publicId", async (req, res) => {
  const auth = (req as unknown as AuthedRequest).auth;
  const s = await getSessionByPublicId(req.params.publicId);
  // Admins may look up any session so they can spectate a student's console.
  if (!s || (s.user_id !== auth.sub && auth.role !== "admin")) throw new HttpError(404, "not found");
  res.json({ ...publicView(s), isOwner: s.user_id === auth.sub });
});

router.post("/sessions/:publicId/extend", async (req, res) => {
  const auth = (req as unknown as AuthedRequest).auth;
  const s = await getSessionByPublicId(req.params.publicId);
  if (!s || s.user_id !== auth.sub) throw new HttpError(404, "not found");
  if (s.status !== "running") throw new HttpError(409, "Session is not running");
  if (s.extended_minutes > 0) throw new HttpError(409, "Session was already extended once");

  const updated = await extendSession(s.id, env.SESSION_EXTEND_MINUTES);
  if (!updated) throw new HttpError(409, "Session could not be extended");

  await audit({
    userId: auth.sub,
    username: auth.username,
    action: "vm.extended",
    sessionId: s.id,
    ipAddress: req.ip,
    details: { minutes: env.SESSION_EXTEND_MINUTES },
  });
  res.json(publicView(updated));
});

const notesSchema = z.object({ notes: z.string().max(4000) });

router.post("/sessions/:publicId/notes", async (req, res) => {
  const parse = notesSchema.safeParse(req.body);
  if (!parse.success) throw new HttpError(400, "notes must be a string (max 4000 chars)");

  const auth = (req as unknown as AuthedRequest).auth;
  const s = await getSessionByPublicId(req.params.publicId);
  if (!s || s.user_id !== auth.sub) throw new HttpError(404, "not found");

  await setSessionNotes(s.id, parse.data.notes);
  await audit({
    userId: auth.sub,
    username: auth.username,
    action: "vm.notes_saved",
    sessionId: s.id,
    ipAddress: req.ip,
    details: { length: parse.data.notes.length },
  });
  res.json({ ok: true });
});

// The QEMU agent caps file-write payloads at 60 KiB of (base64) content.
const MAX_FILE_B64_CHARS = 61440;

const fileSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[\w][\w .()-]*$/, "invalid file name"),
  contentBase64: z.string().min(1).max(MAX_FILE_B64_CHARS, "File too large — the guest agent accepts ~45 KB max"),
});

router.post("/sessions/:publicId/files", async (req, res) => {
  const parse = fileSchema.safeParse(req.body);
  if (!parse.success) {
    const msg = parse.error.issues[0]?.message ?? "invalid file payload";
    throw new HttpError(400, msg);
  }

  const auth = (req as unknown as AuthedRequest).auth;
  const s = await getSessionByPublicId(req.params.publicId);
  if (!s || s.user_id !== auth.sub) throw new HttpError(404, "not found");
  if (s.status !== "running") throw new HttpError(409, "Session is not running");

  const { name, contentBase64 } = parse.data;
  const guestPath = s.protocol === "rdp"
    ? `C:\\Users\\Public\\Desktop\\${name}`
    : `/tmp/${name}`;

  try {
    await proxmox.agentFileWrite(s.proxmox_node, s.proxmox_vmid, guestPath, contentBase64);
  } catch (err) {
    throw new HttpError(502, `Guest agent rejected the file: ${err instanceof Error ? err.message : String(err)}`);
  }

  await audit({
    userId: auth.sub,
    username: auth.username,
    action: "vm.file_pushed",
    sessionId: s.id,
    ipAddress: req.ip,
    details: { name, guestPath, bytes: Math.floor(contentBase64.length * 0.75) },
  });
  res.json({ ok: true, guestPath });
});

router.post("/sessions/:publicId/heartbeat", async (req, res) => {
  const auth = (req as unknown as AuthedRequest).auth;
  const s = await getSessionByPublicId(req.params.publicId);
  if (!s || s.user_id !== auth.sub) throw new HttpError(404, "not found");
  if (s.status !== "running") {
    res.json({ ok: false, status: s.status });
    return;
  }
  await touchHeartbeat(s.id);
  res.json({ ok: true });
});

router.delete("/sessions/:publicId", async (req, res) => {
  const auth = (req as unknown as AuthedRequest).auth;
  const s = await getSessionByPublicId(req.params.publicId);
  if (!s || s.user_id !== auth.sub) throw new HttpError(404, "not found");

  await cleanupQueue.add(
    "user-stop",
    { sessionId: s.id, reason: "user_requested" },
    { jobId: `cleanup-session-${s.id}` }
  );

  await audit({
    userId: auth.sub,
    username: auth.username,
    action: "vm.stop_requested",
    sessionId: s.id,
    ipAddress: req.ip,
  });

  res.json({ ok: true });
});

export default router;
