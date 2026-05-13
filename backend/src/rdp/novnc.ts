import { Server as HttpServer } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { parse as parseUrl } from "url";
import { env, getNodes } from "../config";
import { logger } from "../services/logger";
import { getSessionByPublicId } from "../services/sessionManager";
import { proxmox } from "../services/proxmox";
import { verify } from "jsonwebtoken";

export function mountNoVncProxy(server: HttpServer) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const { pathname } = parseUrl(request.url || "");

    if (pathname === "/ws/novnc") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    }
  });

  wss.on("connection", async (ws, request) => {
    const url = parseUrl(request.url || "", true);
    const sessionPublicId = url.query.session as string;
    const token = url.query.token as string;

    if (!sessionPublicId || !token) {
      ws.close(1008, "Missing session or token");
      return;
    }

    try {
      // 1. Auth — verify the user's JWT
      const decoded = verify(token, env.JWT_SECRET) as { userId: number };
      const session = await getSessionByPublicId(sessionPublicId);

      if (!session) throw new Error("Session not found");
      if (session.user_id !== decoded.userId) throw new Error("Forbidden");
      if (session.status !== "running") throw new Error("Session not running");

      // 2. Request a VNC proxy ticket from Proxmox
      const { ticket, port } = await proxmox.createVncProxy(session.proxmox_node, session.proxmox_vmid);
      logger.info({ vmId: session.proxmox_vmid, node: session.proxmox_node, port }, "got VNC proxy ticket");

      // 3. Open a websocket to the Proxmox VNC websocket endpoint
      const nodeConfig = getNodes().find((n) => n.name === session.proxmox_node);
      if (!nodeConfig) throw new Error("Node config not found");

      const proxmoxWsUrl = `wss://${nodeConfig.host}:${nodeConfig.port}/api2/json/nodes/${session.proxmox_node}/qemu/${session.proxmox_vmid}/vncwebsocket?port=${port}&vncticket=${encodeURIComponent(ticket)}`;

      logger.debug({ url: proxmoxWsUrl }, "connecting to proxmox vnc websocket");

      const proxmoxWs = new WebSocket(proxmoxWsUrl, ["binary"], {
        headers: {
          // Proxmox requires the API token for websocket authentication
          Authorization: `PVEAPIToken=${env.PROXMOX_TOKEN_ID}=${env.PROXMOX_TOKEN_SECRET}`,
        },
        rejectUnauthorized: env.PROXMOX_VERIFY_TLS,
      });

      // 4. Bidirectional pipe between browser <-> proxmox
      proxmoxWs.on("open", () => {
        logger.info({ vmId: session.proxmox_vmid }, "proxmox VNC websocket opened");
      });

      // Forward browser -> proxmox
      ws.on("message", (data: Buffer | string) => {
        if (proxmoxWs.readyState === WebSocket.OPEN) {
          proxmoxWs.send(data);
        }
      });

      // Forward proxmox -> browser
      proxmoxWs.on("message", (data: Buffer | string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      // Cleanup on close
      ws.on("close", () => {
        logger.debug({ vmId: session.proxmox_vmid }, "browser disconnected from noVNC");
        proxmoxWs.close();
      });

      proxmoxWs.on("close", (code, reason) => {
        logger.debug({ vmId: session.proxmox_vmid, code, reason: reason?.toString() }, "proxmox VNC websocket closed");
        ws.close();
      });

      ws.on("error", (err) => {
        logger.error({ err: String(err) }, "noVNC browser websocket error");
        proxmoxWs.close();
      });

      proxmoxWs.on("error", (err) => {
        logger.error({ err: String(err) }, "noVNC proxmox websocket error");
        ws.close();
      });

    } catch (err) {
      logger.error({ err: String(err) }, "noVNC proxy setup failed");
      ws.close(1011, "Internal Error");
    }
  });
}
