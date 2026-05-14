/**
 * Cleanup worker. For each session:
 *   1. Mark 'cleaning'.
 *   2. Power off (graceful first, force after 30s).
 *   3. Rollback to the baseline snapshot — this restores any baked-in scoring
 *      software that the student may have touched.
 *   4. Delete the clone.
 *   5. Release the VMID back to the pool.
 *   6. Mark 'stopped'.
 *
 * If any step fails, mark 'cleanup_failed' so an admin can investigate.
 * BullMQ will retry the job a few times based on the queue config.
 */
import { Worker } from "bullmq";
import { audit } from "../services/audit";
import { logger } from "../services/logger";
import { proxmox } from "../services/proxmox";
import { redis } from "../services/redis";
import {
  getSessionById,
  logSessionEvent,
  markCleanupFailed,
  markSessionCleaning,
  markSessionStopped,
} from "../services/sessionManager";
import { releaseVmid } from "../services/vmidPool";
import { CleanupJobData } from "./queues";

function shouldForgetTrackedVm(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return [
    "404",
    "not found",
    "does not exist",
    "ECONNREFUSED",
    "ENOTFOUND",
    "EHOSTUNREACH",
    "ETIMEDOUT",
    "timeout",
    "No route to host",
    "Unknown Proxmox node",
  ].some((needle) => msg.toLowerCase().includes(needle.toLowerCase()));
}

export function startCleanupWorker(): Worker<CleanupJobData> {
  const worker = new Worker<CleanupJobData>(
    "vm-cleanup",
    async (job) => {
      const { sessionId, reason } = job.data;
      const session = await getSessionById(sessionId);
      if (!session) {
        logger.warn({ sessionId }, "cleanup: session not found, skipping");
        return;
      }
      if (session.status === "stopped") {
        logger.debug({ sessionId, status: session.status }, "cleanup: already finalized");
        return;
      }

      const { proxmox_node: node, proxmox_vmid: vmId, snapshot_name: snapshot } = session;
      logSessionEvent(session, "cleanup.start", { reason });
      await markSessionCleaning(session.id);

      try {
        // 1. Power off. We try graceful shutdown first via the agent path on
        // Proxmox, then fall through. If the VM is already off (e.g. crashed),
        // this might 500; we swallow and continue.
        try {
          const stopUpid = await proxmox.powerOff(node, vmId, true);
          await proxmox.waitForTask(node, stopUpid, 60_000).catch(() => undefined);
        } catch (err) {
          logger.warn({ vmId, err: String(err) }, "powerOff failed, continuing");
        }

        // 2. Optional rollback. Template-only imported images may not have
        // snapshots, and deletion still fully removes the per-user clone.
        if (snapshot && !["none", "off", "disabled"].includes(snapshot.toLowerCase())) {
          try {
            const rollbackUpid = await proxmox.rollbackToSnapshot(node, vmId, snapshot);
            await proxmox.waitForTask(node, rollbackUpid, 120_000);
          } catch (err) {
            logger.debug({ vmId, snapshot, err: String(err) }, "snapshot rollback skipped");
          }
        }

        // 3. Delete clone. If Proxmox says the VM/node is unreachable or the
        // VM no longer exists, clear our tracking so the cleanup does not loop
        // forever after an admin/user delete.
        try {
          const deleteUpid = await proxmox.deleteVM(node, vmId);
          await proxmox.waitForTask(node, deleteUpid, 120_000);
        } catch (err) {
          if (!shouldForgetTrackedVm(err)) throw err;
          logger.warn({ sessionId, vmId, node, err: String(err) }, "forgetting unreachable/missing VM during cleanup");
          await audit({
            userId: session.user_id,
            action: "vm.cleanup_forgot_unreachable",
            sessionId: session.id,
            details: { reason, vmId, node, error: String(err) },
          });
        }

        // 4. Release VMID
        await releaseVmid(vmId);

        // 5. Mark stopped
        await markSessionStopped(session.id);
        logSessionEvent(session, "cleanup.done");

        await audit({
          userId: session.user_id,
          action: "vm.cleaned",
          sessionId: session.id,
          details: { reason, vmId, node },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ sessionId, vmId, err: msg }, "cleanup failed");
        await markCleanupFailed(session.id, msg);
        await audit({
          userId: session.user_id,
          action: "vm.cleanup_failed",
          sessionId: session.id,
          details: { reason, error: msg },
        });
        throw err;
      }
    },
    {
      connection: redis,
      concurrency: 4,
    }
  );

  worker.on("failed", (job, err) => {
    logger.warn({ jobId: job?.id, err: String(err) }, "cleanup job failed");
  });

  return worker;
}
