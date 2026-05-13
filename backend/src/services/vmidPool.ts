/**
 * Allocates a unique Proxmox VMID for a new cloned VM.
 *
 * We use a Redis SET to track in-use VMIDs (in addition to whatever Proxmox
 * itself has). On allocation we pick a random VMID in [VM_ID_RANGE_START,
 * VM_ID_RANGE_END], try to claim it in Redis with SETNX, and retry on collision.
 *
 * This is intentionally pessimistic: we'd rather waste a tiny amount of time
 * picking a free ID than collide with an existing VM. The cleanup workflow
 * frees the ID when the VM is destroyed.
 */
import { env } from "../config";
import { redis } from "./redis";

const KEY = (id: number) => `vmid:claim:${id}`;
const TTL_SECONDS = 60 * 60 * 8; // claim auto-expires after 8h (well past hard session timeout)

export async function allocateVmid(): Promise<number> {
  const min = env.VM_ID_RANGE_START;
  const max = env.VM_ID_RANGE_END;

  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = Math.floor(Math.random() * (max - min + 1)) + min;
    const ok = await redis.set(KEY(candidate), "claimed", "EX", TTL_SECONDS, "NX");
    if (ok === "OK") return candidate;
  }
  throw new Error("Could not allocate a free VMID after 50 attempts");
}

export async function releaseVmid(id: number): Promise<void> {
  await redis.del(KEY(id));
}
