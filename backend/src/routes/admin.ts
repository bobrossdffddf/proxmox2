/**
 * Admin-only endpoints: list users, create user, disable user, reload configs,
 * inspect cluster state.
 */
import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { reloadConfigs, getNodes, getTemplates } from "../config";
import { many, one, query } from "../db/client";
import { requireAdmin, requireAuth } from "../middleware/auth";
import { HttpError } from "../middleware/errorHandler";
import { audit } from "../services/audit";
import { listAllLiveSessions } from "../services/sessionManager";
import { proxmox } from "../services/proxmox";

const router = Router();
router.use(requireAuth, requireAdmin);

router.get("/users", async (_req, res) => {
  const users = await many<{
    id: number;
    username: string;
    role: string;
    disabled: boolean;
    created_at: Date;
    last_login_at: Date | null;
  }>(`SELECT id, username, role, disabled, created_at, last_login_at FROM users ORDER BY id`);
  res.json(users);
});

const createUserSchema = z.object({
  username: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/, "username has illegal characters"),
  password: z.string().min(8).max(256),
  role: z.enum(["student", "admin"]).default("student"),
});

router.post("/users", async (req, res) => {
  const parse = createUserSchema.safeParse(req.body);
  if (!parse.success) throw new HttpError(400, "invalid user payload", parse.error.flatten());

  const { username, password, role } = parse.data;
  const exists = await one(`SELECT id FROM users WHERE username=$1`, [username]);
  if (exists) throw new HttpError(409, "username already taken");

  const hash = await bcrypt.hash(password, 12);
  const row = await one<{ id: number }>(
    `INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3) RETURNING id`,
    [username, hash, role]
  );

  await audit({
    action: "admin.create_user",
    details: { username, role, newUserId: row?.id },
    ipAddress: req.ip,
  });

  res.status(201).json({ id: row?.id, username, role });
});

router.post("/users/:id/disable", async (req, res) => {
  const id = Number(req.params.id);
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

router.post("/reload", async (_req, res) => {
  reloadConfigs();
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
