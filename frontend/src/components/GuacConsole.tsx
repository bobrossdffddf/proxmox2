import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import Guacamole from "guacamole-common-js";
import type { GuacClient, GuacKeyboard, GuacStatus, MouseState } from "guacamole-common-js";
import { api } from "../api";
import { ConsoleKeyHandle } from "./NoVNCConsole";

/**
 * The fast console path.
 *
 * This talks to guacd, which speaks the guest's own remote-desktop protocol
 * (RDP for Windows, an in-guest VNC server for Linux) straight to the VM's IP.
 * The alternative path, NoVNCConsole, attaches to QEMU's display console
 * through the Proxmox API — that works on any VM at all, including one with no
 * network, but it ships re-encoded pixels over an extra hop and is markedly
 * slower.
 *
 * So: try this first, and let the caller fall back if the guest is not
 * reachable on its remote-desktop port.
 */

interface GuacConsoleProps {
  sessionPublicId: string;
  /** Colour depth in bits. Lower is faster over a constrained link. */
  colorDepth: number;
  /** Spectators render the screen but send nothing; guacd also enforces this. */
  viewOnly?: boolean;
  /** Called once pixels are flowing. */
  onConnected?: () => void;
  /**
   * Called when this path cannot be used. The caller is expected to fall back
   * to the QEMU console rather than show an error.
   */
  onUnavailable?: (reason: string) => void;
  /** Text arriving from the guest's clipboard. */
  onRemoteClipboard?: (text: string) => void;
}

/** Guacamole.Client state constants. */
const STATE_CONNECTED = 3;
const STATE_DISCONNECTED = 5;

/**
 * How long to wait for a connection before giving up and falling back. guacd
 * has to open a TCP connection to the guest and complete an RDP handshake; on
 * a healthy LAN that is well under a second, and a guest that is not listening
 * usually refuses immediately. This is the ceiling for the case where the
 * packet is silently dropped by a guest firewall.
 */
const CONNECT_TIMEOUT_MS = 12_000;

export const GuacConsole = forwardRef<ConsoleKeyHandle, GuacConsoleProps>(function GuacConsole(
  { sessionPublicId, colorDepth, viewOnly = false, onConnected, onUnavailable, onRemoteClipboard },
  ref
) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // guacd's canvas stack is mounted here. React never renders children into
  // this node, so appending to it cannot fight the reconciler.
  const displayRef = useRef<HTMLDivElement | null>(null);
  const clientRef = useRef<GuacClient | null>(null);
  const keyboardRef = useRef<GuacKeyboard | null>(null);
  const [status, setStatus] = useState("Connecting…");

  // Held in refs so the connect effect does not re-run (and re-connect) every
  // time the parent re-renders with a new callback identity.
  const callbacks = useRef({ onConnected, onUnavailable, onRemoteClipboard });
  callbacks.current = { onConnected, onUnavailable, onRemoteClipboard };

  const focusGuest = useCallback(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) active.blur();
    requestAnimationFrame(() => wrapRef.current?.focus());
  }, []);

  useEffect(() => {
    let cancelled = false;
    let client: GuacClient | null = null;
    let keyboard: GuacKeyboard | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    /** Report failure exactly once, and only before we ever connected. */
    const giveUp = (reason: string) => {
      if (settled || cancelled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      callbacks.current.onUnavailable?.(reason);
    };

    async function connect() {
      const wrap = wrapRef.current;
      const mount = displayRef.current;
      if (!wrap || !mount) return;

      const rect = wrap.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(640, Math.round(rect.width));
      const height = Math.max(480, Math.round(rect.height));

      let token: string;
      try {
        const grant = await api.guacConnect(sessionPublicId, {
          width,
          height,
          dpi: Math.round(96 * ratio),
          colorDepth,
        });
        token = grant.token;
      } catch (err) {
        giveUp(err instanceof Error ? err.message : "could not get a connection token");
        return;
      }
      if (cancelled) return;

      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const tunnel = new Guacamole.WebSocketTunnel(
        `${proto}//${window.location.host}/ws/rdp?token=${encodeURIComponent(token)}`
      );
      client = new Guacamole.Client(tunnel);
      clientRef.current = client;

      const display = client.getDisplay();
      mount.replaceChildren(display.getElement());

      client.onstatechange = (state: number) => {
        if (cancelled) return;
        if (state === STATE_CONNECTED) {
          settled = true;
          if (timeout) clearTimeout(timeout);
          setStatus("Connected");
          callbacks.current.onConnected?.();
        } else if (state === STATE_DISCONNECTED) {
          // A drop *after* a good connection is a real disconnect, not a
          // reason to fall back to a slower path.
          if (settled) setStatus("Disconnected");
          else giveUp("the remote desktop connection closed during setup");
        }
      };

      client.onerror = (err: GuacStatus) => {
        giveUp(err?.message || `guacd error ${err?.code ?? "unknown"}`);
      };
      tunnel.onerror = (err: GuacStatus) => {
        giveUp(err?.message || `tunnel error ${err?.code ?? "unknown"}`);
      };

      // Clipboard from the guest. This is a real clipboard channel — unlike
      // the QEMU console, which has none.
      client.onclipboard = (stream, mimetype) => {
        if (!mimetype.startsWith("text/")) return;
        const reader = new Guacamole.StringReader(stream);
        let text = "";
        reader.ontext = (chunk) => { text += chunk; };
        reader.onend = () => { if (text) callbacks.current.onRemoteClipboard?.(text); };
      };

      timeout = setTimeout(
        () => giveUp("the VM did not answer on its remote desktop port in time"),
        CONNECT_TIMEOUT_MS
      );

      client.connect(`width=${width}&height=${height}&dpi=${Math.round(96 * ratio)}`);

      if (!viewOnly) {
        const mouse = new Guacamole.Mouse(display.getElement());
        const sendMouse = (state: MouseState) => client?.sendMouseState(state);
        mouse.onmousedown = sendMouse;
        mouse.onmouseup = sendMouse;
        mouse.onmousemove = sendMouse;

        keyboard = new Guacamole.Keyboard(wrap);
        keyboardRef.current = keyboard;
        keyboard.onkeydown = (keysym: number) => { client?.sendKeyEvent(1, keysym); };
        keyboard.onkeyup = (keysym: number) => { client?.sendKeyEvent(0, keysym); };
      }
    }

    void connect();

    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
      // Release any keys still held, or the guest is left with a stuck Ctrl.
      keyboard?.reset();
      keyboardRef.current = null;
      try { client?.disconnect(); } catch { /* already gone */ }
      clientRef.current = null;
    };
    // colorDepth and viewOnly are baked into the connection, so a change to
    // either has to tear down and reconnect.
  }, [sessionPublicId, colorDepth, viewOnly]);

  /**
   * Keep the guest desktop the same size as the window. RDP's display-update
   * channel resizes the actual desktop rather than scaling a fixed
   * framebuffer, which is why text stays crisp when you resize.
   */
  useEffect(() => {
    if (viewOnly) return;
    const wrap = wrapRef.current;
    if (!wrap) return;

    let debounce: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        const rect = wrap.getBoundingClientRect();
        if (rect.width < 320 || rect.height < 240) return;
        try {
          clientRef.current?.sendSize(Math.round(rect.width), Math.round(rect.height));
        } catch { /* not connected yet */ }
      }, 400);
    });
    observer.observe(wrap);
    return () => { if (debounce) clearTimeout(debounce); observer.disconnect(); };
  }, [viewOnly]);

  useImperativeHandle(ref, () => ({
    sendCtrlAltDel: () => {
      // 0xFFE3 Control_L, 0xFFE9 Alt_L, 0xFFFF Delete
      const combo = [0xffe3, 0xffe9, 0xffff];
      for (const key of combo) clientRef.current?.sendKeyEvent(1, key);
      for (const key of [...combo].reverse()) clientRef.current?.sendKeyEvent(0, key);
      focusGuest();
    },
    sendKey: (keysym: number) => {
      clientRef.current?.sendKeyEvent(1, keysym);
      clientRef.current?.sendKeyEvent(0, keysym);
      focusGuest();
    },
    sendCombo: (keys: Array<{ keysym: number; code: string }>) => {
      for (const key of keys) clientRef.current?.sendKeyEvent(1, key.keysym);
      for (const key of [...keys].reverse()) clientRef.current?.sendKeyEvent(0, key.keysym);
      focusGuest();
    },
    /**
     * On this path "typing" is a real clipboard write followed by nothing —
     * the guest gets the text on its clipboard and the user pastes with
     * Ctrl+V, which is both faster and more reliable than synthesising a
     * keystroke per character.
     */
    typeText: async (text: string) => {
      const client = clientRef.current;
      if (!client || viewOnly) return;
      const stream = client.createClipboardStream("text/plain");
      const writer = new Guacamole.StringWriter(stream);
      writer.sendText(text);
      writer.sendEnd();
      focusGuest();
    },
    takeScreenshot: () => {
      const canvas = wrapRef.current?.querySelector("canvas");
      return canvas ? canvas.toDataURL("image/png") : null;
    },
    focusGuest,
    isConnected: () => status === "Connected",
  }));

  return (
    <div
      className="console-canvas-wrap guac"
      ref={wrapRef}
      tabIndex={viewOnly ? -1 : 0}
      onClick={() => { if (!viewOnly) wrapRef.current?.focus(); }}
    >
      <div className="guac-display" ref={displayRef} />
      {status !== "Connected" && <div className="console-status-overlay">Console: {status}</div>}
    </div>
  );
});
