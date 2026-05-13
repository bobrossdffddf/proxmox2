import { useRef, useState } from "react";
import { VncScreen } from "react-vnc";
import { getToken } from "../api";

interface NoVNCConsoleProps {
  sessionPublicId: string;
}

interface VncHandle {
  sendKey: (keysym: number, code: string, down?: boolean) => void;
  sendCtrlAltDel: () => void;
  focus: () => void;
}

export function NoVNCConsole({ sessionPublicId }: NoVNCConsoleProps) {
  const [status, setStatus] = useState("Connecting…");
  const [error, setError] = useState<string | null>(null);
  const vncRef = useRef<VncHandle | null>(null);

  const sendKey = (keysym: number, code: string) => {
    vncRef.current?.sendKey(keysym, code);
    vncRef.current?.focus();
  };

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
      <div className="novnc-keybar" aria-label="Console key shortcuts">
        <button title="Send Ctrl+Alt+Delete" onClick={() => vncRef.current?.sendCtrlAltDel()}>
          Ctrl Alt Del
        </button>
        <button title="Press Windows key" onClick={() => sendKey(0xffeb, "MetaLeft")}>
          Win
        </button>
        <button title="Send Alt+Tab" onClick={() => sendCombo([{ keysym: 0xffe9, code: "AltLeft" }, { keysym: 0xff09, code: "Tab" }])}>
          Alt Tab
        </button>
        <button title="Send Windows+R" onClick={() => sendCombo([{ keysym: 0xffeb, code: "MetaLeft" }, { keysym: 0x0072, code: "KeyR" }])}>
          Win R
        </button>
        <button title="Send Windows+L" onClick={() => sendCombo([{ keysym: 0xffeb, code: "MetaLeft" }, { keysym: 0x006c, code: "KeyL" }])}>
          Win L
        </button>
        <button title="Send Escape" onClick={() => sendKey(0xff1b, "Escape")}>
          Esc
        </button>
      </div>
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
}
