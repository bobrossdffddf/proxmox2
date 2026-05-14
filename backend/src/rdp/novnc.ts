import crypto from "crypto";
import { WebSocket, WebSocketServer } from "ws";
import { parse as parseUrl } from "url";
import { env, getNodes } from "../config";
import { logger } from "../services/logger";
import { getSessionByPublicId } from "../services/sessionManager";
import { proxmox } from "../services/proxmox";
import { verify } from "jsonwebtoken";

/**
 * VNC DES auth: take password, pad/truncate to 8 bytes, reverse bits
 * in each byte, DES-ECB encrypt the 16-byte challenge.
 */
function vncDesEncrypt(password: string, challenge: Buffer): Buffer {
  const key = Buffer.alloc(8);
  const pwBuf = Buffer.from(password, "utf8");
  for (let i = 0; i < 8; i++) {
    let b = i < pwBuf.length ? pwBuf[i] : 0;
    // Reverse bits in each byte (VNC quirk)
    b = ((b & 0x01) << 7) | ((b & 0x02) << 5) | ((b & 0x04) << 3) | ((b & 0x08) << 1) |
        ((b & 0x10) >> 1) | ((b & 0x20) >> 3) | ((b & 0x40) >> 5) | ((b & 0x80) >> 7);
    key[i] = b;
  }
  const c1 = crypto.createCipheriv("des-ecb", key, "");
  c1.setAutoPadding(false);
  const r1 = c1.update(challenge.subarray(0, 8));
  const c2 = crypto.createCipheriv("des-ecb", key, "");
  c2.setAutoPadding(false);
  const r2 = c2.update(challenge.subarray(8, 16));
  return Buffer.concat([r1, r2]);
}

/**
 * Transparent VNC auth proxy. The browser sees "no auth required" while
 * the backend handles the real VNC auth with the Proxmox ticket.
 *
 * RFB handshake we intercept:
 *   1. Server→Client: version (12 bytes) — RELAY
 *   2. Client→Server: version (12 bytes) — RELAY
 *   3. Server→Client: security types — REWRITE to [1, 1] (None)
 *   4. Client→Server: selected type — REWRITE to 2 (VNC Auth)
 *   5. Server→Client: 16-byte challenge — INTERCEPT, respond with DES
 *   6. Server→Client: 4-byte result — RELAY
 *   7. Everything after — transparent relay
 */
const enum Phase {
  SERVER_VERSION,     // waiting for server version (12 bytes)
  CLIENT_VERSION,     // waiting for client version (12 bytes)
  SERVER_SEC_TYPES,   // waiting for security types from server
  CLIENT_SEC_SELECT,  // waiting for client security selection (1 byte)
  SERVER_CHALLENGE,   // waiting for 16-byte VNC auth challenge
  SERVER_RESULT,      // waiting for 4-byte SecurityResult
  TRANSPARENT,        // passthrough mode
}

export function createNoVncProxy() {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  wss.on("connection", async (browserWs, request) => {
    const url = parseUrl(request.url || "", true);
    const sessionPublicId = url.query.session as string;
    const token = url.query.token as string;

    if (!sessionPublicId || !token) {
      browserWs.close(1008, "Missing session or token");
      return;
    }

    try {
      const decoded = verify(token, env.JWT_SECRET) as unknown as { sub: number };
      const session = await getSessionByPublicId(sessionPublicId);
      if (!session) throw new Error("Session not found");
      if (session.user_id !== decoded.sub) throw new Error("Forbidden");
      if (session.status !== "running") throw new Error("Session not running");

      const { ticket, port } = await proxmox.createVncProxy(session.proxmox_node, session.proxmox_vmid);
      logger.info({ vmId: session.proxmox_vmid, port }, "got VNC proxy ticket");

      const nodeConfig = getNodes().find((n) => n.name === session.proxmox_node);
      if (!nodeConfig) throw new Error("Node config not found");

      const proxmoxWsUrl = `wss://${nodeConfig.host}:${nodeConfig.port}/api2/json/nodes/${session.proxmox_node}/qemu/${session.proxmox_vmid}/vncwebsocket?port=${port}&vncticket=${encodeURIComponent(ticket)}`;

      const proxmoxWs = new WebSocket(proxmoxWsUrl, {
        headers: { Authorization: `PVEAPIToken=${env.PROXMOX_TOKEN_ID}=${env.PROXMOX_TOKEN_SECRET}` },
        rejectUnauthorized: env.PROXMOX_VERIFY_TLS,
        perMessageDeflate: false,
        handshakeTimeout: 10_000,
      });

      let phase: Phase = Phase.SERVER_VERSION;
      let serverBuf = Buffer.alloc(0); // accumulator for partial server messages

      proxmoxWs.on("open", () => {
        logger.info({ vmId: session.proxmox_vmid }, "proxmox VNC ws opened");
      });

      // --- Server (Proxmox) → Browser ---
      proxmoxWs.on("message", (raw: Buffer) => {
        if (phase === Phase.TRANSPARENT) {
          if (browserWs.readyState === WebSocket.OPEN) browserWs.send(raw, { binary: true });
          return;
        }

        serverBuf = Buffer.concat([serverBuf, raw]);
        processServerData();
      });

      function processServerData() {
        switch (phase) {
          case Phase.SERVER_VERSION: {
            if (serverBuf.length < 12) return;
            const version = serverBuf.subarray(0, 12);
            serverBuf = serverBuf.subarray(12);
            logger.info({ version: version.toString() }, "server RFB version");
            browserWs.send(version, { binary: true }); // relay version to browser
            phase = Phase.CLIENT_VERSION;
            break;
          }
          case Phase.SERVER_SEC_TYPES: {
            if (serverBuf.length < 1) return;
            const numTypes = serverBuf[0];
            if (serverBuf.length < 1 + numTypes) return;
            const types = serverBuf.subarray(1, 1 + numTypes);
            serverBuf = serverBuf.subarray(1 + numTypes);
            logger.info({ numTypes, types: Array.from(types) }, "server security types");
            // Tell browser: only "None" auth (type 1) is available
            browserWs.send(Buffer.from([1, 1]), { binary: true });
            phase = Phase.CLIENT_SEC_SELECT;
            break;
          }
          case Phase.SERVER_CHALLENGE: {
            if (serverBuf.length < 16) return;
            const challenge = serverBuf.subarray(0, 16);
            serverBuf = serverBuf.subarray(16);
            logger.info("intercepted VNC auth challenge, responding with ticket");
            // Respond with DES-encrypted ticket
            const response = vncDesEncrypt(ticket, challenge);
            proxmoxWs.send(response, { binary: true });
            phase = Phase.SERVER_RESULT;
            break;
          }
          case Phase.SERVER_RESULT: {
            if (serverBuf.length < 4) return;
            const result = serverBuf.subarray(0, 4);
            const ok = result.readUInt32BE(0) === 0;
            serverBuf = serverBuf.subarray(4);
            logger.info({ ok }, "VNC auth result");
            // Send SecurityResult OK to browser (for the "None" auth it selected)
            browserWs.send(Buffer.from([0, 0, 0, 0]), { binary: true });
            phase = Phase.TRANSPARENT;
            // Flush any remaining buffered data
            if (serverBuf.length > 0) {
              browserWs.send(serverBuf, { binary: true });
              serverBuf = Buffer.alloc(0);
            }
            if (!ok) {
              logger.error("VNC auth failed with Proxmox ticket!");
              browserWs.close();
              proxmoxWs.close();
            }
            break;
          }
          default:
            break;
        }
      }

      // --- Browser → Server (Proxmox) ---
      let clientBuf = Buffer.alloc(0);

      browserWs.on("message", (raw: Buffer) => {
        if (phase === Phase.TRANSPARENT) {
          if (proxmoxWs.readyState === WebSocket.OPEN) proxmoxWs.send(raw, { binary: true });
          return;
        }

        clientBuf = Buffer.concat([clientBuf, raw]);
        processClientData();
      });

      function processClientData() {
        switch (phase) {
          case Phase.CLIENT_VERSION: {
            if (clientBuf.length < 12) return;
            const version = clientBuf.subarray(0, 12);
            clientBuf = clientBuf.subarray(12);
            logger.info({ version: version.toString() }, "client RFB version");
            proxmoxWs.send(version, { binary: true });
            phase = Phase.SERVER_SEC_TYPES;
            break;
          }
          case Phase.CLIENT_SEC_SELECT: {
            if (clientBuf.length < 1) return;
            const selected = clientBuf[0]; // should be 1 (None)
            clientBuf = clientBuf.subarray(1);
            logger.info({ selected }, "client selected security type");
            // Tell server: we want VNC Auth (type 2)
            proxmoxWs.send(Buffer.from([2]), { binary: true });
            phase = Phase.SERVER_CHALLENGE;
            break;
          }
          default:
            break;
        }
      }

      // Cleanup
      browserWs.on("close", (code) => {
        logger.info({ vmId: session.proxmox_vmid, code }, "browser disconnected");
        proxmoxWs.close();
      });
      proxmoxWs.on("close", (code, reason) => {
        logger.info({ vmId: session.proxmox_vmid, code, reason: reason?.toString() }, "proxmox ws closed");
        if (browserWs.readyState === WebSocket.OPEN) browserWs.close();
      });
      browserWs.on("error", (e) => { logger.error({ err: String(e) }, "browser ws err"); proxmoxWs.close(); });
      proxmoxWs.on("error", (e) => { logger.error({ err: String(e) }, "proxmox ws err"); if (browserWs.readyState === WebSocket.OPEN) browserWs.close(); });

    } catch (err) {
      logger.error({ err: String(err) }, "noVNC proxy setup failed");
      browserWs.close(1011, "Internal Error");
    }
  });

  return wss;
}
