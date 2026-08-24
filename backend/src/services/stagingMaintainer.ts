import { env, getTemplates } from "../config";
import { provisioningQueue } from "../jobs/queues";
import { countActiveSessions } from "./sessionManager";
import { countAllLiveStagedVms, countLiveStagedVms } from "./staging";
import { getStagingPoolSize } from "./stagingSettings";
import { recordStagingFailure } from "./stagingHealth";
import { logger } from "./logger";

/**
 * How long a staging job may sit in a non-terminal state before we treat it as
 * wedged and replace it. A cold clone plus a Windows boot plus the guest-agent
 * IP wait tops out around six minutes, so anything past this is not progress.
 *
 * This exists because a job stuck in `active` (worker killed mid-clone, Redis
 * blip, a Proxmox call with no timeout) used to pin its jobId forever: the
 * maintainer saw a live job, skipped it, and the template's tile sat on
 * "Warming up" until someone restarted the backend.
 */
const STAGING_JOB_STALL_MS = 12 * 60 * 1000;

/** Job states that mean the job is finished and its slot is free to reuse. */
const TERMINAL_STATES = new Set(["completed", "failed", "unknown"]);

async function ensureStagedVmForNode(templateId: string, targetCount: number, node?: string): Promise<void> {
  const liveForTemplate = await countLiveStagedVms(templateId, node);
  if (liveForTemplate >= targetCount) return;

  const physicalCount = (await countActiveSessions()) + (await countAllLiveStagedVms());
  if (physicalCount >= env.MAX_CLUSTER_VMS) {
    logger.warn({ templateId, physicalCount, max: env.MAX_CLUSTER_VMS }, "staging skipped: cluster at capacity");
    await recordStagingFailure(
      templateId,
      `Cluster is at capacity (${physicalCount}/${env.MAX_CLUSTER_VMS}) - no room to stage a warm VM.`
    );
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
      if (!TERMINAL_STATES.has(state)) {
        // Non-terminal, but is it actually moving? A job whose timestamp is
        // older than the stall window is not coming back; drop it so the slot
        // can be re-queued on this pass instead of being skipped forever.
        const startedAt = existingJob.processedOn ?? existingJob.timestamp ?? 0;
        const ageMs = Date.now() - startedAt;
        if (ageMs < STAGING_JOB_STALL_MS) continue;

        logger.warn(
          { templateId, jobId, state, ageMinutes: Math.round(ageMs / 60_000) },
          "staging job appears stalled - discarding and re-queueing"
        );
        await recordStagingFailure(
          templateId,
          `A staging job was stuck in "${state}" for ${Math.round(ageMs / 60_000)} minutes and was restarted.`
        );
      }
      await existingJob.remove().catch((err) => {
        logger.warn({ jobId, err: String(err) }, "could not remove stale staging job");
      });
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
    try {
      await ensureStagedVmForNode(templateId, targetCount, node);
    } catch (err) {
      // One unreachable node must not stop the other nodes, or the other
      // templates, from being topped up.
      const reason = err instanceof Error ? err.message : String(err);
      logger.error({ templateId, node, err: reason }, "staging top-up failed");
      await recordStagingFailure(templateId, reason).catch(() => undefined);
    }
  }
}

export async function ensureAllStagedVms(): Promise<void> {
  const templates = getTemplates().filter((template) => template.enabled);
  for (const template of templates) {
    await ensureStagedVm(template.id);
  }
}
