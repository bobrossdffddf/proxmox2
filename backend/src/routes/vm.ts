/**
 * VM lifecycle endpoints.
 *
 *   POST   /vm/request                  -> queue a provisioning job
 *   GET    /vm/sessions                 -> list this user's active sessions
 *   GET    /vm/sessions/:publicId       -> single session (status + RDP info)
 *   POST   /vm/sessions/:publicId/heartbeat
 *   DELETE /vm/sessions/:publicId       -> user-initiated stop
 */
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { env, getTemplate } from "../config";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { HttpError } from "../middleware/errorHandler";
import { audit } from "../services/audit";
import {
  countActiveSessions,
  getSessionByPublicId,
  listActiveSessionsForUser,
  publicView,
  touchHeartbeat,
} from "../services/sessionManager";
import { cleanupQueue, provisioningQueue } from "../jobs/queues";
 codex/add-progress-bar-and-vm-staging-features-l2eu01
import { one } from "../db/client";
import { redis } from "../services/redis";
import { claimReadyStagedVm, countLiveStagedVms } from "../services/staging";
codex/add-progress-bar-and-vm-staging-features-7nboq7
import { one } from "../db/client";
import { redis } from "../services/redis";
import { claimReadyStagedVm, countLiveStagedVms } from "../services/staging";
import { consumeStagedVm, countLiveStagedVms, getReadyStagedVm } from "../services/staging";
main
 main

const router = Router();
router.use(requireAuth);

const requestSchema = z.object({ templateId: z.string().min(1).max(64) });

const requestLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/request", requestLimiter, async (req, res) => {
  const parse = requestSchema.safeParse(req.body);
  if (!parse.success) throw new HttpError(400, "templateId required");

  const auth = (req as unknown as AuthedRequest).auth;
  const templateId = parse.data.templateId;

  const template = getTemplate(templateId);
  if (!template || !template.enabled) {
    throw new HttpError(404, "unknown template");
  }

 codex/add-progress-bar-and-vm-staging-features-l2eu01
  let userCfg: { max_vms: number; allowed_templates: string } | null = null;
  try {
    userCfg = await one<{ max_vms: number; allowed_templates: string }>(`SELECT max_vms, allowed_templates FROM users WHERE id=$1`, [auth.sub]);
  } catch {
    const legacy = await one<{ role: string }>(`SELECT role FROM users WHERE id=$1`, [auth.sub]);
    userCfg = {
      max_vms: env.MAX_VMS_PER_USER,
      allowed_templates: legacy?.role === "admin" ? "*" : templateId,
    };
  }
  const userCfg = await one<{ max_vms: number; allowed_templates: string }>(`SELECT max_vms, allowed_templates FROM users WHERE id=$1`, [auth.sub]);
 main
  const allowed = (userCfg?.allowed_templates ?? "*").split(",").map((v) => v.trim()).filter(Boolean);
  if (!(allowed.includes("*") || allowed.includes(templateId))) throw new HttpError(403, "You do not have access to this template");

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

  await audit({
    userId: auth.sub,
    username: auth.username,
    action: "vm.requested",
    ipAddress: req.ip,
    details: { templateId },
  });

 codex/add-progress-bar-and-vm-staging-features-l2eu01
  const staged = await claimReadyStagedVm(templateId);
  if (staged) {
    const claimed = await provisioningQueue.add("provision", { userId: auth.sub, templateId, stagedVm: staged });

 codex/add-progress-bar-and-vm-staging-features-7nboq7
  const staged = await claimReadyStagedVm(templateId);
  if (staged) {
    const claimed = await provisioningQueue.add("provision", { userId: auth.sub, templateId, stagedVm: staged });

  const staged = await getReadyStagedVm(templateId);
  if (staged) {
    await consumeStagedVm(staged.id);
    const claimed = await provisioningQueue.add("provision", { userId: auth.sub, templateId });
 main
 main
    const liveStaged = await countLiveStagedVms(templateId);
    if (liveStaged === 0) {
      await provisioningQueue.add("stage", { templateId, staged: true });
    }
 codex/add-progress-bar-and-vm-staging-features-l2eu01
    await redis.del(requestLockKey);
 codex/add-progress-bar-and-vm-staging-features-7nboq7
    await redis.del(requestLockKey);

 main
 main
    res.status(202).json({ jobId: claimed.id, templateId, status: "queued", source: "staged" });
    return;
  }

  const job = await provisioningQueue.add("provision", { userId: auth.sub, templateId });
 codex/add-progress-bar-and-vm-staging-features-l2eu01
  await redis.del(requestLockKey);
 codex/add-progress-bar-and-vm-staging-features-7nboq7
  await redis.del(requestLockKey);

 main
 main
  const liveStaged = await countLiveStagedVms(templateId);
  if (liveStaged === 0) {
    await provisioningQueue.add("stage", { templateId, staged: true });
  }

  res.status(202).json({
    jobId: job.id,
    templateId,
    status: "queued",
  });
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
