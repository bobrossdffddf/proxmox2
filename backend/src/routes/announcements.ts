import { Router } from "express";
import { many } from "../db/client";
import { requireAuth } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

router.get("/", async (_req, res) => {
  const announcements = await many<{
    id: number;
    title: string;
    message: string;
    created_at: Date;
  }>(
    `SELECT id, title, message, created_at
     FROM announcements
     WHERE active=true
     ORDER BY created_at DESC
     LIMIT 3`
  );
  res.json(announcements);
});

export default router;
