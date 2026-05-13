import { env, getTemplates } from "../config";
import { provisioningQueue } from "../jobs/queues";
import { countActiveSessions } from "./sessionManager";
import { countAllLiveStagedVms, countLiveStagedVms } from "./staging";
import { logger } from "./logger";

const STAGED_TARGET_PER_TEMPLATE = 1;

export async function ensureStagedVm(templateId: string): Promise<void> {
  const liveForTemplate = await countLiveStagedVms(templateId);
  if (liveForTemplate >= STAGED_TARGET_PER_TEMPLATE) return;

  const physicalCount = (await countActiveSessions()) + (await countAllLiveStagedVms());
  if (physicalCount >= env.MAX_CLUSTER_VMS) {
    logger.warn({ templateId, physicalCount, max: env.MAX_CLUSTER_VMS }, "staging skipped: cluster at capacity");
    return;
  }

  const jobId = `stage-${templateId}`;
  const existingJob = await provisioningQueue.getJob(jobId);
  if (existingJob) {
    const state = await existingJob.getState();
    if (!["completed", "failed", "unknown"].includes(state)) return;
    await existingJob.remove().catch(() => undefined);
  }

  await provisioningQueue.add("stage", { templateId, staged: true }, { jobId });
}

export async function ensureAllStagedVms(): Promise<void> {
  const templates = getTemplates().filter((template) => template.enabled);
  for (const template of templates) {
    await ensureStagedVm(template.id);
  }
}
