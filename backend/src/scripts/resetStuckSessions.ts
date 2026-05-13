/**
 * Recovery script. Walks every session in 'provisioning'/'running'/'cleaning'
 * state and queues a cleanup. Use this if the backend died mid-flight or
 * if a Proxmox node was offline during cleanup.
 *
 *   docker compose exec backend node dist/scripts/resetStuckSessions.js
 */
import "dotenv/config";
import { pool } from "../db/client";
import { cleanupQueue } from "../jobs/queues";
import { listAllLiveSessions } from "../services/sessionManager";

async function main() {
  const live = await listAllLiveSessions();
  console.log(`Found ${live.length} live sessions, queuing cleanup for each...`);
  for (const s of live) {
    await cleanupQueue.add(
      `manual-reset-${s.id}`,
      { sessionId: s.id, reason: "user_requested" },
      { jobId: `cleanup-session-${s.id}` }
    );
    console.log(`  -> queued cleanup for session ${s.public_id} (VM ${s.proxmox_vmid} on ${s.proxmox_node})`);
  }
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
