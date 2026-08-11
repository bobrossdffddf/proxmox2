/**
 * VM import worker.
 *
 * Concurrency is 1 on purpose: an import saturates disk and network on both the
 * backend and the target node, and running two at once makes both slower and
 * the progress reporting a lie.
 */
import { Worker } from "bullmq";
import { logger } from "../services/logger";
import { redis } from "../services/redis";
import { runImport } from "../services/vmImport/pipeline";
import * as store from "../services/vmImport/store";
import { ImportJobData } from "./queues";

export function startImportWorker(): Worker<ImportJobData> {
  const worker = new Worker<ImportJobData>(
    "vm-import",
    async (job) => {
      const { importId } = job.data;
      logger.info({ jobId: job.id, importId }, "import job start");
      await runImport(importId);
      return { importId };
    },
    { connection: redis, concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    logger.warn({ jobId: job?.id, importId: job?.data?.importId, err: String(err) }, "import job failed");
  });

  return worker;
}

/**
 * Imports that were running when the process died can't be resumed — the
 * pipeline holds temp files and a half-created VM that this process no longer
 * knows about. Mark them failed at startup so the UI stops showing a spinner
 * that will never resolve.
 */
export async function failInterruptedImports(): Promise<void> {
  const stuck = await store.listUnfinishedImports();
  for (const row of stuck) {
    await store.appendLog(row.id, "error", "The backend restarted while this import was running.");
    await store.markFailed(
      row.id,
      "Interrupted by a backend restart. Check the target node for a partially created VM before retrying."
    );
    logger.warn({ importId: row.id }, "marked interrupted import as failed");
  }
}
