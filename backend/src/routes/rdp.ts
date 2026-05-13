/**
 * One HTTP endpoint that the frontend hits right before opening the
 * RDP WebSocket. Returns an opaque, single-use Guacamole token.
 */
import { Router } from "express";
import { z } from "zod";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { HttpError } from "../middleware/errorHandler";
import { issueGuacToken } from "../rdp/proxy";

const router = Router();
router.use(requireAuth);

const schema = z.object({ sessionId: z.string().min(1) });

router.post("/connect", async (req, res) => {
  const parse = schema.safeParse(req.body);
  if (!parse.success) throw new HttpError(400, "sessionId required");

  const auth = (req as AuthedRequest).auth;
  try {
    const result = await issueGuacToken({
      userId: auth.sub,
      publicSessionId: parse.data.sessionId,
    });
    res.json(result);
  } catch (err) {
    throw new HttpError(400, String(err instanceof Error ? err.message : err));
  }
});

export default router;
