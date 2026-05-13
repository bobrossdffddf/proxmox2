/**
 * Entry point. Wires up Express, mounts routes, starts workers, mounts the
 * RDP WebSocket bridge on the same HTTP server, applies the DB schema.
 */
import "dotenv/config";

import cors from "cors";
import express from "express";
import helmet from "helmet";
import http from "http";

import { env, getNodes, getTemplates } from "./config";
import { applySchema } from "./db/client";
import { errorHandler } from "./middleware/errorHandler";
import { logger } from "./services/logger";

import authRouter from "./routes/auth";
import templatesRouter from "./routes/templates";
import vmRouter from "./routes/vm";
import adminRouter from "./routes/admin";
import rdpRouter from "./routes/rdp";

import { mountRdpProxy } from "./rdp/proxy";
import { startProvisioningWorker } from "./jobs/provisioningWorker";
import { startCleanupWorker } from "./jobs/cleanupWorker";
import { startInactivityMonitor } from "./jobs/inactivityMonitor";

async function main() {
  logger.info({ env: env.NODE_ENV }, "starting backend");

  // 1. Configs (throws if YAMLs are invalid)
  const nodes = getNodes();
  const templates = getTemplates();
  logger.info({ nodes: nodes.length, templates: templates.length }, "config loaded");

  // 2. DB schema
  await applySchema();

  // 3. Express
  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet({ contentSecurityPolicy: false })); // CSP set on the nginx side
  app.use(cors());
  app.use(express.json({ limit: "256kb" }));

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  app.use("/api/auth", authRouter);
  app.use("/api/templates", templatesRouter);
  app.use("/api/vm", vmRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/rdp", rdpRouter);

  app.use(errorHandler);

  // 4. Workers
  const provisioner = startProvisioningWorker();
  const cleaner = startCleanupWorker();
  const sweeper = startInactivityMonitor();

  // 5. HTTP + WS
  const server = http.createServer(app);
  mountRdpProxy(server);

  server.listen(env.BACKEND_PORT, () => {
    logger.info({ port: env.BACKEND_PORT }, "backend listening");
  });

  // 6. Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    server.close();
    clearInterval(sweeper);
    await provisioner.close();
    await cleaner.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error({ err: String(err), stack: err instanceof Error ? err.stack : undefined }, "fatal");
  process.exit(1);
});
