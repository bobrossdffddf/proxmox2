/**
 * Staging health. The warm-pool maintainer used to fail silently: if a
 * template could not be staged - bad snapshot name, template VMID missing on
 * the node, guest agent never handing back an IP - the tile just said
 * "Warming up" forever and the only trace was a line in the backend log.
 *
 * Every staging attempt now records its outcome here, keyed by template, so
 * the dashboard tile and the admin staging tab can show the real reason.
 */
import { many, one, query } from "../db/client";

export interface StagingHealthRow {
  template_id: string;
  consecutive_failures: number;
  last_error: string | null;
  last_error_at: Date | null;
  last_success_at: Date | null;
  updated_at: Date;
}

/** Keep messages short enough to read on a tile without truncating mid-word. */
function trimReason(reason: string): string {
  const flat = reason.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 297)}...` : flat;
}

export async function recordStagingSuccess(templateId: string): Promise<void> {
  await query(
    `INSERT INTO template_staging_health
       (template_id, consecutive_failures, last_error, last_error_at, last_success_at, updated_at)
     VALUES ($1, 0, NULL, NULL, NOW(), NOW())
     ON CONFLICT (template_id) DO UPDATE
       SET consecutive_failures = 0,
           last_error           = NULL,
           last_error_at        = NULL,
           last_success_at      = NOW(),
           updated_at           = NOW()`,
    [templateId]
  );
}

export async function recordStagingFailure(templateId: string, reason: string): Promise<void> {
  await query(
    `INSERT INTO template_staging_health
       (template_id, consecutive_failures, last_error, last_error_at, updated_at)
     VALUES ($1, 1, $2, NOW(), NOW())
     ON CONFLICT (template_id) DO UPDATE
       SET consecutive_failures = template_staging_health.consecutive_failures + 1,
           last_error           = $2,
           last_error_at        = NOW(),
           updated_at           = NOW()`,
    [templateId, trimReason(reason)]
  );
}

export async function getStagingHealth(templateId: string): Promise<StagingHealthRow | null> {
  return one<StagingHealthRow>(
    `SELECT * FROM template_staging_health WHERE template_id=$1`,
    [templateId]
  );
}

export async function listStagingHealth(): Promise<Map<string, StagingHealthRow>> {
  const rows = await many<StagingHealthRow>(`SELECT * FROM template_staging_health`);
  return new Map(rows.map((row) => [row.template_id, row]));
}

export async function clearStagingHealth(templateId: string): Promise<void> {
  await query(
    `UPDATE template_staging_health
        SET consecutive_failures = 0, last_error = NULL, last_error_at = NULL, updated_at = NOW()
      WHERE template_id = $1`,
    [templateId]
  );
}
