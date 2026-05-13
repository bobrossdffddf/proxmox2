/**
 * Auth routes: login + whoami.
 *
 * Registration is admin-only and lives in routes/admin.ts. Bob creates the
 * roster manually (or via a CSV import script).
 */
import bcrypt from "bcryptjs";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { one, query } from "../db/client";
import { AuthedRequest, requireAuth, signToken } from "../middleware/auth";
import { HttpError } from "../middleware/errorHandler";
import { audit } from "../services/audit";

const router = Router();

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

// Keep brute-force protection without locking out a whole classroom behind
// the same NAT after a few mistyped passwords.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please wait a few minutes and try again." },
});

router.post("/login", loginLimiter, async (req, res) => {
  const parse = loginSchema.safeParse(req.body);
  if (!parse.success) throw new HttpError(400, "username and password required");

  const { username, password } = parse.data;
  const user = await one<{
    id: number;
    username: string;
    password_hash: string;
    role: "student" | "admin";
    disabled: boolean;
  }>(
    `SELECT id, username, password_hash, role, disabled FROM users WHERE username=$1`,
    [username]
  );

  if (!user || user.disabled) {
    throw new HttpError(401, "invalid credentials");
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) throw new HttpError(401, "invalid credentials");

  await query(`UPDATE users SET last_login_at=NOW() WHERE id=$1`, [user.id]);

  const token = signToken({ sub: user.id, username: user.username, role: user.role });

  await audit({
    userId: user.id,
    username: user.username,
    action: "auth.login",
    ipAddress: req.ip,
  });

  res.json({
    token,
    user: { id: user.id, username: user.username, role: user.role },
  });
});

router.get("/me", requireAuth, (req, res) => {
  const auth = (req as unknown as AuthedRequest).auth;
  res.json({ id: auth.sub, username: auth.username, role: auth.role });
});

export default router;
