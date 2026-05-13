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
import { env, getTemplate, getNodes } from "../config";
import { audit } from "../services/audit";
import { logger } from "../services/logger";
import { proxmox } from "../services/proxmox";
import { redis } from "../services/redis";
import {
  countActiveSessions,
  createPendingSession,
  createRunningSessionFromStaged,
  listActiveSessionsForUser,
  logSessionEvent,
  markSessionFailed,
  markSessionProvisioning,
  markSessionRunning,
} from "../services/sessionManager";
import { allocateVmid, releaseVmid } from "../services/vmidPool";
import { cleanupQueue, ProvisioningJobData, provisioningQueue } from "./queues";
 codex/add-progress-bar-and-vm-staging-features-l2eu01
import { insertStagedVm, markStagedProvisioning, markStagedRunning } from "../services/staging";
odex/add-progress-bar-and-vm-staging-features-7nboq7
import { insertStagedVm, markStagedProvisioning, markStagedRunning } from "../services/staging";
import { countLiveStagedVms, insertStagedVm, markStagedFailed, markStagedProvisioning, markStagedRunning } from "../services/staging";
 main
 main

export function startProvisioningWorker(): Worker<ProvisioningJobData> {
  const worker = new Worker<ProvisioningJobData>(
    "vm-provisioning",
    async (job) => {
 codex/add-progress-bar-and-vm-staging-features-l2eu01
      const { userId, templateId, staged, stagedVm } = job.data;
codex/add-progress-bar-and-vm-staging-features-7nboq7
      const { userId, templateId, staged, stagedVm } = job.data;
      const { userId, templateId, staged } = job.data;
main
 main
      logger.info({ jobId: job.id, userId, templateId }, "provisioning job start");

      if (stagedVm && userId) {
        const s = await createRunningSessionFromStaged({
          userId,
          templateId: stagedVm.template_id,
          templateName: stagedVm.template_name,
          protocol: stagedVm.protocol,
          proxmoxNode: stagedVm.proxmox_node,
          proxmoxVmid: stagedVm.proxmox_vmid,
          proxmoxTemplateId: stagedVm.proxmox_template_id,
          snapshotName: stagedVm.snapshot_name,
          guestIp: stagedVm.guest_ip,
          guestPort: stagedVm.guest_port,
          guestUsername: stagedVm.guest_username,
          guestPassword: stagedVm.guest_password,
        });
        await cleanupQueue.add("cleanup", { sessionId: s.id, reason: "hard_timeout" }, { delay: env.SESSION_HARD_TIMEOUT_MINUTES * 60 * 1000 });
        if ((await countActiveSessions()) < env.MAX_CLUSTER_VMS) {
          await provisioningQueue.add("stage", { templateId: stagedVm.template_id, staged: true });
        }
        return { sessionId: s.id, publicId: s.public_id, source: "staged" };
      }


      // 1. Re-check quotas
      if (!staged) {
        if (!userId) throw new Error("userId required for user provisioning");
        const active = await listActiveSessionsForUser(userId);
        if (active.length >= env.MAX_VMS_PER_USER) {
          throw new Error(`User already has ${active.length}/${env.MAX_VMS_PER_USER} active VMs`);
        }
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

      // 5. Create session row immediately so the UI sees it as "queued"
      const session = staged ? null : await createPendingSession({
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

      // Track whether we got far enough that an orphan cleanup is needed.
      let cloned = false;

      try {
        // 6. Clone
        if (session) { await markSessionProvisioning(session.id); logSessionEvent(session, "provisioning"); }
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

        const noteLines = [
          `Requested by: ${userId ? `user#${userId}` : "staging-system"}`,
          `Template: ${templateId}`,
          `Node: ${node}`,
          `VMID: ${vmId}`,
          `Job: ${job.id}`,
          `Created: ${new Date().toISOString()}`
        ];
        await proxmox.setDescription(node, vmId, noteLines.join("\n"));

        // 7. Power on
        const startUpid = await proxmox.powerOn(node, vmId);
        await proxmox.waitForTask(node, startUpid, 60_000);
        logger.info({ vmId, node }, "powered on");

        // 8. Wait for IP
        const ip = await proxmox.waitForGuestIp(node, vmId, 240_000);
        logger.info({ vmId, ip }, "guest IP available");

        // 9. Mark running
        if (session) {
          await markSessionRunning(session.id, ip);
          logSessionEvent(session, "running");
        }

        await audit({
          userId: userId ?? null,
          action: "vm.provisioned",
          sessionId: session?.id ?? null,
          details: { templateId, vmId, node, ip },
        });

        // 10. Hard-timeout cleanup
        if (!staged && session) {
          await cleanupQueue.add(
            "cleanup",
            { sessionId: session.id, reason: "hard_timeout" },
            { delay: env.SESSION_HARD_TIMEOUT_MINUTES * 60 * 1000 }
          );
        }

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
          return { stagedId: stagedRow.id, vmId };
        }
        return { sessionId: session!.id, publicId: session!.public_id };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.error({ vmId, node, err: reason }, "provisioning failed");

        if (session) await markSessionFailed(session.id, reason);
        await audit({
          userId: userId ?? null,
          action: "vm.provisioned_failed",
          sessionId: session?.id ?? null,
          details: { templateId, vmId, error: reason },
        });

        // Enqueue cleanup so the orphaned VM is removed from Proxmox
        if (cloned && session) {
          await cleanupQueue.add("cleanup-orphan", {
            sessionId: session.id,
            reason: "provisioning_failed",
          }).catch((cleanupErr) => {
            logger.error({ err: String(cleanupErr) }, "failed to enqueue orphan cleanup");
          });
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
