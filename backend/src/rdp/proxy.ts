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
// We use guacamole-lite's own Crypt class to generate tokens so our encryption
// is byte-for-byte symmetric with their decryption (their decrypt path uses
// 'ascii' string encoding for the IV which loses the high bit on bytes >=128;
// matching that exactly is easier than re-implementing it).
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const Crypt = require("guacamole-lite/lib/Crypt");
import { Server as HttpServer } from "http";
import { env } from "../config";
import { logger } from "../services/logger";
import { getSessionByPublicId, touchHeartbeat } from "../services/sessionManager";

// One random key per backend process. AES-256 needs 32 bytes.
const CIPHER = "AES-256-CBC";
const KEY = crypto.randomBytes(32);
const crypt = new Crypt(CIPHER, KEY);

// --- GUACAMOLE-LITE MONKEY PATCHES ---
// guacamole-lite 1.2.0 has several bugs in Node >= 18 and with modern guacamole-common-js:
// 1. guacamole-common-js WebSocketTunnel always appends connection data using `?`,
//    even if the URL already has a query string. This results in URLs like:
//    `/ws/rdp?token=eyJ...?width=1280&height=800`
//    Node's URL parser bundles the second `?` and everything after it into the `token`.
// 2. ClientConnection.decryptToken uses Crypt.js which mangles PKCS7 padding in Node 20.
// 3. Server.js calls connect() even if the ClientConnection constructor failed
//    and closed the socket, leading to a crash reading `.connection`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ClientConnection = require("guacamole-lite/lib/ClientConnection");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const GuacamoleLiteServer = require("guacamole-lite/lib/Server");

const originalExtract = GuacamoleLiteServer.prototype.extractGuacdOptions;
GuacamoleLiteServer.prototype.extractGuacdOptions = function (this: any, query: any) {
  if (query && query.token && typeof query.token === "string" && query.token.includes("?")) {
    const parts = query.token.split("?");
    query.token = parts[0];
    const extraQuery = new URLSearchParams(parts.slice(1).join("?"));
    for (const [key, value] of extraQuery.entries()) {
      query[key] = value;
    }
  }
  return originalExtract.call(this, query);
};

const originalConnect = ClientConnection.prototype.connect;
ClientConnection.prototype.connect = function (this: any, guacdOptions: unknown) {
  // If constructor failed (e.g. invalid token), state is CLOSING/CLOSED.
  if (this.state === this.STATE_CLOSED || this.state === this.STATE_CLOSING || !this.connectionSettings) {
    return;
  }
  return originalConnect.call(this, guacdOptions);
};

ClientConnection.prototype.decryptToken = function (this: any) {
  if (!this.clientOptions.crypt || !this.clientOptions.crypt.key) {
    throw new Error("Encryption key not configured");
  }

  const encryptedToken = this.query.token;
  delete this.query.token;

  const tokenData = JSON.parse(Buffer.from(encryptedToken, "base64").toString("utf8"));
  const decipher = crypto.createDecipheriv(
    this.clientOptions.crypt.cypher,
    this.clientOptions.crypt.key,
    Buffer.from(tokenData.iv, "base64")
  );

  let decrypted = decipher.update(Buffer.from(tokenData.value, "base64"), undefined, "utf8");
  decrypted += decipher.final("utf8");

  return JSON.parse(decrypted);
};
// -------------------------------------

function encryptToken(payload: object): string {
  return crypt.encrypt(payload) as string;
}

interface GuacConnectionConfig {
  connection: {
    type: "rdp" | "vnc";
    settings: Record<string, string | number | boolean>;
  };
}

/**
 * Why this path exists at all.
 *
 * The other console route (`/ws/novnc`) attaches to QEMU's *display* console
 * through the Proxmox API. That works on any VM, including one with no network
 * and no guest OS, which makes it the right fallback — but it is slow by
 * construction: QEMU re-encodes framebuffer rectangles as images on the
 * Proxmox host, single-threaded, sharing the node with every other VM, and the
 * pixels then cross an extra TLS hop through the Proxmox API before reaching
 * us.
 *
 * guacd instead speaks the guest's own remote-desktop protocol directly to the
 * guest IP. RDP sends drawing operations — glyphs, cached bitmaps, rectangle
 * fills — rather than pixels, so a screen of scrolling text costs a few
 * kilobytes rather than a re-encoded JPEG, and none of it touches Proxmox.
 *
 * The settings below are tuned for a disposable practice VM on a LAN, where
 * responsiveness beats fidelity.
 */
function buildConnectionConfig(args: {
  protocol: "rdp" | "vnc";
  host: string;
  port: number;
  username: string;
  password: string;
  width: number;
  height: number;
  dpi: number;
  colorDepth: number;
  readOnly: boolean;
}): GuacConnectionConfig {
  const settings: Record<string, string | number | boolean> = {
    hostname: args.host,
    port: args.port,
    width: args.width,
    height: args.height,
    dpi: args.dpi,
    "color-depth": args.colorDepth,
    // Nobody is listening to a hardening exercise, and audio costs bandwidth
    // and a guacd thread.
    "disable-audio": true,
    // Spectators (demo watchers, admins looking over a shoulder) get pixels
    // and nothing else. guacd drops their input server-side; this is the
    // enforcement, not a UI courtesy.
    "read-only": args.readOnly,
  };

  if (args.protocol === "rdp") {
    settings.username = args.username;
    settings.password = args.password;
    settings["ignore-cert"] = true;
    settings.security = "any";        // accept whatever the server offers

    // Desktop eye-candy is pure cost over a remote protocol: each of these
    // turns cheap drawing operations into large bitmap updates.
    settings["enable-wallpaper"] = false;
    settings["enable-theming"] = false;
    settings["enable-font-smoothing"] = false;
    settings["enable-desktop-composition"] = false;
    settings["enable-menu-animations"] = false;
    settings["enable-full-window-drag"] = false;

    // Caching is what makes RDP fast — leave every cache on. (These are
    // "disable-*" flags, so false means enabled.)
    settings["disable-bitmap-caching"] = false;
    settings["disable-offscreen-caching"] = false;

    // Let the guest resize its desktop to the browser window instead of
    // scaling a fixed 1024x768 framebuffer. Windows 8 / Server 2012 and later
    // support the display-update channel; guacd falls back on its own if the
    // guest does not.
    settings["resize-method"] = "display-update";

    // Lossy compression for changed regions. Lossless would look marginally
    // better on text and cost several times the bandwidth.
    settings["force-lossless"] = false;

    // No drive, printer, or clipboard-file redirection: this is a throwaway
    // VM students should not be able to move files in and out of freely.
    settings["enable-drive"] = false;
    settings["enable-printing"] = false;
  } else {
    // In-guest VNC server (not the QEMU console). VNC auth is password-only —
    // there is no username in the protocol.
    if (args.password) settings.password = args.password;
    // Draw the cursor locally so pointer motion does not wait for a round trip.
    settings.cursor = "local";
  }

  return { connection: { type: args.protocol, settings } };
}

/**
 * Create the Guacamole-lite proxy in noServer mode.
 * We handle WebSocket upgrades centrally in index.ts so that the guac
 * WebSocketServer doesn't reject /ws/novnc requests.
 */
export function createRdpProxy(httpServer: HttpServer) {
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
        level: "ERRORS",
      },
      maxInactivityTime: 0,
    }
  );

  guacServer.on("open", (clientConnection: { connectionSettings?: Record<string, unknown> }) => {
    logger.debug({ settings: clientConnection?.connectionSettings }, "guacamole connection open");
  });
  guacServer.on("close", () => {
    logger.debug("guacamole connection closed");
  });
  guacServer.on("error", (_clientConnection: unknown, err: unknown) => {
    logger.warn({ err: String(err) }, "guacamole connection error");
  });

  return guacServer;
}

/**
 * Called by POST /api/rdp/connect. The frontend hits this just before opening
 * the WebSocket, gets back an opaque token, and passes that token to
 * guacamole-common-js. The token carries the encrypted connection config, so
 * VM credentials never reach the browser.
 */
export async function issueGuacToken(args: {
  userId: number;
  role: "student" | "admin";
  publicSessionId: string;
  width?: number;
  height?: number;
  dpi?: number;
  colorDepth?: number;
}): Promise<{
  token: string;
  sessionPublicId: string;
  protocol: "rdp" | "vnc";
  readOnly: boolean;
}> {
  const session = await getSessionByPublicId(args.publicSessionId);
  if (!session) throw new Error("session not found");

  const isOwner = session.user_id === args.userId;
  // Same access rule as the other console route: the owner, any admin, and —
  // while demo mode is on — anybody at all. Everyone but the owner is
  // read-only, enforced by guacd rather than by the UI.
  const mayWatch = isOwner || args.role === "admin" || (session.demo_active && session.status === "running");
  if (!mayWatch) throw new Error("forbidden");

  if (session.status !== "running") throw new Error(`session not running (${session.status})`);
  if (!session.guest_ip) {
    // Nothing is wrong with the VM — the guest agent just has not reported an
    // address yet. The caller falls back to the QEMU console, which does not
    // need one.
    throw new Error("session has no guest IP yet");
  }

  const cfg = buildConnectionConfig({
    protocol: session.protocol,
    host: session.guest_ip,
    port: session.guest_port,
    username: session.guest_username ?? "",
    password: session.guest_password ?? "",
    width: clampDimension(args.width, 1280),
    height: clampDimension(args.height, 800),
    dpi: clamp(args.dpi ?? 96, 96, 240),
    colorDepth: [8, 16, 24, 32].includes(args.colorDepth ?? 0) ? args.colorDepth! : 24,
    readOnly: !isOwner,
  });

  // A successful token grant counts as activity — but only for the person who
  // owns the VM. A room full of students watching a demo must not keep
  // somebody else's session alive.
  if (isOwner) await touchHeartbeat(session.id);

  return {
    token: encryptToken(cfg),
    sessionPublicId: session.public_id,
    protocol: session.protocol,
    readOnly: !isOwner,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Round to an even number within sane bounds. Odd widths break some RDP
 * servers' bitmap alignment, and an absurd size from a hostile client would
 * have guacd allocate a framebuffer to match.
 */
function clampDimension(value: number | undefined, fallback: number): number {
  const n = clamp(value ?? fallback, 640, 4096);
  return n % 2 === 0 ? n : n - 1;
}
