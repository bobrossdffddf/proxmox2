/**
 * One HTTP endpoint that the frontend hits right before opening the
 * Guacamole WebSocket. Returns an opaque, single-use connection token.
 */
import { Router } from "express";
import { z } from "zod";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { HttpError } from "../middleware/errorHandler";
import { issueGuacToken } from "../rdp/proxy";

const router = Router();
router.use(requireAuth);

const schema = z.object({
  sessionId: z.string().min(1),
  // The browser reports its own viewport so guacd can ask the guest for a
  // desktop that size, instead of scaling a fixed 1024x768 framebuffer.
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  dpi: z.number().int().optional(),
  colorDepth: z.number().int().optional(),
});

router.post("/connect", async (req, res) => {
  const parse = schema.safeParse(req.body);
  if (!parse.success) throw new HttpError(400, "sessionId required");

  const auth = (req as unknown as AuthedRequest).auth;
  try {
    const result = await issueGuacToken({
      userId: auth.sub,
      role: auth.role,
      publicSessionId: parse.data.sessionId,
      width: parse.data.width,
      height: parse.data.height,
      dpi: parse.data.dpi,
      colorDepth: parse.data.colorDepth,
    });
    res.json(result);
  } catch (err) {
    // The frontend treats any failure here as "fall back to the QEMU console",
    // so the message matters more than the status code.
    throw new HttpError(400, String(err instanceof Error ? err.message : err));
  }
});

export default router;
