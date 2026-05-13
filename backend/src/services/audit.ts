/**
 * Audit log writer. Every meaningful action goes here.
 */
import { query } from "../db/client";

export interface AuditEntry {
  userId?: number | null;
  username?: string | null;
  action: string;
  sessionId?: number | null;
  ipAddress?: string | null;
  details?: Record<string, unknown>;
}

export async function audit(entry: AuditEntry): Promise<void> {
  await query(
    `INSERT INTO audit_log (user_id, username, action, session_id, ip_address, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      entry.userId ?? null,
      entry.username ?? null,
      entry.action,
      entry.sessionId ?? null,
      entry.ipAddress ?? null,
      JSON.stringify(entry.details ?? {}),
    ]
  );
}
