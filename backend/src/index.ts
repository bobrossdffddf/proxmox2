/**
 * Entry point. Wires up Express, mounts routes, starts workers, mounts the
 * RDP WebSocket bridge on the same HTTP server, applies the DB schema.
 */
import "dotenv/config";
// Monkey-patches express to forward async route errors to the error
// middleware instead of crashing the process. Must come before any other
// express import.
import "express-async-errors";

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
import announcementsRouter from "./routes/announcements";
import importsRouter from "./routes/imports";
import { pullRouter } from "./services/vmImport/artifactServer";

import { createRdpProxy } from "./rdp/proxy";
import { createNoVncProxy } from "./rdp/novnc";
import { startProvisioningWorker } from "./jobs/provisioningWorker";
import { startCleanupWorker } from "./jobs/cleanupWorker";
import { startInactivityMonitor } from "./jobs/inactivityMonitor";
import { startStagingMonitor } from "./jobs/stagingMonitor";
import { failInterruptedImports, startImportWorker } from "./jobs/importWorker";
import { refreshImportedTemplates } from "./services/importedTemplates";
import { ensureAllStagedVms } from "./services/stagingMaintainer";
import { pruneTemplateOverrides, refreshHiddenTemplates } from "./services/templateAdmin";
import { parse as parseUrl } from "url";

/**
 * Node terminates the process on an unhandled rejection. With
 * `restart: unless-stopped` that reads as the backend being fine — the
 * container comes straight back and its log shows a clean startup, with no
 * trace of what killed it. Log loudly and keep serving; a stray rejection from
 * a background task is not a reason to drop every in-flight request.
 */
function installCrashHandlers() {
  process.on("unhandledRejection", (reason) => {
    logger.error(
      { reason: reason instanceof Error ? reason.message : String(reason), stack: reason instanceof Error ? reason.stack : undefined },
      "unhandled promise rejection — this would have killed the process"
    );
  });
  process.on("uncaughtException", (err) => {
    // Genuinely unsafe to continue from, but at least say why before going.
    logger.error({ err: err.message, stack: err.stack }, "uncaught exception — exiting");
    process.exit(1);
  });
}

async function main() {
  installCrashHandlers();
  logger.info({ env: env.NODE_ENV }, "starting backend");

  // 1. Configs (throws if YAMLs are invalid)
  const nodes = getNodes();
  const templates = getTemplates();
  logger.info({ nodes: nodes.length, templates: templates.length }, "config loaded");

  // 2. DB schema, then the templates that live in it rather than in YAML
  await applySchema();
  const imported = await refreshImportedTemplates();
  if (imported.length > 0) logger.info({ imported: imported.length }, "imported templates loaded");

  // 3. Express
  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet({ contentSecurityPolicy: false })); // CSP set on the nginx side
  app.use(cors());
  app.use(express.json({ limit: "256kb" }));

  // One line per API request, plus a distinct line when a request dies without
  // a response — the case where a browser shows nothing but "failed to fetch"
  // and the server log is otherwise silent.
  app.use((req, res, next) => {
    if (!req.path.startsWith("/api/")) return next();
    const started = Date.now();
    let answered = false;
    res.on("finish", () => {
      answered = true;
      logger.info(
        { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started },
        "request"
      );
    });
    res.on("close", () => {
      if (!answered) {
        logger.warn(
          { method: req.method, path: req.path, ms: Date.now() - started },
          "connection closed before a response was sent"
        );
      }
    });
    next();
  });

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  app.use("/api/auth", authRouter);
  app.use("/api/templates", templatesRouter);
  app.use("/api/vm", vmRouter);
  // Token-authenticated rather than JWT-authenticated: this is fetched by a
  // Proxmox node, which has no session. See services/vmImport/artifactServer.ts.
  app.use("/api/import-pull", pullRouter);

  // Mounted before the admin router so /api/admin/imports/* isn't shadowed by
  // any admin route pattern.
  app.use("/api/admin/imports", importsRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/rdp", rdpRouter);
  app.use("/api/announcements", announcementsRouter);

  app.use(errorHandler);

  // 4. Workers
  const provisioner = startProvisioningWorker();
  const cleaner = startCleanupWorker();
  const importer = startImportWorker();
  const sweeper = startInactivityMonitor();
  // Keeps the warm pool topped up on a timer. Without this, a staging failure
  // is permanent until someone restarts the backend or presses Refill.
  const stagingSweeper = startStagingMonitor();
  await failInterruptedImports();
  // Load the hidden-template overlay before anything reads getTemplates(),
  // or a retired image would be staged again on every boot.
  await refreshHiddenTemplates();
  await pruneTemplateOverrides();
  await ensureAllStagedVms();

  // 5. HTTP + WS
  const server = http.createServer(app);

  // Node 18+ aborts any request whose *body* takes longer than 5 minutes to
  // arrive (requestTimeout). A multi-gigabyte VM upload exceeds that as a
  // matter of course, and the socket dies mid-transfer with the browser's
  // progress bar simply stopping. Disable the blanket limit; the upload route
  // enforces an inactivity watchdog instead, which is the thing we actually
  // care about. headersTimeout still guards against a client that connects and
  // says nothing.
  server.requestTimeout = 0;
  server.headersTimeout = 120_000;
  server.keepAliveTimeout = 65_000;

  // Create guacamole-lite with the real server so it doesn't crash.
  // It registers its own upgrade handler for /ws/rdp internally.
  const guacServer = createRdpProxy(server);
  const noVncWss = createNoVncProxy();

  // Now steal control: remove ALL upgrade listeners (guacamole-lite's included)
  // and add our own centralized router so /ws/novnc doesn't get rejected.
  const guacWss = (guacServer as any).webSocketServer;
  server.removeAllListeners("upgrade");

  server.on("upgrade", (req, socket, head) => {
    (socket as any).setNoDelay?.(true);
    (socket as any).setKeepAlive?.(true, 30_000);
    const { pathname } = parseUrl(req.url || "");

    if (pathname === "/ws/novnc") {
      noVncWss.handleUpgrade(req, socket, head, (ws) => {
        noVncWss.emit("connection", ws, req);
      });
    } else if (pathname === "/ws/rdp") {
      guacWss.handleUpgrade(req, socket, head, (ws: any) => {
        guacWss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  server.listen(env.BACKEND_PORT, () => {
    logger.info({ port: env.BACKEND_PORT }, "backend listening");
  });

  // 6. Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    server.close();
    clearInterval(sweeper);
    clearInterval(stagingSweeper);
    await provisioner.close();
    await cleaner.close();
    await importer.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error({ err: String(err), stack: err instanceof Error ? err.stack : undefined }, "fatal");
  process.exit(1);
});
