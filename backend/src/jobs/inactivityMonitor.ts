/**
 * Inactivity sweeper. Runs every 60 seconds. Finds sessions whose
 * last_activity_at is older than SESSION_INACTIVITY_TIMEOUT_MINUTES, or
 * whose hard_expires_at has passed, and enqueues a cleanup job for each.
 *
 * BullMQ has its own scheduler ("repeatable jobs") but for a single-instance
 * deployment a simple setInterval is perfectly fine and easier to reason about.
 */
import { logger } from "../services/logger";
import { listStaleSessions } from "../services/sessionManager";
import { cleanupQueue } from "./queues";

const SWEEP_INTERVAL_MS = 60_000;

export function startInactivityMonitor(): NodeJS.Timeout {
  const tick = async () => {
    try {
      const stale = await listStaleSessions();
      for (const s of stale) {
        const reason =
          s.hard_expires_at < new Date() ? "hard_timeout" : "inactivity";
        logger.info({ sessionId: s.id, reason }, "queuing stale session cleanup");
        await cleanupQueue.add(
          `sweep-${s.id}`,
          { sessionId: s.id, reason },
          { jobId: `cleanup-session-${s.id}` } // dedupe: one cleanup job per session
        );
      }
    } catch (err) {
      logger.error({ err: String(err) }, "inactivity sweep failed");
    }
  };

  // Fire once a few seconds after boot, then on the interval.
  const initial = setTimeout(tick, 5000);
  const interval = setInterval(tick, SWEEP_INTERVAL_MS);
  interval.unref();
  initial.unref();
  return interval;
}
