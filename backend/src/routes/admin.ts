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
import { listAllLiveSessions } from "../services/sessionManager";
import { proxmox } from "../services/proxmox";
import { ensureAllStagedVms } from "../services/stagingMaintainer";
import { cleanupQueue } from "../jobs/queues";
import { deleteStagedVm, getStagedVmById, listStagedVms } from "../services/staging";
import { releaseVmid } from "../services/vmidPool";

const router = Router();
router.use(requireAuth, requireAdmin);

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

router.get("/staged", async (_req, res) => {
  res.json(await listStagedVms());
});

router.post("/staged/ensure", async (req, res) => {
  await ensureAllStagedVms();
  await audit({ action: "admin.ensure_staging", ipAddress: req.ip });
  res.json({ ok: true });
});

router.delete("/staged/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "invalid staged VM id");

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
  } catch (err) {
    await audit({
      action: "admin.destroy_staged_failed",
      details: { id, vmId: staged.proxmox_vmid, error: String(err) },
      ipAddress: req.ip,
    });
    throw err;
  }

  await audit({
    action: "admin.destroy_staged",
    details: { id, templateId: staged.template_id, vmId: staged.proxmox_vmid },
    ipAddress: req.ip,
  });
  await ensureAllStagedVms();
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
