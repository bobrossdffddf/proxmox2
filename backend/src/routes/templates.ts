/**
 * Powers the dashboard tile grid. Requires auth; we strip credentials and
 * attach the count of warm staged VMs so the UI can show launch readiness.
 *
 * Tiles also carry the template's staging health. Without it a template whose
 * warm pool cannot be filled looks identical to one that is simply between
 * clones - both just say "Warming up" - and the actual reason (missing
 * snapshot, template VMID absent from the node, guest agent never reporting an
 * IP) stays buried in the backend log.
 */
import { Router } from "express";
import { getTemplates } from "../config";
import { many } from "../db/client";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { listStagingHealth } from "../services/stagingHealth";

const router = Router();

/**
 * A template is only called "stalled" after it has failed to stage more than
 * once. A single failure is usually a transient Proxmox hiccup that the next
 * maintainer pass fixes on its own, and shouting about it would train people
 * to ignore the warning.
 */
const STALL_THRESHOLD = 2;

router.get("/", requireAuth, async (req, res) => {
  const auth = (req as unknown as AuthedRequest).auth;
  const isAdmin = auth.role === "admin";

  const readyRows = await many<{ template_id: string; count: string }>(
    `SELECT template_id, COUNT(*)::text AS count
     FROM staged_vms
     WHERE status='running'
     GROUP BY template_id`
  );
  const readyByTemplate = new Map(readyRows.map((r) => [r.template_id, Number(r.count)]));

  const pendingRows = await many<{ template_id: string; count: string }>(
    `SELECT template_id, COUNT(*)::text AS count
     FROM staged_vms
     WHERE status IN ('queued','provisioning')
     GROUP BY template_id`
  );
  const pendingByTemplate = new Map(pendingRows.map((r) => [r.template_id, Number(r.count)]));

  const health = await listStagingHealth();

  const tiles = getTemplates()
    .filter((t) => t.enabled)
    .map((t) => {
      const ready = readyByTemplate.get(t.id) ?? 0;
      const row = health.get(t.id);
      const failures = row?.consecutive_failures ?? 0;
      const stalled = ready === 0 && failures >= STALL_THRESHOLD && Boolean(row?.last_error);

      return {
        id: t.id,
        name: t.name,
        description: t.description,
        icon: t.icon,
        protocol: t.protocol,
        color: t.color ?? null,
        cpu_cores: t.cpu_cores,
        memory_mb: t.memory_mb,
        ready_count: ready,
        pending_count: pendingByTemplate.get(t.id) ?? 0,
        stalled,
        /**
         * Students get told that the image needs an admin; only admins get the
         * raw Proxmox error, which can name node hostnames and VMIDs.
         */
        staging_error: stalled
          ? isAdmin
            ? row!.last_error
            : "Not available right now. Your admin can see why on the staging page."
          : null,
        staging_failures: stalled ? failures : 0,
      };
    });
  res.json(tiles);
});

export default router;
