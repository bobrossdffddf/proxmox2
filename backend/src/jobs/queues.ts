/**
 * BullMQ queue + worker setup. Three queues:
 *   - vm-provisioning: clone a VM, wait for boot, create the session row.
 *   - vm-cleanup: power off, rollback snapshot, delete VM, mark stopped.
 *   - vm-import: package an uploaded VMware bundle and import it as a template.
 *
 * Job names match the data shapes below.
 */
import { Queue } from "bullmq";
import { redis } from "../services/redis";

export interface ProvisioningJobData {
  templateId: string;
  userId?: number;
  staged?: boolean;
  targetNode?: string;
}

export interface CleanupJobData {
  sessionId: number;
  reason: "user_requested" | "admin_requested" | "inactivity" | "hard_timeout" | "provisioning_failed";
}

export const provisioningQueue = new Queue<ProvisioningJobData>("vm-provisioning", {
  connection: redis,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
  },
});

export const cleanupQueue = new Queue<CleanupJobData>("vm-cleanup", {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 15_000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
  },
});

export interface ImportJobData {
  importId: number;
}

export const importQueue = new Queue<ImportJobData>("vm-import", {
  connection: redis,
  defaultJobOptions: {
    // Imports move tens of gigabytes and half-create VMs on the way. Retrying
    // one automatically would redo all of that against a dirty cluster, so a
    // failure is reported and left for the admin to restart deliberately.
    attempts: 1,
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 100 },
  },
});
