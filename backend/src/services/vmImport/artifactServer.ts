/**
 * Serves an in-flight import artifact over plain HTTP so a Proxmox node can
 * fetch it itself.
 *
 * Pushing a large image *into* pveproxy's upload endpoint has a habit of dying
 * partway: the node stages the body in a temporary file first, and that
 * staging area is frequently smaller than the image (on many installs it's a
 * tmpfs sized from RAM). Proxmox's own `download-url` avoids the whole problem
 * — the node streams straight into the target storage — but it needs a URL it
 * can reach.
 *
 * So the artifact is published here, unauthenticated but behind a single-use
 * random token that exists only while the transfer is running. The bytes are
 * generated on demand exactly as they are for a push, so this costs no disk
 * either.
 */
import crypto from "crypto";
import { Readable } from "stream";
import { Router } from "express";
import { logger } from "../logger";

interface PullArtifact {
  importId: number;
  filename: string;
  size: number;
  open: () => Readable | Promise<Readable>;
  /** Wall-clock deadline, so a token can't outlive a failed import. */
  expiresAt: number;
}

const artifacts = new Map<string, PullArtifact>();

/**
 * Publish an artifact and return its token. Registration is deliberately
 * short-lived: the caller releases it as soon as the node has finished, and
 * the deadline covers the case where it never does.
 */
export function registerPullArtifact(
  artifact: Omit<PullArtifact, "expiresAt">,
  ttlMs = 6 * 60 * 60 * 1000
): string {
  const token = crypto.randomBytes(24).toString("base64url");
  artifacts.set(token, { ...artifact, expiresAt: Date.now() + ttlMs });
  return token;
}

export function releasePullArtifact(token: string): void {
  artifacts.delete(token);
}

/** Anything left behind by a crashed or cancelled transfer. */
function sweepExpired(): void {
  const now = Date.now();
  for (const [token, artifact] of artifacts) {
    if (artifact.expiresAt <= now) artifacts.delete(token);
  }
}

export const pullRouter = Router();

/**
 * Proxmox issues a HEAD before the GET to learn the size, so both have to
 * answer with the same Content-Length.
 */
pullRouter.head("/:token", (req, res) => {
  sweepExpired();
  const artifact = artifacts.get(req.params.token);
  if (!artifact) return void res.status(404).end();

  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", String(artifact.size));
  res.setHeader("Accept-Ranges", "none");
  res.status(200).end();
});

pullRouter.get("/:token", async (req, res) => {
  sweepExpired();
  const artifact = artifacts.get(req.params.token);
  if (!artifact) {
    logger.warn({ ip: req.ip }, "import artifact pull with an unknown or expired token");
    return void res.status(404).json({ error: "not found" });
  }

  logger.info(
    { importId: artifact.importId, filename: artifact.filename, ip: req.ip },
    "node is pulling the import artifact"
  );

  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", String(artifact.size));
  res.setHeader("Content-Disposition", `attachment; filename="${artifact.filename}"`);

  let source: Readable;
  try {
    source = await artifact.open();
  } catch (err) {
    logger.error({ importId: artifact.importId, err: String(err) }, "could not open the import artifact");
    return void res.status(500).end();
  }

  // If the node hangs up, stop generating bytes for it.
  res.on("close", () => source.destroy());
  source.on("error", (err) => {
    logger.error({ importId: artifact.importId, err: String(err) }, "import artifact stream failed");
    res.destroy();
  });

  source.pipe(res);
});
