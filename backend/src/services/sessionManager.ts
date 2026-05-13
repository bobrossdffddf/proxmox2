/**
 * Session lifecycle. Owns the sessions table: creation, heartbeat updates,
 * lookup helpers, and the cleanup state transitions. The actual Proxmox calls
 * happen in the cleanup worker.
 */
import { nanoid } from "nanoid";
import { env } from "../config";
import { many, one, query } from "../db/client";
import { logger } from "./logger";

export type SessionStatus =
  | "queued"
  | "provisioning"
  | "running"
  | "cleaning"
  | "stopped"
  | "failed"
  | "cleanup_failed";

export interface SessionRow {
  id: number;
  public_id: string;
  user_id: number;
  template_id: string;
  template_name: string;
  protocol: "rdp" | "vnc";
  proxmox_node: string;
  proxmox_vmid: number;
  proxmox_template_id: number;
  snapshot_name: string;
  guest_ip: string | null;
  guest_port: number;
  guest_username: string | null;
  guest_password: string | null;
  status: SessionStatus;
  failure_reason: string | null;
  created_at: Date;
  last_activity_at: Date;
  hard_expires_at: Date;
  cleaned_up_at: Date | null;
}

export async function createPendingSession(opts: {
  userId: number;
  templateId: string;
  templateName: string;
  protocol: "rdp" | "vnc";
  proxmoxNode: string;
  proxmoxVmid: number;
  proxmoxTemplateId: number;
  snapshotName: string;
  guestPort: number;
  guestUsername: string;
  guestPassword: string;
  initialStatus?: "queued" | "provisioning";
}): Promise<SessionRow> {
  const publicId = nanoid(16);
  const status = opts.initialStatus ?? "queued";
  const row = await one<SessionRow>(
    `INSERT INTO sessions
       (public_id, user_id, template_id, template_name, protocol,
        proxmox_node, proxmox_vmid, proxmox_template_id, snapshot_name,
        guest_port, guest_username, guest_password,
        status, hard_expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
             NOW() + ($14 || ' minutes')::interval)
     RETURNING *`,
    [
      publicId,
      opts.userId,
      opts.templateId,
      opts.templateName,
      opts.protocol,
      opts.proxmoxNode,
      opts.proxmoxVmid,
      opts.proxmoxTemplateId,
      opts.snapshotName,
      opts.guestPort,
      opts.guestUsername,
      opts.guestPassword,
      status,
      String(env.SESSION_HARD_TIMEOUT_MINUTES),
    ]
  );
  if (!row) throw new Error("Failed to create session row");
  return row;
}


export async function createRunningSessionFromStaged(opts: {
  userId: number;
  templateId: string;
  templateName: string;
  protocol: "rdp" | "vnc";
  proxmoxNode: string;
  proxmoxVmid: number;
  proxmoxTemplateId: number;
  snapshotName: string;
  guestIp: string | null;
  guestPort: number;
  guestUsername: string | null;
  guestPassword: string | null;
}): Promise<SessionRow> {
  const publicId = nanoid(16);
  const row = await one<SessionRow>(`INSERT INTO sessions
    (public_id, user_id, template_id, template_name, protocol, proxmox_node, proxmox_vmid, proxmox_template_id, snapshot_name, guest_ip, guest_port, guest_username, guest_password, status, hard_expires_at, last_activity_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'running', NOW() + ($14 || ' minutes')::interval, NOW()) RETURNING *`,
    [publicId, opts.userId, opts.templateId, opts.templateName, opts.protocol, opts.proxmoxNode, opts.proxmoxVmid, opts.proxmoxTemplateId, opts.snapshotName, opts.guestIp, opts.guestPort, opts.guestUsername, opts.guestPassword, String(env.SESSION_HARD_TIMEOUT_MINUTES)]);
  if (!row) throw new Error("Failed to create running session from staged VM");
  return row;
}

export async function markSessionProvisioning(id: number): Promise<void> {
  await query(`UPDATE sessions SET status='provisioning' WHERE id=$1`, [id]);
}

export async function markSessionRunning(id: number, guestIp: string): Promise<void> {
  await query(
    `UPDATE sessions SET status='running', guest_ip=$2, last_activity_at=NOW() WHERE id=$1`,
    [id, guestIp]
  );
}

export async function markSessionFailed(id: number, reason: string): Promise<void> {
  await query(
    `UPDATE sessions SET status='failed', failure_reason=$2 WHERE id=$1`,
    [id, reason]
  );
}

export async function markSessionCleaning(id: number): Promise<void> {
  await query(`UPDATE sessions SET status='cleaning' WHERE id=$1`, [id]);
}

export async function markSessionStopped(id: number): Promise<void> {
  await query(
    `UPDATE sessions SET status='stopped', cleaned_up_at=NOW() WHERE id=$1`,
    [id]
  );
}

export async function markCleanupFailed(id: number, reason: string): Promise<void> {
  await query(
    `UPDATE sessions SET status='cleanup_failed', failure_reason=$2, cleaned_up_at=NOW() WHERE id=$1`,
    [id, reason]
  );
}

export async function touchHeartbeat(id: number): Promise<void> {
  await query(`UPDATE sessions SET last_activity_at=NOW() WHERE id=$1`, [id]);
}

export async function getSessionById(id: number): Promise<SessionRow | null> {
  return one<SessionRow>(`SELECT * FROM sessions WHERE id=$1`, [id]);
}

export async function getSessionByPublicId(publicId: string): Promise<SessionRow | null> {
  return one<SessionRow>(`SELECT * FROM sessions WHERE public_id=$1`, [publicId]);
}

export async function listActiveSessionsForUser(userId: number): Promise<SessionRow[]> {
  return many<SessionRow>(
    `SELECT * FROM sessions
     WHERE user_id=$1 AND status IN ('queued','provisioning','running')
     ORDER BY created_at DESC`,
    [userId]
  );
}

export async function countActiveSessions(): Promise<number> {
  const row = await one<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM sessions
     WHERE status IN ('queued','provisioning','running')`
  );
  return Number(row?.count ?? 0);
}

export async function listStaleSessions(): Promise<SessionRow[]> {
  return many<SessionRow>(
    `SELECT * FROM sessions
     WHERE status IN ('provisioning','running')
       AND (
         last_activity_at < NOW() - ($1 || ' minutes')::interval
         OR hard_expires_at < NOW()
       )`,
    [String(env.SESSION_INACTIVITY_TIMEOUT_MINUTES)]
  );
}

export async function listAllLiveSessions(): Promise<SessionRow[]> {
  return many<SessionRow>(
    `SELECT * FROM sessions WHERE status IN ('queued','provisioning','running','cleaning','cleanup_failed')`
  );
}

export function publicView(s: SessionRow) {
  return {
    id: s.public_id,
    templateId: s.template_id,
    templateName: s.template_name,
    protocol: s.protocol,
    proxmoxNode: s.proxmox_node,
    status: s.status,
    failureReason: s.failure_reason,
    createdAt: s.created_at,
    lastActivityAt: s.last_activity_at,
    hardExpiresAt: s.hard_expires_at,
    guestUsername: s.guest_username,
    guestPassword: s.guest_password,
  };
}

export function logSessionEvent(s: SessionRow, event: string, extra: Record<string, unknown> = {}) {
  logger.info({ sessionId: s.id, publicId: s.public_id, event, ...extra }, "session event");
}
