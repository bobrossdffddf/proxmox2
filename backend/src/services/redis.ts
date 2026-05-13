import IORedis from "ioredis";
import { env } from "../config";

/**
 * Shared Redis client. BullMQ creates its own underneath but we use this one
 * for ad-hoc operations (heartbeat cache, distributed locks, etc.).
 *
 * BullMQ wants maxRetriesPerRequest set to null so it can manage retries
 * itself. We follow that recommendation here.
 */
export const redis = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});
