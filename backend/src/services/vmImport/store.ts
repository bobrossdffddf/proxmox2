/**
 * Persistence for import jobs.
 *
 * An import outlives any one HTTP request — uploading 40 GB and converting it
 * takes long enough that the admin will close the tab — so every state change
 * lands in Postgres and the UI polls. The log table is what the wizard renders
 * as a live console.
 */
import { nanoid } from "nanoid";
import { many, one, query } from "../../db/client";
import type { BundleInspection, ImportSettings, ImportStage, ImportStatus } from "./types";

export interface ImportRow {
  id: number;
  public_id: string;
  original_filename: string;
  upload_path: string | null;
  upload_bytes: string;
  status: ImportStatus;
  stage: ImportStage;
  progress: number;
  inspection: BundleInspection | null;
  settings: ImportSettings | null;
  result: ImportResult | null;
  error: string | null;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

export interface ImportResult {
  vmid: number;
  node: string;
  templateId: string | null;
  storage: string;
  disks: string[];
  durationMs: number;
}

export interface ImportLogRow {
  id: string;
  level: "info" | "warn" | "error";
  message: string;
  created_at: Date;
}

const COLUMNS = `id, public_id, original_filename, upload_path, upload_bytes, status, stage,
  progress, inspection, settings, result, error, created_by, created_at, updated_at, finished_at`;

export async function createImport(input: {
  originalFilename: string;
  createdBy: number | null;
}): Promise<ImportRow> {
  const row = await one<ImportRow>(
    `INSERT INTO vm_imports (public_id, original_filename, created_by)
     VALUES ($1,$2,$3)
     RETURNING ${COLUMNS}`,
    [nanoid(16), input.originalFilename, input.createdBy]
  );
  if (!row) throw new Error("Failed to create import record");
  return row;
}

export async function getImport(id: number): Promise<ImportRow | null> {
  return one<ImportRow>(`SELECT ${COLUMNS} FROM vm_imports WHERE id=$1`, [id]);
}

export async function getImportByPublicId(publicId: string): Promise<ImportRow | null> {
  return one<ImportRow>(`SELECT ${COLUMNS} FROM vm_imports WHERE public_id=$1`, [publicId]);
}

export async function listImports(limit = 25): Promise<ImportRow[]> {
  return many<ImportRow>(`SELECT ${COLUMNS} FROM vm_imports ORDER BY created_at DESC LIMIT $1`, [limit]);
}

/** Imports that were mid-flight when the backend restarted. */
export async function listUnfinishedImports(): Promise<ImportRow[]> {
  return many<ImportRow>(
    `SELECT ${COLUMNS} FROM vm_imports WHERE status IN ('queued','running') ORDER BY created_at`
  );
}

export async function setUploadResult(id: number, uploadPath: string, bytes: number): Promise<void> {
  await query(
    `UPDATE vm_imports SET upload_path=$2, upload_bytes=$3, updated_at=NOW() WHERE id=$1`,
    [id, uploadPath, bytes]
  );
}

export async function setInspection(id: number, inspection: BundleInspection): Promise<void> {
  await query(
    `UPDATE vm_imports
     SET inspection=$2, status='ready', stage='inspect', progress=0, updated_at=NOW()
     WHERE id=$1`,
    [id, JSON.stringify(inspection)]
  );
}

export async function setSettings(id: number, settings: ImportSettings): Promise<void> {
  await query(`UPDATE vm_imports SET settings=$2, updated_at=NOW() WHERE id=$1`, [
    id,
    JSON.stringify(settings),
  ]);
}

export async function setStatus(id: number, status: ImportStatus): Promise<void> {
  await query(`UPDATE vm_imports SET status=$2, updated_at=NOW() WHERE id=$1`, [id, status]);
}

export async function setStage(id: number, stage: ImportStage, progress: number): Promise<void> {
  await query(
    `UPDATE vm_imports SET stage=$2, progress=$3, status='running', updated_at=NOW() WHERE id=$1`,
    [id, stage, Math.max(0, Math.min(100, Math.round(progress)))]
  );
}

export async function setProgress(id: number, progress: number): Promise<void> {
  await query(`UPDATE vm_imports SET progress=$2, updated_at=NOW() WHERE id=$1`, [
    id,
    Math.max(0, Math.min(100, Math.round(progress))),
  ]);
}

export async function markSucceeded(id: number, result: ImportResult): Promise<void> {
  await query(
    `UPDATE vm_imports
     SET status='succeeded', stage='done', progress=100, result=$2, error=NULL,
         updated_at=NOW(), finished_at=NOW()
     WHERE id=$1`,
    [id, JSON.stringify(result)]
  );
}

export async function markFailed(id: number, error: string): Promise<void> {
  await query(
    `UPDATE vm_imports SET status='failed', error=$2, updated_at=NOW(), finished_at=NOW() WHERE id=$1`,
    [id, error.slice(0, 8000)]
  );
}

export async function markCancelled(id: number, reason: string): Promise<void> {
  await query(
    `UPDATE vm_imports SET status='cancelled', error=$2, updated_at=NOW(), finished_at=NOW() WHERE id=$1`,
    [id, reason]
  );
}

export async function deleteImport(id: number): Promise<void> {
  await query(`DELETE FROM vm_imports WHERE id=$1`, [id]);
}

export async function appendLog(
  id: number,
  level: "info" | "warn" | "error",
  message: string
): Promise<void> {
  await query(`INSERT INTO vm_import_log (import_id, level, message) VALUES ($1,$2,$3)`, [
    id,
    level,
    message.slice(0, 4000),
  ]);
}

/** Log lines newer than `sinceId`, so the UI can poll for just the tail. */
export async function getLog(id: number, sinceId = 0, limit = 500): Promise<ImportLogRow[]> {
  return many<ImportLogRow>(
    `SELECT id, level, message, created_at
     FROM vm_import_log
     WHERE import_id=$1 AND id > $2
     ORDER BY id
     LIMIT $3`,
    [id, sinceId, limit]
  );
}
