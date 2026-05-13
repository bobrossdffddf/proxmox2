/**
 * Provisioning worker. User clicks should normally never reach this worker:
 * staging keeps one booted VM per template ready, and requests claim those
 * VMs directly. This worker is still used to prepare replacement staged VMs.
 */
import { Worker } from "bullmq";
import { env, getTemplate } from "../config";
import { audit } from "../services/audit";
import { logger } from "../services/logger";
import { proxmox } from "../services/proxmox";
import { redis } from "../services/redis";
import {
  countActiveSessions,
  createPendingSession,
  listActiveSessionsForUser,
  logSessionEvent,
  markSessionFailed,
  markSessionProvisioning,
  markSessionRunning,
} from "../services/sessionManager";
import { insertStagedVm, markStagedProvisioning, markStagedRunning } from "../services/staging";
import { countAllLiveStagedVms } from "../services/staging";
import { allocateVmid, releaseVmid } from "../services/vmidPool";
import { cleanupQueue, ProvisioningJobData } from "./queues";

export function startProvisioningWorker(): Worker<ProvisioningJobData> {
  const worker = new Worker<ProvisioningJobData>(
    "vm-provisioning",
    async (job) => {
      const { userId, templateId, staged } = job.data;
      logger.info({ jobId: job.id, userId, templateId, staged }, "provisioning job start");

      if (!staged) {
        if (!userId) throw new Error("userId required for user provisioning");
        const active = await listActiveSessionsForUser(userId);
        if (active.length >= env.MAX_VMS_PER_USER) {
          throw new Error(`User already has ${active.length}/${env.MAX_VMS_PER_USER} active VMs`);
        }
      }

      const physicalCount = (await countActiveSessions()) + (await countAllLiveStagedVms());
      if (physicalCount >= env.MAX_CLUSTER_VMS) {
        throw new Error(`Cluster at capacity (${physicalCount}/${env.MAX_CLUSTER_VMS})`);
      }

      const template = getTemplate(templateId);
      if (!template || !template.enabled) {
        throw new Error(`Unknown or disabled template: ${templateId}`);
      }

      const templateNode = await proxmox.findVmNode(template.proxmox_template_id);
      if (!templateNode) {
        throw new Error(
          `Could not find template VMID ${template.proxmox_template_id} on any node in the cluster`
        );
      }
      const node = templateNode;
      const vmId = await allocateVmid();

      const session = staged
        ? null
        : await createPendingSession({
            userId: userId!,
            templateId: template.id,
            templateName: template.name,
            protocol: template.protocol,
            proxmoxNode: node,
            proxmoxVmid: vmId,
            proxmoxTemplateId: template.proxmox_template_id,
            snapshotName: template.snapshot_name,
            guestPort: template.port,
            guestUsername: template.username,
            guestPassword: template.password,
            initialStatus: "queued",
          });
      if (session) logSessionEvent(session, "queued");

      let cloned = false;

      try {
        if (session) {
          await markSessionProvisioning(session.id);
          logSessionEvent(session, "provisioning");
        }

        const safe = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "-");
        const owner = staged ? "staged" : `user-${userId}`;
        const vmName = `wcta-${safe(templateId)}-${owner}-${vmId}`.slice(0, 60);
        const cloneUpid = await proxmox.cloneTemplate({
          node,
          templateId: template.proxmox_template_id,
          newVmId: vmId,
          name: vmName,
        });
        await proxmox.waitForTask(node, cloneUpid, 180_000);
        cloned = true;

        await proxmox.setResources({
          node,
          vmId,
          cores: template.cpu_cores,
          memoryMb: template.memory_mb,
        });

        const noteLines = [
          `Requested by: ${userId ? `user#${userId}` : "staging-system"}`,
          `Template: ${templateId}`,
          `Node: ${node}`,
          `VMID: ${vmId}`,
          `Job: ${job.id}`,
          `Created: ${new Date().toISOString()}`,
        ];
        await proxmox.setDescription(node, vmId, noteLines.join("\n"));

        const startUpid = await proxmox.powerOn(node, vmId);
        await proxmox.waitForTask(node, startUpid, 60_000);
        const ip = await proxmox.waitForGuestIp(node, vmId, 240_000);

        if (staged) {
          const stagedRow = await insertStagedVm({
            template_id: template.id,
            template_name: template.name,
            protocol: template.protocol,
            proxmox_node: node,
            proxmox_vmid: vmId,
            proxmox_template_id: template.proxmox_template_id,
            snapshot_name: template.snapshot_name,
            guest_port: template.port,
            guest_username: template.username,
            guest_password: template.password,
          });
          await markStagedProvisioning(stagedRow.id);
          await markStagedRunning(stagedRow.id, ip);
          await audit({
            userId: null,
            action: "vm.staged",
            details: { templateId, vmId, node, ip },
          });
          return { stagedId: stagedRow.id, vmId };
        }

        await markSessionRunning(session!.id, ip);
        logSessionEvent(session!, "running");
        await audit({
          userId: userId ?? null,
          action: "vm.provisioned",
          sessionId: session!.id,
          details: { templateId, vmId, node, ip },
        });
        await cleanupQueue.add(
          "cleanup",
          { sessionId: session!.id, reason: "hard_timeout" },
          { delay: env.SESSION_HARD_TIMEOUT_MINUTES * 60 * 1000 }
        );

        return { sessionId: session!.id, publicId: session!.public_id };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.error({ vmId, node, staged, err: reason }, "provisioning failed");

        if (session) await markSessionFailed(session.id, reason);
        await audit({
          userId: userId ?? null,
          action: staged ? "vm.stage_failed" : "vm.provisioned_failed",
          sessionId: session?.id ?? null,
          details: { templateId, vmId, error: reason },
        });

        if (cloned && session) {
          await cleanupQueue.add("cleanup-orphan", {
            sessionId: session.id,
            reason: "provisioning_failed",
          }).catch((cleanupErr) => {
            logger.error({ err: String(cleanupErr) }, "failed to enqueue orphan cleanup");
          });
        } else if (cloned) {
          await proxmox.deleteVM(node, vmId).then((deleteUpid) => {
            return proxmox.waitForTask(node, deleteUpid, 120_000);
          }).catch((cleanupErr) => {
            logger.error({ vmId, err: String(cleanupErr) }, "failed to delete failed staged VM");
          });
          await releaseVmid(vmId).catch(() => undefined);
        } else {
          await releaseVmid(vmId).catch(() => undefined);
        }

        throw err;
      }
    },
    {
      connection: redis,
      concurrency: 4,
    }
  );

  worker.on("failed", (job, err) => {
    logger.warn({ jobId: job?.id, err: String(err) }, "provisioning job failed");
  });

  return worker;
}
