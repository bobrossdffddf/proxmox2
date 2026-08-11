/**
 * Powers the dashboard tile grid. Requires auth; we strip credentials and
 * attach the count of warm staged VMs so the UI can show launch readiness.
 */
import { Router } from "express";
import { getTemplates } from "../config";
import { many } from "../db/client";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.get("/", requireAuth, async (_req, res) => {
  const readyRows = await many<{ template_id: string; count: string }>(
    `SELECT template_id, COUNT(*)::text AS count
     FROM staged_vms
     WHERE status='running'
     GROUP BY template_id`
  );
  const readyByTemplate = new Map(readyRows.map((r) => [r.template_id, Number(r.count)]));

  const tiles = getTemplates()
    .filter((t) => t.enabled)
    .map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      icon: t.icon,
      protocol: t.protocol,
      color: t.color ?? null,
      cpu_cores: t.cpu_cores,
      memory_mb: t.memory_mb,
      ready_count: readyByTemplate.get(t.id) ?? 0,
    }));
  res.json(tiles);
});

export default router;
