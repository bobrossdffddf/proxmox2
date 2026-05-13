import { WebSocket, WebSocketServer } from "ws";
import { parse as parseUrl } from "url";
import { env, getNodes } from "../config";
import { logger } from "../services/logger";
import { getSessionByPublicId } from "../services/sessionManager";
import { proxmox } from "../services/proxmox";
import { verify } from "jsonwebtoken";

export function createNoVncProxy() {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", async (browserWs, request) => {
    const url = parseUrl(request.url || "", true);
    const sessionPublicId = url.query.session as string;
    const token = url.query.token as string;

    if (!sessionPublicId || !token) {
      browserWs.close(1008, "Missing session or token");
      return;
    }

    try {
      // 1. Auth
      const decoded = verify(token, env.JWT_SECRET) as unknown as { sub: number };
      const session = await getSessionByPublicId(sessionPublicId);

      if (!session) throw new Error("Session not found");
      if (session.user_id !== decoded.sub) throw new Error("Forbidden");
      if (session.status !== "running") throw new Error("Session not running");

      // 2. Get Proxmox VNC Ticket
      const { ticket, port } = await proxmox.createVncProxy(session.proxmox_node, session.proxmox_vmid);
      logger.info({ vmId: session.proxmox_vmid, node: session.proxmox_node, port }, "got VNC proxy ticket");

      // 3. Connect to Proxmox WebSocket
      const nodeConfig = getNodes().find((n) => n.name === session.proxmox_node);
      if (!nodeConfig) throw new Error("Node config not found");

      const proxmoxWsUrl = `wss://${nodeConfig.host}:${nodeConfig.port}/api2/json/nodes/${session.proxmox_node}/qemu/${session.proxmox_vmid}/vncwebsocket?port=${port}&vncticket=${encodeURIComponent(ticket)}`;

      const proxmoxWs = new WebSocket(proxmoxWsUrl, {
        headers: {
          Authorization: `PVEAPIToken=${env.PROXMOX_TOKEN_ID}=${env.PROXMOX_TOKEN_SECRET}`,
        },
        rejectUnauthorized: env.PROXMOX_VERIFY_TLS,
      });

      // Buffer messages from browser until proxmox WS is open
      const pendingBrowserMessages: Array<{ data: Buffer; isBinary: boolean }> = [];
      let proxmoxReady = false;

      // 4. Proxmox -> Browser relay
      proxmoxWs.on("open", () => {
        logger.info({ vmId: session.proxmox_vmid }, "proxmox VNC ws opened, flushing buffer");
        proxmoxReady = true;

        // Flush any buffered browser messages
        for (const msg of pendingBrowserMessages) {
          proxmoxWs.send(msg.data, { binary: msg.isBinary });
        }
        pendingBrowserMessages.length = 0;
      });

      proxmoxWs.on("message", (data: Buffer, isBinary: boolean) => {
        logger.info({ size: data.length, isBinary, direction: "proxmox->browser" }, "VNC relay");
        if (browserWs.readyState === WebSocket.OPEN) {
          browserWs.send(data, { binary: isBinary });
        }
      });

      // Browser -> Proxmox relay (buffer until ready)
      browserWs.on("message", (data: Buffer, isBinary: boolean) => {
        logger.info({ size: data.length, isBinary, direction: "browser->proxmox" }, "VNC relay");
        if (proxmoxReady && proxmoxWs.readyState === WebSocket.OPEN) {
          proxmoxWs.send(data, { binary: isBinary });
        } else {
          pendingBrowserMessages.push({ data, isBinary });
        }
      });

      // Cleanup
      browserWs.on("close", (code) => {
        logger.info({ vmId: session.proxmox_vmid, code }, "browser disconnected from noVNC");
        proxmoxWs.close();
      });

      proxmoxWs.on("close", (code, reason) => {
        logger.info({ vmId: session.proxmox_vmid, code, reason: reason?.toString() }, "proxmox VNC ws closed");
        if (browserWs.readyState === WebSocket.OPEN) {
          browserWs.close();
        }
      });

      browserWs.on("error", (err) => {
        logger.error({ err: String(err) }, "noVNC browser ws error");
        proxmoxWs.close();
      });

      proxmoxWs.on("error", (err) => {
        logger.error({ err: String(err) }, "noVNC proxmox ws error");
        if (browserWs.readyState === WebSocket.OPEN) {
          browserWs.close();
        }
      });

    } catch (err) {
      logger.error({ err: String(err) }, "noVNC proxy setup failed");
      browserWs.close(1011, "Internal Error");
    }
  });

  return wss;
}
