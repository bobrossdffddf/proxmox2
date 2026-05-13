/**
 * Browser-side RDP/VNC viewer.
 *
 * Uses guacamole-common-js. The library handles all the protocol parsing and
 * paints the result onto an HTML5 canvas (and an offscreen mouse/keyboard
 * event layer) wired into a div we provide.
 *
 * Flow:
 *   1. Hit POST /api/rdp/connect with our session id. Backend returns an
 *      encrypted blob ("token") that contains the VM credentials.
 *   2. Open a WebSocket to /ws/rdp?token=<jwt>&guac-token=<blob>. The backend
 *      decrypts and proxies us into guacd.
 *   3. Wire mouse + keyboard events to the Guacamole client. It draws frames
 *      onto the canvas as the VM ships display updates.
 */
import Guacamole from "guacamole-common-js";
import { useEffect, useRef, useState } from "react";
import { api, getToken } from "../api";

interface Props {
  sessionId: string;
  onClose?: () => void;
}

export function RDPCanvas({ sessionId }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const clientRef = useRef<Guacamole.Client | null>(null);
  const [status, setStatus] = useState<string>("Connecting...");

  useEffect(() => {
    let cancelled = false;
    let mouse: Guacamole.Mouse | null = null;
    let keyboard: Guacamole.Keyboard | null = null;

    async function start() {
      try {
        const { token: guacToken } = await api.rdpToken(sessionId);
        if (cancelled) return;

        if (!getToken()) {
          setStatus("Not signed in.");
          return;
        }

        // The guacToken is short-lived and was issued only after JWT auth on
        // /api/rdp/connect, so it's all the WebSocket needs.
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl = `${proto}//${location.host}/ws/rdp?token=${encodeURIComponent(guacToken)}`;

        const tunnel = new Guacamole.WebSocketTunnel(wsUrl);
        const client = new Guacamole.Client(tunnel);
        clientRef.current = client;

        // Drop the rendered display into our container div.
        const display = client.getDisplay().getElement();
        if (!containerRef.current) return;
        containerRef.current.innerHTML = "";
        containerRef.current.appendChild(display);

        // Wire input.
        mouse = new Guacamole.Mouse(display);
        mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = (state) => {
          client.sendMouseState(state);
        };
        keyboard = new Guacamole.Keyboard(document);
        keyboard.onkeydown = (keysym) => client.sendKeyEvent(1, keysym);
        keyboard.onkeyup = (keysym) => client.sendKeyEvent(0, keysym);

        client.onstatechange = (state) => {
          const names: Record<number, string> = {
            0: "Idle",
            1: "Connecting...",
            2: "Waiting...",
            3: "Connected",
            4: "Disconnecting...",
            5: "Disconnected",
          };
          setStatus(names[state] ?? `state ${state}`);
        };

        client.onerror = (err: { message?: string }) => {
          setStatus(`Error: ${err?.message ?? "unknown"}`);
        };

        // Tell the server our viewport so it can resize the display.
        const { offsetWidth: w, offsetHeight: h } = containerRef.current;
        client.connect(`width=${Math.max(800, w)}&height=${Math.max(600, h)}`);
      } catch (err) {
        setStatus(err instanceof Error ? err.message : "Connection failed");
      }
    }

    void start();

    return () => {
      cancelled = true;
      try {
        clientRef.current?.disconnect();
      } catch { /* ignore */ }
      try {
        keyboard?.reset();
      } catch { /* ignore */ }
    };
  }, [sessionId]);

  // Heartbeat: tell the backend every 10s that the user is still here.
  useEffect(() => {
    const interval = setInterval(() => {
      api.heartbeat(sessionId).catch(() => undefined);
    }, 10_000);
    return () => clearInterval(interval);
  }, [sessionId]);

  return (
    <div className="console-canvas-wrap">
      <div ref={containerRef} />
      {status !== "Connected" && (
        <div className="console-status" style={{ position: "absolute" }}>
          {status}
        </div>
      )}
    </div>
  );
}
