import { useEffect, useRef, useState } from "react";
import { getToken } from "../api";

interface NoVNCConsoleProps {
  sessionPublicId: string;
}

export function NoVNCConsole({ sessionPublicId }: NoVNCConsoleProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<any>(null);
  const [status, setStatus] = useState("Connecting...");

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;

    const token = getToken();
    if (!token) {
      setStatus("No authentication token found");
      return;
    }

    async function connect() {
      try {
        // Dynamic import to avoid type issues with the plain JS library
        const { default: RFB } = await import("@novnc/novnc/core/rfb");
        if (cancelled || !containerRef.current) return;

        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const url = `${proto}//${window.location.host}/ws/novnc?session=${sessionPublicId}&token=${token}`;

        const rfb = new RFB(containerRef.current, url);

        rfb.scaleViewport = true;
        rfb.resizeSession = false; // Don't try to resize the VM display

        rfb.addEventListener("connect", () => {
          if (!cancelled) setStatus("Connected");
        });

        rfb.addEventListener("disconnect", (e: any) => {
          if (cancelled) return;
          if (e.detail?.clean) {
            setStatus("Disconnected");
          } else {
            setStatus("Connection lost");
          }
        });

        rfb.addEventListener("securityfailure", (e: any) => {
          if (!cancelled) setStatus(`Security error: ${e.detail?.reason ?? "unknown"}`);
        });

        rfbRef.current = rfb;
      } catch (err) {
        console.error("Failed to initialize noVNC:", err);
        if (!cancelled) setStatus("Failed to load noVNC viewer");
      }
    }

    void connect();

    return () => {
      cancelled = true;
      try {
        rfbRef.current?.disconnect();
      } catch { /* ignore */ }
      rfbRef.current = null;
    };
  }, [sessionPublicId]);

  return (
    <div className="console-canvas-wrap">
      <div className="console-status-overlay">
        Console: {status}
      </div>
      <div 
        ref={containerRef} 
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  );
}
