/**
 * Templates the import wizard created.
 *
 * These are ordinary templates in every respect — staging, cloning and cleanup
 * don't know the difference — they just live in Postgres instead of
 * templates.yaml. That keeps the config mount read-only and means a finished
 * import can put a tile on the dashboard immediately, which is the whole point
 * of the wizard.
 *
 * `refreshImportedTemplates()` is the only writer of the in-memory overlay in
 * config.ts, and must be called after any change here.
 */
import { parseTemplateConfig, setImportedTemplates, TemplateConfig } from "../config";
import { many, one, query } from "../db/client";
import { logger } from "./logger";

interface ImportedTemplateRow {
  id: string;
  name: string;
  description: string;
  icon: string;
  proxmox_template_id: number;
  proxmox_template_ids: Record<string, number> | null;
  snapshot_name: string;
  protocol: string;
  port: number;
  username: string;
  password: string;
  cpu_cores: number;
  memory_mb: number;
  staging_pool_size: number;
  enabled: boolean;
  color: string | null;
  source_import_id: string | null;
  created_at: Date;
}

const SELECT_COLUMNS = `id, name, description, icon, proxmox_template_id, proxmox_template_ids,
  snapshot_name, protocol, port, username, password, cpu_cores, memory_mb,
  staging_pool_size, enabled, color, source_import_id, created_at`;

function toConfig(row: ImportedTemplateRow): TemplateConfig {
  return parseTemplateConfig({
    id: row.id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    proxmox_template_id: row.proxmox_template_id,
    proxmox_template_ids: row.proxmox_template_ids ?? undefined,
    snapshot_name: row.snapshot_name,
    protocol: row.protocol,
    port: row.port,
    username: row.username,
    password: row.password,
    cpu_cores: row.cpu_cores,
    memory_mb: row.memory_mb,
    staging_pool_size: row.staging_pool_size,
    enabled: row.enabled,
    color: row.color ?? undefined,
  });
}

/** Reload from Postgres and republish the overlay that getTemplates() reads. */
export async function refreshImportedTemplates(): Promise<TemplateConfig[]> {
  const rows = await many<ImportedTemplateRow>(
    `SELECT ${SELECT_COLUMNS} FROM imported_templates ORDER BY created_at`
  );

  const parsed: TemplateConfig[] = [];
  for (const row of rows) {
    try {
      parsed.push(toConfig(row));
    } catch (err) {
      // One bad row shouldn't take the dashboard down with it.
      logger.error({ id: row.id, err: String(err) }, "imported template failed validation, skipping");
    }
  }

  setImportedTemplates(parsed);
  return parsed;
}

export interface UpsertImportedTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  proxmoxTemplateId: number;
  proxmoxTemplateIds?: Record<string, number> | null;
  protocol: "rdp" | "vnc";
  port: number;
  username: string;
  password: string;
  cpuCores: number;
  memoryMb: number;
  stagingPoolSize: number;
  enabled?: boolean;
  color?: string | null;
  sourceImportId?: number | null;
}

export async function upsertImportedTemplate(input: UpsertImportedTemplate): Promise<void> {
  await query(
    `INSERT INTO imported_templates
       (id, name, description, icon, proxmox_template_id, proxmox_template_ids, snapshot_name,
        protocol, port, username, password, cpu_cores, memory_mb, staging_pool_size,
        enabled, color, source_import_id)
     VALUES ($1,$2,$3,$4,$5,$6,'',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (id) DO UPDATE SET
       name=EXCLUDED.name,
       description=EXCLUDED.description,
       icon=EXCLUDED.icon,
       proxmox_template_id=EXCLUDED.proxmox_template_id,
       proxmox_template_ids=EXCLUDED.proxmox_template_ids,
       protocol=EXCLUDED.protocol,
       port=EXCLUDED.port,
       username=EXCLUDED.username,
       password=EXCLUDED.password,
       cpu_cores=EXCLUDED.cpu_cores,
       memory_mb=EXCLUDED.memory_mb,
       staging_pool_size=EXCLUDED.staging_pool_size,
       enabled=EXCLUDED.enabled,
       color=EXCLUDED.color,
       source_import_id=EXCLUDED.source_import_id,
       updated_at=NOW()`,
    [
      input.id,
      input.name,
      input.description,
      input.icon,
      input.proxmoxTemplateId,
      input.proxmoxTemplateIds ? JSON.stringify(input.proxmoxTemplateIds) : null,
      input.protocol,
      input.port,
      input.username,
      input.password,
      input.cpuCores,
      input.memoryMb,
      input.stagingPoolSize,
      input.enabled ?? true,
      input.color ?? null,
      input.sourceImportId ?? null,
    ]
  );
  await refreshImportedTemplates();
}

export async function listImportedTemplates(): Promise<ImportedTemplateRow[]> {
  return many<ImportedTemplateRow>(`SELECT ${SELECT_COLUMNS} FROM imported_templates ORDER BY created_at DESC`);
}

export async function getImportedTemplate(id: string): Promise<ImportedTemplateRow | null> {
  return one<ImportedTemplateRow>(`SELECT ${SELECT_COLUMNS} FROM imported_templates WHERE id=$1`, [id]);
}

export async function setImportedTemplateEnabled(id: string, enabled: boolean): Promise<boolean> {
  const row = await one<{ id: string }>(
    `UPDATE imported_templates SET enabled=$2, updated_at=NOW() WHERE id=$1 RETURNING id`,
    [id, enabled]
  );
  if (row) await refreshImportedTemplates();
  return Boolean(row);
}

/** Forget the tile. The Proxmox template VM itself is left alone. */
export async function deleteImportedTemplate(id: string): Promise<boolean> {
  const row = await one<{ id: string }>(`DELETE FROM imported_templates WHERE id=$1 RETURNING id`, [id]);
  if (row) await refreshImportedTemplates();
  return Boolean(row);
}
