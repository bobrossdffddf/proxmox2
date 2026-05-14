import { env, getTemplates } from "../config";
import { provisioningQueue } from "../jobs/queues";
import { countActiveSessions } from "./sessionManager";
import { countAllLiveStagedVms, countLiveStagedVms } from "./staging";
import { logger } from "./logger";

const STAGED_TARGET_PER_TEMPLATE = 1;

async function ensureStagedVmForNode(templateId: string, node?: string): Promise<void> {
  const liveForTemplate = await countLiveStagedVms(templateId, node);
  if (liveForTemplate >= STAGED_TARGET_PER_TEMPLATE) return;

  const physicalCount = (await countActiveSessions()) + (await countAllLiveStagedVms());
  if (physicalCount >= env.MAX_CLUSTER_VMS) {
    logger.warn({ templateId, physicalCount, max: env.MAX_CLUSTER_VMS }, "staging skipped: cluster at capacity");
    return;
  }

  const jobId = node ? `stage-${templateId}-${node}` : `stage-${templateId}`;
  const existingJob = await provisioningQueue.getJob(jobId);
  if (existingJob) {
    const state = await existingJob.getState();
    if (!["completed", "failed", "unknown"].includes(state)) return;
    await existingJob.remove().catch(() => undefined);
  }

  await provisioningQueue.add("stage", { templateId, staged: true, targetNode: node }, { jobId });
}

export async function ensureStagedVm(templateId: string): Promise<void> {
  const template = getTemplates().find((item) => item.id === templateId);
  const nodes = template?.proxmox_template_ids ? Object.keys(template.proxmox_template_ids) : [undefined];
  for (const node of nodes) {
    await ensureStagedVmForNode(templateId, node);
  }
}

export async function ensureAllStagedVms(): Promise<void> {
  const templates = getTemplates().filter((template) => template.enabled);
  for (const template of templates) {
    await ensureStagedVm(template.id);
  }
}
