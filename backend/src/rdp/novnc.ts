import { Server as HttpServer } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { parse as parseUrl } from "url";
import { env, getNodes } from "../config";
import { logger } from "../services/logger";
import { getSessionByPublicId } from "../services/sessionManager";
import { proxmox } from "../services/proxmox";
import { verify } from "jsonwebtoken";
import https from "https";

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
      // 1. Auth
      const decoded = verify(token, env.JWT_SECRET) as { userId: number };
      const session = await getSessionByPublicId(sessionPublicId);

      if (!session) throw new Error("Session not found");
      if (session.user_id !== decoded.userId) throw new Error("Forbidden");
      if (session.status !== "running") throw new Error("Session not running");

      // 2. Get Proxmox VNC Ticket
      const { ticket, port } = await proxmox.createVncProxy(session.proxmox_node, session.proxmox_vmid);

      // 3. Connect to Proxmox WebSocket
      const nodeConfig = getNodes().find((n) => n.name === session.proxmox_node);
      if (!nodeConfig) throw new Error("Node config not found");

      const proxmoxWsUrl = `wss://${nodeConfig.host}:${nodeConfig.port}/api2/json/nodes/${session.proxmox_node}/qemu/${session.proxmox_vmid}/vncwebsocket?port=${port}&vncticket=${encodeURIComponent(ticket)}`;

      logger.debug({ vmId: session.proxmox_vmid, node: session.proxmox_node }, "opening noVNC proxy to proxmox");

      const proxmoxWs = new WebSocket(proxmoxWsUrl, {
        headers: {
          // Some Proxmox versions might expect the cookie, but vncticket in URL is usually enough.
          // Authorization: `PVEAPIToken=${env.PROXMOX_TOKEN_ID}=${env.PROXMOX_TOKEN_SECRET}`,
        },
        rejectUnauthorized: env.PROXMOX_VERIFY_TLS,
      });

      // 4. Pipe data
      proxmoxWs.on("open", () => {
        logger.debug("proxmox vnc websocket opened");
      });

      ws.on("message", (data) => {
        if (proxmoxWs.readyState === WebSocket.OPEN) {
          proxmoxWs.send(data);
        }
      });

      proxmoxWs.on("message", (data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      ws.on("close", () => {
        proxmoxWs.close();
      });

      proxmoxWs.on("close", () => {
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
