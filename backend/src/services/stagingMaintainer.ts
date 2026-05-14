import { env, getTemplates } from "../config";
import { provisioningQueue } from "../jobs/queues";
import { countActiveSessions } from "./sessionManager";
import { countAllLiveStagedVms, countLiveStagedVms } from "./staging";
import { getStagingPoolSize } from "./stagingSettings";
import { logger } from "./logger";

async function ensureStagedVmForNode(templateId: string, targetCount: number, node?: string): Promise<void> {
  const liveForTemplate = await countLiveStagedVms(templateId, node);
  if (liveForTemplate >= targetCount) return;

  const physicalCount = (await countActiveSessions()) + (await countAllLiveStagedVms());
  if (physicalCount >= env.MAX_CLUSTER_VMS) {
    logger.warn({ templateId, physicalCount, max: env.MAX_CLUSTER_VMS }, "staging skipped: cluster at capacity");
    return;
  }

  const missing = targetCount - liveForTemplate;
  const availableCapacity = Math.max(0, env.MAX_CLUSTER_VMS - physicalCount);
  const jobsToQueue = Math.min(missing, availableCapacity);

  for (let slot = liveForTemplate; slot < liveForTemplate + jobsToQueue; slot += 1) {
    const jobId = node ? `stage-${templateId}-${node}-${slot}` : `stage-${templateId}-${slot}`;
    const existingJob = await provisioningQueue.getJob(jobId);
    if (existingJob) {
      const state = await existingJob.getState();
      if (!["completed", "failed", "unknown"].includes(state)) continue;
      await existingJob.remove().catch(() => undefined);
    }

    await provisioningQueue.add("stage", { templateId, staged: true, targetNode: node }, { jobId });
  }
}

export async function ensureStagedVm(templateId: string): Promise<void> {
  const template = getTemplates().find((item) => item.id === templateId);
  if (!template) return;
  const targetCount = await getStagingPoolSize(template);
  if (targetCount <= 0) return;
  const nodes = template?.proxmox_template_ids ? Object.keys(template.proxmox_template_ids) : [undefined];
  for (const node of nodes) {
    await ensureStagedVmForNode(templateId, targetCount, node);
  }
}

export async function ensureAllStagedVms(): Promise<void> {
  const templates = getTemplates().filter((template) => template.enabled);
  for (const template of templates) {
    await ensureStagedVm(template.id);
  }
}
