/**
 * Public endpoint that powers the dashboard tile grid. Anything an unauthed
 * client sees here is fine to expose; we strip credentials.
 */
import { Router } from "express";
import { getTemplates } from "../config";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.get("/", requireAuth, (_req, res) => {
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
    }));
  res.json(tiles);
});

export default router;
