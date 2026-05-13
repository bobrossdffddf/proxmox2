import { useRef, useState } from "react";
import { VncScreen } from "react-vnc";
import { getToken } from "../api";

interface NoVNCConsoleProps {
  sessionPublicId: string;
}

export function NoVNCConsole({ sessionPublicId }: NoVNCConsoleProps) {
  const [status, setStatus] = useState("Connecting...");
  const vncRef = useRef<any>(null);

  const token = getToken();
  if (!token) {
    return <div className="console-canvas-wrap"><div className="console-status">No auth token</div></div>;
  }

  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${window.location.host}/ws/novnc?session=${sessionPublicId}&token=${token}`;

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
          setStatus(e?.detail?.clean ? "Disconnected" : "Connection lost");
        }}
        onSecurityFailure={(e: any) => {
          setStatus(`Security error: ${e?.detail?.reason ?? "unknown"}`);
        }}
      />
    </div>
  );
}
