/**
 * Provisioning worker. Steps:
 *
 *   1. Re-validate quotas (something might have changed between request and
 *      the worker picking the job up).
 *   2. Look up the template config.
 *   3. Pick the least-loaded Proxmox node.
 *   4. Allocate a free VMID.
 *   5. Clone the template (linked clone -> instant).
 *   6. Apply per-template CPU + memory overrides.
 *   7. Power the VM on.
 *   8. Wait for the QEMU guest agent to report an IP.
 *   9. Insert the session row with status='running'.
 *   10. Schedule the hard-timeout cleanup job.
 *
 * Any failure marks the session 'failed' and frees the VMID. If the clone
 * already happened, we also enqueue a cleanup job so the orphaned VM is
 * removed.
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
  markSessionRunning,
} from "../services/sessionManager";
import { allocateVmid, releaseVmid } from "../services/vmidPool";
import { cleanupQueue, ProvisioningJobData } from "./queues";

export function startProvisioningWorker(): Worker<ProvisioningJobData> {
  const worker = new Worker<ProvisioningJobData>(
    "vm-provisioning",
    async (job) => {
      const { userId, templateId } = job.data;
      logger.info({ jobId: job.id, userId, templateId }, "provisioning job start");

      // 1. Re-check quotas
      const active = await listActiveSessionsForUser(userId);
      if (active.length >= env.MAX_VMS_PER_USER) {
        throw new Error(`User already has ${active.length}/${env.MAX_VMS_PER_USER} active VMs`);
      }
      const clusterCount = await countActiveSessions();
      if (clusterCount >= env.MAX_CLUSTER_VMS) {
        throw new Error(`Cluster at capacity (${clusterCount}/${env.MAX_CLUSTER_VMS})`);
      }

      // 2. Template lookup
      const template = getTemplate(templateId);
      if (!template || !template.enabled) {
        throw new Error(`Unknown or disabled template: ${templateId}`);
      }

      // 3. Pick a node.
      //
      // Linked clones (full=0) can't cross node boundaries unless the storage
      // is shared (Ceph/NFS). So we have to clone on the node that actually
      // owns the template. We look that up via /cluster/resources and use it,
      // ignoring the load balancer's pick.
      //
      // If you migrate to shared storage later, you can drop the lookup and
      // use selectLeastLoadedNode() directly with a target= parameter to
      // route clones to the lowest-loaded node.
      const templateNode = await proxmox.findVmNode(template.proxmox_template_id);
      if (!templateNode) {
        throw new Error(
          `Could not find template VMID ${template.proxmox_template_id} on any node in the cluster`
        );
      }
      const node = templateNode;
      logger.info({ vmId: template.proxmox_template_id, node }, "template located, cloning here");

      // 4. VMID
      const vmId = await allocateVmid();

      // Track whether we got far enough that an orphan cleanup is needed.
      let cloned = false;

      try {
        // 5. Clone
        // Proxmox VM names follow DNS hostname rules: letters, digits, and
        // hyphens only. We strip everything else (the template id can contain
        // underscores per our own config schema, but those are illegal here).
        const safe = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "-");
        const vmName = `wcta-${safe(templateId)}-${userId}-${vmId}`.slice(0, 60);
        const cloneUpid = await proxmox.cloneTemplate({
          node,
          templateId: template.proxmox_template_id,
          newVmId: vmId,
          name: vmName,
        });
        await proxmox.waitForTask(node, cloneUpid, 180_000);
        cloned = true;
        logger.info({ vmId, node }, "clone complete");

        // 6. Resources
        await proxmox.setResources({
          node,
          vmId,
          cores: template.cpu_cores,
          memoryMb: template.memory_mb,
        });

        // 7. Power on
        const startUpid = await proxmox.powerOn(node, vmId);
        await proxmox.waitForTask(node, startUpid, 60_000);
        logger.info({ vmId, node }, "powered on");

        // 8. Wait for IP
        const ip = await proxmox.waitForGuestIp(node, vmId, 240_000);
        logger.info({ vmId, ip }, "guest IP available");

        // 9. Session row
        const session = await createPendingSession({
          userId,
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
        });
        await markSessionRunning(session.id, ip);
        logSessionEvent(session, "running");

        await audit({
          userId,
          action: "vm.provisioned",
          sessionId: session.id,
          details: { templateId, vmId, node, ip },
        });

        // 10. Hard-timeout cleanup
        await cleanupQueue.add(
          "cleanup",
          { sessionId: session.id, reason: "hard_timeout" },
          { delay: env.SESSION_HARD_TIMEOUT_MINUTES * 60 * 1000 }
        );

        return { sessionId: session.id, publicId: session.public_id };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.error({ vmId, node, err: reason }, "provisioning failed");

        // If we got as far as cloning, we have an orphan to clean up. Insert
        // a minimal session row so the cleanup worker has something to act on.
        if (cloned) {
          try {
            const orphan = await createPendingSession({
              userId,
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
            });
            await markSessionFailed(orphan.id, reason);
            await cleanupQueue.add("cleanup-orphan", {
              sessionId: orphan.id,
              reason: "provisioning_failed",
            });
          } catch (cleanupErr) {
            logger.error({ err: String(cleanupErr) }, "failed to enqueue orphan cleanup");
          }
        } else {
          await releaseVmid(vmId);
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
