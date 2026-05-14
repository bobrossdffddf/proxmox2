import { getTemplates, TemplateConfig } from "../config";
import { many, one, query } from "../db/client";
import { countLiveStagedVms } from "./staging";

export interface StagingTarget {
  templateId: string;
  templateName: string;
  nodes: string[];
  poolSize: number;
  currentReady: number;
  currentLive: number;
}

function configuredPoolSize(template: TemplateConfig): number {
  return Math.max(0, Math.min(20, template.staging_pool_size ?? 1));
}

export async function getStagingPoolSize(template: TemplateConfig): Promise<number> {
  const row = await one<{ pool_size: number }>(
    `SELECT pool_size FROM template_staging_settings WHERE template_id=$1`,
    [template.id]
  );
  return row ? Number(row.pool_size) : configuredPoolSize(template);
}

export async function setStagingPoolSize(templateId: string, poolSize: number): Promise<void> {
  await query(
    `INSERT INTO template_staging_settings (template_id, pool_size, updated_at)
     VALUES ($1,$2,NOW())
     ON CONFLICT (template_id)
     DO UPDATE SET pool_size=EXCLUDED.pool_size, updated_at=NOW()`,
    [templateId, poolSize]
  );
}

export async function listStagingTargets(): Promise<StagingTarget[]> {
  const templates = getTemplates().filter((template) => template.enabled);
  const settings = await many<{ template_id: string; pool_size: number }>(
    `SELECT template_id, pool_size FROM template_staging_settings`
  );
  const overrides = new Map(settings.map((setting) => [setting.template_id, Number(setting.pool_size)]));

  return Promise.all(templates.map(async (template) => {
    const nodes = template.proxmox_template_ids ? Object.keys(template.proxmox_template_ids) : ["any reachable node"];
    const poolSize = overrides.get(template.id) ?? configuredPoolSize(template);
    let currentReady = 0;
    let currentLive = 0;

    for (const node of template.proxmox_template_ids ? nodes : [undefined]) {
      const live = await countLiveStagedVms(template.id, node);
      currentLive += live;
      currentReady += live;
    }

    return {
      templateId: template.id,
      templateName: template.name,
      nodes,
      poolSize,
      currentReady,
      currentLive,
    };
  }));
}
