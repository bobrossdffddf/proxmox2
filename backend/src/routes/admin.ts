/**
 * Admin-only endpoints: list users, create user, disable user, reload configs,
 * inspect cluster state.
 */
import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { reloadConfigs, getNodes, getTemplates } from "../config";
import { many, one, query } from "../db/client";
import { AuthedRequest, requireAdmin, requireAuth } from "../middleware/auth";
import { HttpError } from "../middleware/errorHandler";
import { audit } from "../services/audit";
import { getSessionById, listAllLiveSessions, markSessionStopped } from "../services/sessionManager";
import { proxmox } from "../services/proxmox";
import { ensureAllStagedVms } from "../services/stagingMaintainer";
import { cleanupQueue } from "../jobs/queues";
import { deleteStagedVm, getStagedVmById, listStagedVms } from "../services/staging";
import { releaseVmid } from "../services/vmidPool";
import { listStagingTargets, setStagingPoolSize } from "../services/stagingSettings";

const router = Router();
router.use(requireAuth, requireAdmin);

function shouldForgetTrackedVm(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return [
    "404",
    "not found",
    "does not exist",
    "ECONNREFUSED",
    "ENOTFOUND",
    "EHOSTUNREACH",
    "ETIMEDOUT",
    "timeout",
    "No route to host",
    "Unknown Proxmox node",
  ].some((needle) => msg.toLowerCase().includes(needle.toLowerCase()));
}

async function destroyStagedVmById(id: number): Promise<{ vmId: number; templateId: string }> {
  const staged = await getStagedVmById(id);
  if (!staged) throw new HttpError(404, "staged VM not found");

  await deleteStagedVm(id);
  try {
    try {
      const stopUpid = await proxmox.powerOff(staged.proxmox_node, staged.proxmox_vmid, true);
      await proxmox.waitForTask(staged.proxmox_node, stopUpid, 60_000).catch(() => undefined);
    } catch {
      // Already off or unreachable is fine; deletion is the important step.
    }
    const deleteUpid = await proxmox.deleteVM(staged.proxmox_node, staged.proxmox_vmid);
    await proxmox.waitForTask(staged.proxmox_node, deleteUpid, 120_000);
    await releaseVmid(staged.proxmox_vmid);
    return { vmId: staged.proxmox_vmid, templateId: staged.template_id };
  } catch (err) {
    if (shouldForgetTrackedVm(err)) {
      await releaseVmid(staged.proxmox_vmid).catch(() => undefined);
      return { vmId: staged.proxmox_vmid, templateId: staged.template_id };
    }
    throw new HttpError(500, String(err));
  }
}

router.get("/users", async (_req, res) => {
  const users = await many<{
    id: number;
    username: string;
    role: string;
    disabled: boolean;
    max_vms: number;
    allowed_templates: string;
    created_at: Date;
    last_login_at: Date | null;
  }>(`SELECT id, username, role, disabled, max_vms, allowed_templates, created_at, last_login_at FROM users ORDER BY id`);
  res.json(users);
});

const createUserSchema = z.object({
  username: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/, "username has illegal characters"),
  password: z.string().min(8).max(256),
  role: z.enum(["student", "admin"]).default("student"),
  maxVms: z.number().int().min(1).max(50).default(1),
  allowedTemplates: z.string().min(1).max(2000).default("*"),
});

router.post("/users", async (req, res) => {
  const parse = createUserSchema.safeParse(req.body);
  if (!parse.success) throw new HttpError(400, "invalid user payload", parse.error.flatten());

  const { username, password, role, maxVms, allowedTemplates } = parse.data;
  const exists = await one(`SELECT id FROM users WHERE username=$1`, [username]);
  if (exists) throw new HttpError(409, "username already taken");

  const hash = await bcrypt.hash(password, 12);
  const row = await one<{ id: number }>(
    `INSERT INTO users (username, password_hash, role, max_vms, allowed_templates) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [username, hash, role, maxVms, allowedTemplates]
  );

  await audit({
    action: "admin.create_user",
    details: { username, role, maxVms, allowedTemplates, newUserId: row?.id },
    ipAddress: req.ip,
  });

  res.status(201).json({ id: row?.id, username, role });
});

const updateUserSchema = z.object({
  role: z.enum(["student", "admin"]).optional(),
  maxVms: z.number().int().min(1).max(50).optional(),
  allowedTemplates: z.string().min(1).max(2000).optional(),
});

router.patch("/users/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "invalid user id");

  const parse = updateUserSchema.safeParse(req.body);
  if (!parse.success) throw new HttpError(400, "invalid user payload", parse.error.flatten());
  const { role, maxVms, allowedTemplates } = parse.data;
  if (role === undefined && maxVms === undefined && allowedTemplates === undefined) {
    throw new HttpError(400, "no changes provided");
  }

  const row = await one<{ id: number; username: string; role: string; max_vms: number; allowed_templates: string }>(
    `UPDATE users
     SET role=COALESCE($2, role),
         max_vms=COALESCE($3, max_vms),
         allowed_templates=COALESCE($4, allowed_templates)
     WHERE id=$1
     RETURNING id, username, role, max_vms, allowed_templates`,
    [id, role ?? null, maxVms ?? null, allowedTemplates ?? null]
  );
  if (!row) throw new HttpError(404, "user not found");

  await audit({
    action: "admin.update_user",
    details: { id, role, maxVms, allowedTemplates },
    ipAddress: req.ip,
  });
  res.json(row);
});

const resetPasswordSchema = z.object({
  password: z.string().min(8).max(256),
});

router.post("/users/:id/password", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "invalid user id");

  const parse = resetPasswordSchema.safeParse(req.body);
  if (!parse.success) throw new HttpError(400, "invalid password payload", parse.error.flatten());

  const hash = await bcrypt.hash(parse.data.password, 12);
  const row = await one<{ id: number; username: string }>(
    `UPDATE users SET password_hash=$2 WHERE id=$1 RETURNING id, username`,
    [id, hash]
  );
  if (!row) throw new HttpError(404, "user not found");

  await audit({
    action: "admin.reset_password",
    details: { id, username: row.username },
    ipAddress: req.ip,
  });
  res.json({ ok: true });
});

router.post("/users/:id/disable", async (req, res) => {
  const id = Number(req.params.id);
  const auth = (req as unknown as AuthedRequest).auth;
  if (id === auth.sub) throw new HttpError(400, "You cannot disable your own account");
  await query(`UPDATE users SET disabled=true WHERE id=$1`, [id]);
  await audit({ action: "admin.disable_user", details: { id }, ipAddress: req.ip });
  res.json({ ok: true });
});

router.post("/users/:id/enable", async (req, res) => {
  const id = Number(req.params.id);
  await query(`UPDATE users SET disabled=false WHERE id=$1`, [id]);
  await audit({ action: "admin.enable_user", details: { id }, ipAddress: req.ip });
  res.json({ ok: true });
});

router.get("/sessions", async (_req, res) => {
  const all = await listAllLiveSessions();
  res.json(all);
});

router.get("/resources", async (_req, res) => {
  const sessions = await many<{
    id: number;
    public_id: string;
    user_id: number;
    username: string;
    template_id: string;
    template_name: string;
    proxmox_node: string;
    proxmox_vmid: number;
    status: string;
    created_at: Date;
  }>(
    `SELECT s.id, s.public_id, s.user_id, u.username, s.template_id, s.template_name,
            s.proxmox_node, s.proxmox_vmid, s.status, s.created_at
     FROM sessions s
     JOIN users u ON u.id=s.user_id
     WHERE s.status IN ('queued','provisioning','running','cleaning','cleanup_failed')
     ORDER BY s.created_at DESC`
  );

  const nodes = await Promise.all(getNodes().map(async (node) => {
    try {
      const status = await proxmox.getNodeStatus(node.name);
      return {
        name: node.name,
        enabled: node.enabled,
        reachable: true,
        cpuPct: Math.round((status.cpu ?? 0) * 1000) / 10,
        memoryUsed: status.memory.used,
        memoryTotal: status.memory.total,
      };
    } catch (err) {
      return {
        name: node.name,
        enabled: node.enabled,
        reachable: false,
        error: String(err),
      };
    }
  }));

  const vms = await Promise.all(sessions.map(async (session) => {
    try {
      const status = await proxmox.getVmCurrentStatus(session.proxmox_node, session.proxmox_vmid);
      return {
        ...session,
        metrics: {
          status: status.status,
          cpuPct: Math.round((status.cpu ?? 0) * 1000) / 10,
          cpus: status.cpus ?? null,
          mem: status.mem ?? null,
          maxmem: status.maxmem ?? null,
          netin: status.netin ?? 0,
          netout: status.netout ?? 0,
          diskread: status.diskread ?? 0,
          diskwrite: status.diskwrite ?? 0,
          uptime: status.uptime ?? 0,
        },
      };
    } catch (err) {
      return {
        ...session,
        metrics: null,
        error: String(err),
      };
    }
  }));

  const users = Array.from(
    vms.reduce((map, vm) => {
      const current = map.get(vm.user_id) ?? {
        userId: vm.user_id,
        username: vm.username,
        activeVms: 0,
        cpuPct: 0,
        mem: 0,
        maxmem: 0,
      };
      current.activeVms += 1;
      current.cpuPct += vm.metrics?.cpuPct ?? 0;
      current.mem += vm.metrics?.mem ?? 0;
      current.maxmem += vm.metrics?.maxmem ?? 0;
      map.set(vm.user_id, current);
      return map;
    }, new Map<number, { userId: number; username: string; activeVms: number; cpuPct: number; mem: number; maxmem: number }>())
    .values()
  ).sort((a, b) => b.activeVms - a.activeVms || b.cpuPct - a.cpuPct);

  const templates = Array.from(
    vms.reduce((map, vm) => {
      const current = map.get(vm.template_id) ?? {
        templateId: vm.template_id,
        templateName: vm.template_name,
        activeVms: 0,
        cpuPct: 0,
        mem: 0,
      };
      current.activeVms += 1;
      current.cpuPct += vm.metrics?.cpuPct ?? 0;
      current.mem += vm.metrics?.mem ?? 0;
      map.set(vm.template_id, current);
      return map;
    }, new Map<string, { templateId: string; templateName: string; activeVms: number; cpuPct: number; mem: number }>())
    .values()
  ).sort((a, b) => b.activeVms - a.activeVms || b.cpuPct - a.cpuPct);

  res.json({ nodes, vms, users, templates, generatedAt: new Date().toISOString() });
});

router.post("/sessions/:id/stop", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "invalid session id");

  await cleanupQueue.add(
    "admin-stop",
    { sessionId: id, reason: "admin_requested" },
    { jobId: `admin-cleanup-session-${id}` }
  );

  await audit({
    action: "admin.stop_session",
    sessionId: id,
    details: { id },
    ipAddress: req.ip,
  });
  res.json({ ok: true });
});

router.post("/sessions/:id/forget", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "invalid session id");

  const session = await getSessionById(id);
  if (!session) throw new HttpError(404, "session not found");

  await markSessionStopped(id);
  await releaseVmid(session.proxmox_vmid).catch(() => undefined);
  await audit({
    action: "admin.forget_session",
    sessionId: id,
    details: { id, vmId: session.proxmox_vmid, node: session.proxmox_node },
    ipAddress: req.ip,
  });
  res.json({ ok: true });
});

router.post("/sessions/stop-all", async (req, res) => {
  const sessions = await listAllLiveSessions();
  for (const session of sessions) {
    await cleanupQueue.add(
      "admin-stop-all",
      { sessionId: session.id, reason: "admin_requested" },
      { jobId: `admin-cleanup-session-${session.id}` }
    );
  }

  await audit({
    action: "admin.stop_all_sessions",
    details: { count: sessions.length },
    ipAddress: req.ip,
  });
  res.json({ ok: true, count: sessions.length });
});

router.get("/staged", async (_req, res) => {
  res.json(await listStagedVms());
});

router.post("/staged/ensure", async (req, res) => {
  await ensureAllStagedVms();
  await audit({ action: "admin.ensure_staging", ipAddress: req.ip });
  res.json({ ok: true });
});

router.get("/staging-targets", async (_req, res) => {
  res.json(await listStagingTargets());
});

const stagingPoolSchema = z.object({
  poolSize: z.number().int().min(0).max(20),
});

router.patch("/staging-targets/:templateId", async (req, res) => {
  const template = getTemplates().find((item) => item.id === req.params.templateId);
  if (!template) throw new HttpError(404, "template not found");

  const parse = stagingPoolSchema.safeParse(req.body);
  if (!parse.success) throw new HttpError(400, "invalid staging target payload", parse.error.flatten());

  await setStagingPoolSize(template.id, parse.data.poolSize);
  await ensureAllStagedVms();
  await audit({
    action: "admin.update_staging_pool",
    details: { templateId: template.id, poolSize: parse.data.poolSize },
    ipAddress: req.ip,
  });
  res.json({ ok: true });
});

router.delete("/staged/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "invalid staged VM id");

  try {
    const destroyed = await destroyStagedVmById(id);
    await audit({
      action: "admin.destroy_staged",
      details: { id, templateId: destroyed.templateId, vmId: destroyed.vmId },
      ipAddress: req.ip,
    });
  } catch (err) {
    await audit({
      action: "admin.destroy_staged_failed",
      details: { id, error: String(err) },
      ipAddress: req.ip,
    });
    throw err;
  }

  await ensureAllStagedVms();
  res.json({ ok: true });
});

router.post("/staged/:id/forget", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "invalid staged VM id");

  const staged = await getStagedVmById(id);
  if (!staged) throw new HttpError(404, "staged VM not found");

  await deleteStagedVm(id);
  await releaseVmid(staged.proxmox_vmid).catch(() => undefined);
  await audit({
    action: "admin.forget_staged",
    details: { id, templateId: staged.template_id, vmId: staged.proxmox_vmid, node: staged.proxmox_node },
    ipAddress: req.ip,
  });
  res.json({ ok: true });
});

router.delete("/vms/all", async (req, res) => {
  const sessions = await listAllLiveSessions();
  for (const session of sessions) {
    await cleanupQueue.add(
      "admin-delete-all",
      { sessionId: session.id, reason: "admin_requested" },
      { jobId: `admin-cleanup-session-${session.id}` }
    );
  }

  const staged = await listStagedVms();
  let stagedDestroyed = 0;
  for (const vm of staged) {
    try {
      await destroyStagedVmById(vm.id);
      stagedDestroyed += 1;
    } catch (err) {
      await audit({
        action: "admin.delete_all_staged_failed",
        details: { id: vm.id, vmId: vm.proxmox_vmid, error: String(err) },
        ipAddress: req.ip,
      });
    }
  }

  await audit({
    action: "admin.delete_all_vms",
    details: { activeQueued: sessions.length, stagedDestroyed },
    ipAddress: req.ip,
  });
  res.json({ ok: true, activeQueued: sessions.length, stagedDestroyed });
});

const announcementSchema = z.object({
  title: z.string().min(1).max(120),
  message: z.string().min(1).max(2000),
  active: z.boolean().default(true),
});

router.get("/announcements", async (_req, res) => {
  const announcements = await many<{
    id: number;
    title: string;
    message: string;
    active: boolean;
    created_by: number | null;
    created_at: Date;
  }>(
    `SELECT id, title, message, active, created_by, created_at
     FROM announcements
     ORDER BY created_at DESC
     LIMIT 100`
  );
  res.json(announcements);
});

router.post("/announcements", async (req, res) => {
  const parse = announcementSchema.safeParse(req.body);
  if (!parse.success) throw new HttpError(400, "invalid announcement payload", parse.error.flatten());
  const auth = (req as unknown as AuthedRequest).auth;

  const row = await one<{ id: number }>(
    `INSERT INTO announcements (title, message, active, created_by)
     VALUES ($1,$2,$3,$4)
     RETURNING id`,
    [parse.data.title, parse.data.message, parse.data.active, auth.sub]
  );
  await audit({
    userId: auth.sub,
    username: auth.username,
    action: "admin.create_announcement",
    details: { id: row?.id, title: parse.data.title, active: parse.data.active },
    ipAddress: req.ip,
  });
  res.status(201).json({ id: row?.id, ...parse.data });
});

router.post("/announcements/:id/deactivate", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "invalid announcement id");
  await query(`UPDATE announcements SET active=false WHERE id=$1`, [id]);
  await audit({ action: "admin.deactivate_announcement", details: { id }, ipAddress: req.ip });
  res.json({ ok: true });
});

router.get("/users/:id/audit", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "invalid user id");

  const logs = await many<{
    id: number;
    action: string;
    session_id: number | null;
    ip_address: string | null;
    details: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT id, action, session_id, ip_address, details, created_at
     FROM audit_log
     WHERE user_id=$1
        OR (action LIKE 'admin.%' AND (details->>'id'=$2 OR details->>'newUserId'=$2))
     ORDER BY created_at DESC
     LIMIT 200`,
    [id, String(id)]
  );
  res.json(logs);
});

router.post("/reload", async (_req, res) => {
  reloadConfigs();
  await ensureAllStagedVms();
  await audit({ action: "admin.reload_configs" });
  res.json({ ok: true, nodes: getNodes().length, templates: getTemplates().length });
});

router.get("/cluster", async (_req, res) => {
  try {
    const healthy = await proxmox.listHealthyNodes();
    res.json({ healthy: healthy.map((n) => n.name) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
