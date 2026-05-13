/**
 * BullMQ queue + worker setup. Two queues:
 *   - vm-provisioning: clone a VM, wait for boot, create the session row.
 *   - vm-cleanup: power off, rollback snapshot, delete VM, mark stopped.
 *
 * Job names match the data shapes below.
 */
import { Queue } from "bullmq";
import { redis } from "../services/redis";

export interface ProvisioningJobData {
  templateId: string;
  userId?: number;
  staged?: boolean;
codex/add-progress-bar-and-vm-staging-features-7nboq7
  stagedVm?: {
    id: number;
    template_id: string;
    template_name: string;
    protocol: "rdp" | "vnc";
    proxmox_node: string;
    proxmox_vmid: number;
    proxmox_template_id: number;
    snapshot_name: string;
    guest_ip: string | null;
    guest_port: number;
    guest_username: string | null;
    guest_password: string | null;
  };

main
}

export interface CleanupJobData {
  sessionId: number;
  reason: "user_requested" | "inactivity" | "hard_timeout" | "provisioning_failed";
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
