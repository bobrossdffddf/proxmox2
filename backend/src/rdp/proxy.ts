/**
 * WebSocket bridge: browser  <->  this server  <->  guacd  <->  Windows/Linux VM.
 *
 * Wire-level layout:
 *
 *   Browser draws on an HTML canvas using guacamole-common-js. That library
 *   speaks the "Guacamole protocol" (a simple text-based protocol) over a
 *   WebSocket connection to this server.
 *
 *   guacamole-lite (this package) accepts that WebSocket and proxies it to
 *   guacd. guacd in turn opens a real RDP or VNC connection to the VM and
 *   translates it into the Guacamole protocol.
 *
 *   Net result: the student sees a pixel-perfect Windows desktop drawn on a
 *   canvas, with no client install of any kind.
 *
 * Auth model:
 *
 *   The browser passes its JWT and the session's public id in the WS URL as
 *   query params. We:
 *     1. Verify the JWT.
 *     2. Look up the session, check it belongs to this user and is 'running'.
 *     3. Build a guacamole-lite config token from the session's connection
 *        details, encrypt it with the shared secret, and feed it into the
 *        guacamole-lite handshake.
 *
 *   We never expose the encryption key to the browser. We never expose VM
 *   credentials to the browser. The "token" the browser sees is just an
 *   opaque blob signed by us — we generate it server-side per connection.
 */
import crypto from "crypto";
import GuacamoleLite from "guacamole-lite";
import { Server as HttpServer } from "http";
import { env } from "../config";
import { logger } from "../services/logger";
import { getSessionByPublicId, touchHeartbeat } from "../services/sessionManager";

// We generate one random encryption key per backend process. guacamole-lite
// requires AES-256-CBC, which means a 32-byte key.
const CIPHER = "AES-256-CBC";
const KEY = crypto.randomBytes(32);

function encryptToken(payload: object): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(CIPHER, KEY, iv);
  const json = JSON.stringify(payload);
  const enc = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  const wrapper = {
    iv: iv.toString("base64"),
    value: enc.toString("base64"),
  };
  return Buffer.from(JSON.stringify(wrapper)).toString("base64");
}

interface GuacConnectionConfig {
  connection: {
    type: "rdp" | "vnc";
    settings: Record<string, string | number | boolean>;
  };
}

function buildConnectionConfig(args: {
  protocol: "rdp" | "vnc";
  host: string;
  port: number;
  username: string;
  password: string;
}): GuacConnectionConfig {
  const settings: Record<string, string | number | boolean> = {
    hostname: args.host,
    port: args.port,
    username: args.username,
    password: args.password,
    "ignore-cert": true,
    width: 1280,
    height: 800,
    dpi: 96,
  };

  if (args.protocol === "rdp") {
    settings.security = "any";        // accept whatever the server offers
    settings["enable-wallpaper"] = false;
    settings["enable-theming"] = false;
    settings["enable-font-smoothing"] = true;
    settings["resize-method"] = "display-update";
  }

  return { connection: { type: args.protocol, settings } };
}

/**
 * Mount the WebSocket server on the existing HTTP server at /ws/rdp.
 * guacamole-lite handles the upgrade dance itself.
 */
export function mountRdpProxy(httpServer: HttpServer): void {
  const guacServer = new GuacamoleLite(
    {
      server: httpServer,
      path: "/ws/rdp",
    },
    {
      host: env.GUACD_HOST,
      port: env.GUACD_PORT,
    },
    {
      crypt: {
        cypher: CIPHER,
        key: KEY,
      },
      log: {
        level: "ERRORS", // 'QUIET' | 'ERRORS' | 'NORMAL' | 'VERBOSE' | 'DEBUG'
      },
      maxInactivityTime: 0, // we manage timeouts ourselves
    }
  );

  // guacamole-lite emits events we can use for auditing / heartbeats.
  guacServer.on("open", (clientConnection: { connectionSettings?: Record<string, unknown> }) => {
    logger.debug({ settings: clientConnection?.connectionSettings }, "guacamole connection open");
  });
  guacServer.on("close", () => {
    logger.debug("guacamole connection closed");
  });
  guacServer.on("error", (_clientConnection: unknown, err: unknown) => {
    logger.warn({ err: String(err) }, "guacamole connection error");
  });
}

/**
 * Called by the /ws/auth HTTP endpoint. The frontend hits this just before
 * opening the WebSocket, gets back an opaque token, and passes that token
 * to guacamole-common-js. The token contains the encrypted connection config.
 */
export async function issueGuacToken(args: {
  userId: number;
  publicSessionId: string;
}): Promise<{ token: string; sessionPublicId: string }> {
  const session = await getSessionByPublicId(args.publicSessionId);
  if (!session) throw new Error("session not found");
  if (session.user_id !== args.userId) throw new Error("forbidden");
  if (session.status !== "running") throw new Error(`session not running (${session.status})`);
  if (!session.guest_ip) throw new Error("session has no guest IP yet");

  const cfg = buildConnectionConfig({
    protocol: session.protocol,
    host: session.guest_ip,
    port: session.guest_port,
    username: session.guest_username ?? "",
    password: session.guest_password ?? "",
  });

  // A successful token grant counts as activity.
  await touchHeartbeat(session.id);

  return {
    token: encryptToken(cfg),
    sessionPublicId: session.public_id,
  };
}
