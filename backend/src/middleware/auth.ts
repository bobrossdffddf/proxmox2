/**
 * JWT auth middleware. Issues short-lived tokens that include the user's id,
 * username, and role. We don't store sessions server-side; the JWT signature
 * is the source of truth.
 *
 * Tokens come in three flavors for our use:
 *   - Authorization: Bearer <jwt>  (normal API auth)
 *   - ?token=<jwt>                 (used by the WebSocket upgrade — browsers
 *                                   can't set headers on WS connections, so we
 *                                   fall back to a query param)
 */
import { NextFunction, Request, Response } from "express";
import jwt, { SignOptions } from "jsonwebtoken";
import { env } from "../config";
import { HttpError } from "./errorHandler";

export interface AuthPayload {
  sub: number;        // user id
  username: string;
  role: "student" | "admin";
}

export interface AuthedRequest extends Request {
  auth: AuthPayload;
}

export function signToken(payload: AuthPayload): string {
  const options: SignOptions = { expiresIn: env.JWT_EXPIRES_IN as SignOptions["expiresIn"] };
  return jwt.sign(payload, env.JWT_SECRET, options);
}

export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, env.JWT_SECRET) as AuthPayload;
}

function extractToken(req: Request): string | null {
  const header = req.header("authorization");
  if (header && header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  if (typeof req.query.token === "string") {
    return req.query.token;
  }
  return null;
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (!token) throw new HttpError(401, "missing token");
  try {
    const payload = verifyToken(token);
    (req as AuthedRequest).auth = payload;
    next();
  } catch {
    throw new HttpError(401, "invalid or expired token");
  }
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const auth = (req as AuthedRequest).auth;
  if (!auth || auth.role !== "admin") throw new HttpError(403, "admin only");
  next();
}
