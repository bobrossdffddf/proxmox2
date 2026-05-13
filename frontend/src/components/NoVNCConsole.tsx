import { useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc/core/rfb";

interface NoVNCConsoleProps {
  sessionPublicId: string;
}

export function NoVNCConsole({ sessionPublicId }: NoVNCConsoleProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [status, setStatus] = useState("Connecting...");

  useEffect(() => {
    if (!containerRef.current) return;

    const token = localStorage.getItem("token");
    if (!token) {
      setStatus("No authentication token found");
      return;
    }

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/ws/novnc?session=${sessionPublicId}&token=${token}`;

    try {
      const rfb = new RFB(containerRef.current, url, {
        credentials: { password: "" }, // Password (ticket) is handled by the backend proxy
      });

      rfb.scaleViewport = true;
      rfb.resizeSession = true;

      rfb.addEventListener("connect", () => {
        setStatus("Connected");
      });

      rfb.addEventListener("disconnect", (e: any) => {
        if (e.detail.clean) {
          setStatus("Disconnected");
        } else {
          setStatus("Connection failure");
        }
      });

      rfbRef.current = rfb;
    } catch (err) {
      console.error("Failed to initialize noVNC:", err);
      setStatus("Initialization error");
    }

    return () => {
      if (rfbRef.current) {
        rfbRef.current.disconnect();
        rfbRef.current = null;
      }
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
