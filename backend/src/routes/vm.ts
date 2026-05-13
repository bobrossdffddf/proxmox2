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
import { consumeStagedVm, countLiveStagedVms, getReadyStagedVm } from "../services/staging";

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

  const active = await listActiveSessionsForUser(auth.sub);
  if (active.length >= env.MAX_VMS_PER_USER) {
    throw new HttpError(
      429,
      `You already have ${active.length} active VMs (limit ${env.MAX_VMS_PER_USER}). Stop one and try again.`
    );
  }
  const cluster = await countActiveSessions();
  if (cluster >= env.MAX_CLUSTER_VMS) {
    throw new HttpError(
      503,
      `Cluster is at capacity (${cluster}/${env.MAX_CLUSTER_VMS}). Try again in a few minutes.`
    );
  }

  await audit({
    userId: auth.sub,
    username: auth.username,
    action: "vm.requested",
    ipAddress: req.ip,
    details: { templateId },
  });

  const staged = await getReadyStagedVm(templateId);
  if (staged) {
    await consumeStagedVm(staged.id);
    const claimed = await provisioningQueue.add("provision", { userId: auth.sub, templateId });
    const liveStaged = await countLiveStagedVms(templateId);
    if (liveStaged === 0) {
      await provisioningQueue.add("stage", { templateId, staged: true });
    }
    res.status(202).json({ jobId: claimed.id, templateId, status: "queued", source: "staged" });
    return;
  }

  const job = await provisioningQueue.add("provision", { userId: auth.sub, templateId });
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
