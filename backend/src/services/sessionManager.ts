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
  extended_minutes: number;
  notes: string | null;
  demo_active: boolean;
  demo_title: string | null;
  demo_started_at: Date | null;
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
  // Clearing demo_active here keeps a finished demo from lingering in the
  // one-live-demo slot after its VM is gone.
  await query(
    `UPDATE sessions SET status='stopped', cleaned_up_at=NOW(), demo_active=FALSE WHERE id=$1`,
    [id]
  );
}

export async function markCleanupFailed(id: number, reason: string): Promise<void> {
  await query(
    `UPDATE sessions SET status='cleanup_failed', failure_reason=$2, cleaned_up_at=NOW(), demo_active=FALSE WHERE id=$1`,
    [id, reason]
  );
}

export async function touchHeartbeat(id: number): Promise<void> {
  await query(`UPDATE sessions SET last_activity_at=NOW() WHERE id=$1`, [id]);
}

/**
 * One-time extension of the hard expiry. Returns the updated row, or null if
 * the session isn't running or was already extended.
 */
export async function extendSession(id: number, minutes: number): Promise<SessionRow | null> {
  return one<SessionRow>(
    `UPDATE sessions
     SET hard_expires_at = hard_expires_at + ($2 || ' minutes')::interval,
         extended_minutes = extended_minutes + $2
     WHERE id=$1 AND status='running' AND extended_minutes = 0
     RETURNING *`,
    [id, String(minutes)]
  );
}

export async function setSessionNotes(id: number, notes: string): Promise<void> {
  await query(`UPDATE sessions SET notes=$2 WHERE id=$1`, [id, notes]);
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

// ---------------------------------------------------------------------------
// Demo mode
//
// An admin can flip one of their own running sessions into a live demo. Every
// signed-in user then gets a read-only spectator link to it. Exactly one demo
// can be live at a time - the sessions_single_demo_unique partial index in the
// schema enforces that at the database level, and startDemo switches the
// previous one off first rather than relying on the caller to remember.
// ---------------------------------------------------------------------------

export interface DemoView {
  sessionId: string;
  templateName: string;
  title: string | null;
  host: string;
  startedAt: Date | null;
}

export async function startDemo(sessionId: number, title: string | null): Promise<SessionRow | null> {
  await query(`UPDATE sessions SET demo_active=FALSE WHERE demo_active AND id <> $1`, [sessionId]);
  return one<SessionRow>(
    `UPDATE sessions
        SET demo_active = TRUE,
            demo_title = $2,
            demo_started_at = COALESCE(demo_started_at, NOW())
      WHERE id = $1 AND status = 'running'
      RETURNING *`,
    [sessionId, title]
  );
}

export async function stopDemo(sessionId: number): Promise<void> {
  await query(
    `UPDATE sessions SET demo_active=FALSE, demo_title=NULL, demo_started_at=NULL WHERE id=$1`,
    [sessionId]
  );
}

/**
 * The one live demo, if there is one. Scoped to `running` so a demo whose VM
 * has since been stopped or expired stops being advertised on the dashboard
 * even if nobody remembered to switch it off.
 */
export async function getLiveDemo(): Promise<(SessionRow & { username: string }) | null> {
  return one<SessionRow & { username: string }>(
    `SELECT s.*, u.username
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.demo_active AND s.status = 'running'
      LIMIT 1`
  );
}

export function demoView(s: SessionRow & { username: string }): DemoView {
  return {
    sessionId: s.public_id,
    templateName: s.template_name,
    title: s.demo_title,
    host: s.username,
    startedAt: s.demo_started_at,
  };
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
    extendedMinutes: s.extended_minutes ?? 0,
    notes: s.notes,
    demoActive: s.demo_active ?? false,
    demoTitle: s.demo_title ?? null,
  };
}

/**
 * What a spectator is allowed to see. Watching someone's screen is one thing;
 * being handed their VM's login is another, and demo spectators are ordinary
 * students. Credentials and debrief notes are stripped here rather than merely
 * hidden in the UI.
 */
export function spectatorView(s: SessionRow) {
  return {
    ...publicView(s),
    guestUsername: null,
    guestPassword: null,
    notes: null,
  };
}

export function logSessionEvent(s: SessionRow, event: string, extra: Record<string, unknown> = {}) {
  logger.info({ sessionId: s.id, publicId: s.public_id, event, ...extra }, "session event");
}
