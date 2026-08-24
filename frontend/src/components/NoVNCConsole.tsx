import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from "react";
import { VncScreen } from "react-vnc";
import { getToken } from "../api";

interface NoVNCConsoleProps {
  sessionPublicId: string;
  scalingMode: "scale" | "viewport" | "native";
  performanceMode: PerformanceMode;
  /** Spectator mode: render the framebuffer but send no input. */
  viewOnly?: boolean;
}

export type PerformanceMode = "lan" | "balanced" | "remote";

/**
 * Encoding presets.
 *
 * `compressionLevel` is the zlib level the server applies to Tight-encoded
 * rectangles, and `qualityLevel` is its JPEG quality. Both cost the *server*
 * CPU - and the server here is QEMU's VNC encoder, which is single-threaded
 * and shares the host with every other VM on the node.
 *
 * The previous default was quality 3 / compression 6, which is the worst of
 * both: a heavily compressed, visibly blocky picture that also pinned the
 * encoder. On the LAN this lab runs on, bandwidth is free and encoder CPU is
 * the actual bottleneck, so the default now spends bytes to buy latency.
 */
const PERFORMANCE_PRESETS: Record<PerformanceMode, { quality: number; compression: number }> = {
  lan:      { quality: 8, compression: 1 },
  balanced: { quality: 6, compression: 3 },
  remote:   { quality: 4, compression: 7 },
};

export const PERFORMANCE_LABELS: Record<PerformanceMode, string> = {
  lan: "Fast (LAN)",
  balanced: "Balanced",
  remote: "Low bandwidth",
};

export interface ConsoleKeyHandle {
  sendCtrlAltDel: () => void;
  sendKey: (keysym: number, code: string) => void;
  sendCombo: (keys: Array<{ keysym: number; code: string }>) => void;
  /** Type text into the guest as real keystrokes. Resolves when done. */
  typeText: (text: string, onProgress?: (done: number, total: number) => void) => Promise<void>;
  takeScreenshot: () => string | null;
  /** Hand keyboard focus back to the framebuffer. */
  focusGuest: () => void;
  isConnected: () => boolean;
}

interface VncHandle {
  sendKey: (keysym: number, code: string, down?: boolean) => void;
  sendCtrlAltDel: () => void;
  focus: () => void;
  blur: () => void;
  clipboardPaste: (text: string) => void;
  connected: boolean;
}

/**
 * Map one character to an X11 keysym.
 *
 * For printable ASCII the keysym *is* the code point, and for Latin-1 it is
 * too; anything else uses the Unicode escape range. We deliberately pass an
 * empty `code` alongside these: noVNC only reaches for the QEMU extended key
 * event (which is driven by a physical scancode, not the keysym) when it can
 * resolve `code` to an XT scancode. With `code` empty it falls back to a plain
 * RFB KeyEvent carrying just the keysym, and QEMU applies its own keymap -
 * including pressing Shift itself for capitals and shifted punctuation. That
 * is exactly what we want when typing text, where we have characters rather
 * than keys.
 */
function keysymForChar(ch: string): number | null {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return null;
  if (ch === "\n" || ch === "\r") return 0xff0d; // Return
  if (ch === "\t") return 0xff09;                // Tab
  if (cp < 0x20) return null;                    // other control chars: skip
  if (cp <= 0xff) return cp;                     // ASCII + Latin-1
  return 0x01000000 + cp;                        // Unicode keysym range
}

/**
 * Milliseconds between keystrokes. Guests drop characters if you fire them as
 * fast as the socket allows - Windows in particular, while its input queue is
 * busy. 12ms is about 80 characters a second, which is faster than anyone
 * types and slow enough to arrive intact.
 */
const KEYSTROKE_DELAY_MS = 12;

/** Guard against someone pasting a whole file into the box. */
export const MAX_TYPE_LENGTH = 5000;

export const NoVNCConsole = forwardRef<ConsoleKeyHandle, NoVNCConsoleProps>(function NoVNCConsole(
  { sessionPublicId, scalingMode, performanceMode, viewOnly = false },
  ref
) {
  const [status, setStatus] = useState("Connecting…");
  const [error, setError] = useState<string | null>(null);
  const vncRef = useRef<VncHandle | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const typingRef = useRef(false);

  /**
   * react-vnc blurs the RFB canvas on mouseleave, and clicking a toolbar
   * button also moves DOM focus onto that button. Between the two, every
   * toolbar click used to leave the guest deaf to the keyboard until you
   * clicked back on the screen - which read, fairly, as "the buttons don't
   * work". Every action routes through here to put focus back.
   */
  const focusGuest = useCallback(() => {
    if (viewOnly) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) active.blur();
    // After the click's own focus handling has settled, not during it.
    requestAnimationFrame(() => vncRef.current?.focus());
  }, [viewOnly]);

  const sendKey = useCallback((keysym: number, code: string) => {
    vncRef.current?.sendKey(keysym, code);
    focusGuest();
  }, [focusGuest]);

  const sendCombo = useCallback((keys: Array<{ keysym: number; code: string }>) => {
    for (const key of keys) vncRef.current?.sendKey(key.keysym, key.code, true);
    for (const key of [...keys].reverse()) vncRef.current?.sendKey(key.keysym, key.code, false);
    focusGuest();
  }, [focusGuest]);

  const typeText = useCallback(
    async (text: string, onProgress?: (done: number, total: number) => void) => {
      const rfb = vncRef.current;
      if (!rfb || viewOnly || typingRef.current) return;

      const chars = Array.from(text.slice(0, MAX_TYPE_LENGTH));
      typingRef.current = true;

      // Also hand the string to the RFB clipboard. QEMU's VNC server has no
      // channel to the guest clipboard, so this does nothing on its own - but
      // it costs one message and means the paste works unchanged on any guest
      // that does have one (a SPICE agent, an in-guest VNC server).
      try {
        rfb.clipboardPaste(text);
      } catch {
        /* best-effort only */
      }

      try {
        // Focus first, then type: a keystroke sent to an unfocused canvas is
        // simply lost.
        const active = document.activeElement;
        if (active instanceof HTMLElement && active !== document.body) active.blur();
        rfb.focus();
        await new Promise((resolve) => requestAnimationFrame(resolve));

        for (let i = 0; i < chars.length; i++) {
          const keysym = keysymForChar(chars[i]);
          if (keysym !== null) {
            rfb.sendKey(keysym, "", true);
            rfb.sendKey(keysym, "", false);
          }
          onProgress?.(i + 1, chars.length);
          await new Promise((resolve) => setTimeout(resolve, KEYSTROKE_DELAY_MS));
        }
      } finally {
        typingRef.current = false;
      }
    },
    [viewOnly]
  );

  useImperativeHandle(ref, () => ({
    sendCtrlAltDel: () => {
      vncRef.current?.sendCtrlAltDel();
      focusGuest();
    },
    sendKey,
    sendCombo,
    typeText,
    takeScreenshot: () => {
      const canvas = wrapRef.current?.querySelector("canvas");
      if (!canvas) return null;
      return canvas.toDataURL("image/png");
    },
    focusGuest,
    isConnected: () => status === "Connected",
  }));

  const token = getToken();
  if (!token) {
    return <div className="console-canvas-wrap"><div className="console-status">No auth token</div></div>;
  }

  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${window.location.host}/ws/novnc?session=${sessionPublicId}&token=${token}`;
  const perf = PERFORMANCE_PRESETS[performanceMode] ?? PERFORMANCE_PRESETS.lan;

  if (error) {
    return (
      <div className="console-canvas-wrap">
        <div className="console-error-overlay">
          <div className="console-error-icon">⚠</div>
          <div className="console-error-title">Connection Lost</div>
          <div className="console-error-msg">{error}</div>
          <button onClick={() => setError(null)} className="primary">Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`console-canvas-wrap scaling-${scalingMode}`}
      ref={wrapRef}
      onClick={() => { if (!viewOnly) vncRef.current?.focus(); }}
    >
      {status !== "Connected" && (
        <div className="console-status-overlay">
          Console: {status}
        </div>
      )}
      <VncScreen
        url={url}
        scaleViewport={scalingMode !== "native"}
        clipViewport={scalingMode === "viewport"}
        style={{ width: "100%", height: "100%" }}
        ref={vncRef}
        viewOnly={viewOnly}
        focusOnClick={!viewOnly}
        resizeSession={!viewOnly && scalingMode === "scale"}
        qualityLevel={perf.quality}
        compressionLevel={perf.compression}
        onConnect={() => setStatus("Connected")}
        onDisconnect={(e: any) => {
          const clean = e?.detail?.clean;
          const reason = e?.detail?.reason;
          if (clean) {
            setStatus("Disconnected");
          } else {
            const msg = reason
              ? `Connection dropped: ${reason}`
              : "Connection dropped unexpectedly. The VM may have shut down or the network connection was lost.";
            setError(msg);
          }
        }}
        onSecurityFailure={(e: any) => {
          setError(`Authentication failed: ${e?.detail?.reason ?? "unknown reason"}`);
        }}
      />
    </div>
  );
});
