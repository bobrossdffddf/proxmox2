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
import {
  countActiveSessions,
  createRunningSessionFromStaged,
  getSessionByPublicId,
  listActiveSessionsForUser,
  publicView,
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
  if (!s || s.user_id !== auth.sub) throw new HttpError(404, "not found");
  res.json(publicView(s));
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
