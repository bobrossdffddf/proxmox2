import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, SessionView } from "../api";
import { RDPCanvas } from "../components/RDPCanvas";
import { NoVNCConsole } from "../components/NoVNCConsole";

interface Props { onExit: () => void }

export function Console({ onExit }: Props) {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [session, setSession] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"rdp" | "console">("rdp");

  useEffect(() => {
    if (!sessionId) return;
    api.getSession(sessionId)
      .then((s) => {
        setSession(s);
        if (s.protocol === "vnc") {
          setViewMode("console");
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [sessionId]);

  async function stop() {
    if (!sessionId) return;
    if (!confirm("Stop this VM? Unsaved work will be lost.")) return;
    try { await api.stopSession(sessionId); } finally { onExit(); }
  }

  if (!sessionId) return null;

  return (
    <div className="console-shell">
      <div className="console-bar">
        <div className="left">
          <button onClick={onExit}>&larr; Back</button>
          <strong>{session?.templateName ?? "Loading..."}</strong>
          {session && (
            <>
              <span className={`status-pill ${session.status}`}>{session.status}</span>
              <div className="view-toggle">
                <button 
                  className={viewMode === "rdp" ? "active" : ""}
                  onClick={() => setViewMode("rdp")}
                >
                  Remote Desktop
                </button>
                <button 
                  className={viewMode === "console" ? "active" : ""}
                  onClick={() => setViewMode("console")}
                >
                  Console (noVNC)
                </button>
              </div>
            </>
          )}
        </div>
        <div>
          <button className="danger" onClick={stop}>Stop VM</button>
        </div>
      </div>

      {error && <div className="empty">{error}</div>}
      {!error && session && session.status === "running" && (
        <>
          {viewMode === "rdp" ? (
            <RDPCanvas sessionId={sessionId} />
          ) : (
            <NoVNCConsole sessionPublicId={sessionId} />
          )}
        </>
      )}
      {!error && session && session.status !== "running" && (
        <div className="empty">
          Session is {session.status}. {session.failureReason ?? ""}
        </div>
      )}
    </div>
  );
}
