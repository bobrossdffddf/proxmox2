import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { VncScreen } from "react-vnc";
import { getToken } from "../api";

interface NoVNCConsoleProps {
  sessionPublicId: string;
}

export interface ConsoleKeyHandle {
  sendCtrlAltDel: () => void;
  sendKey: (keysym: number, code: string) => void;
  sendCombo: (keys: Array<{ keysym: number; code: string }>) => void;
}

interface VncHandle {
  sendKey: (keysym: number, code: string, down?: boolean) => void;
  sendCtrlAltDel: () => void;
  focus: () => void;
}

export const NoVNCConsole = forwardRef<ConsoleKeyHandle, NoVNCConsoleProps>(function NoVNCConsole(
  { sessionPublicId },
  ref
) {
  const [status, setStatus] = useState("Connecting…");
  const [error, setError] = useState<string | null>(null);
  const vncRef = useRef<VncHandle | null>(null);

  const sendKey = (keysym: number, code: string) => {
    vncRef.current?.sendKey(keysym, code);
    vncRef.current?.focus();
  };

  useImperativeHandle(ref, () => ({
    sendCtrlAltDel: () => {
      vncRef.current?.sendCtrlAltDel();
      vncRef.current?.focus();
    },
    sendKey,
    sendCombo,
  }));

  const sendCombo = (keys: Array<{ keysym: number; code: string }>) => {
    for (const key of keys) vncRef.current?.sendKey(key.keysym, key.code, true);
    for (const key of [...keys].reverse()) vncRef.current?.sendKey(key.keysym, key.code, false);
    vncRef.current?.focus();
  };

  const token = getToken();
  if (!token) {
    return <div className="console-canvas-wrap"><div className="console-status">No auth token</div></div>;
  }

  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${window.location.host}/ws/novnc?session=${sessionPublicId}&token=${token}`;

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
    <div className="console-canvas-wrap">
      {status !== "Connected" && (
        <div className="console-status-overlay">
          Console: {status}
        </div>
      )}
      <VncScreen
        url={url}
        scaleViewport
        style={{ width: "100%", height: "100%" }}
        ref={vncRef}
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
