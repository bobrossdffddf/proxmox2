import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, SessionView } from "../api";
import { RDPCanvas } from "../components/RDPCanvas";

interface Props { onExit: () => void }

export function Console({ onExit }: Props) {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [session, setSession] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    api.getSession(sessionId)
      .then(setSession)
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
            <span className={`status-pill ${session.status}`}>{session.status}</span>
          )}
        </div>
        <div>
          <button className="danger" onClick={stop}>Stop VM</button>
        </div>
      </div>

      {error && <div className="empty">{error}</div>}
      {!error && session && session.status === "running" && (
        <RDPCanvas sessionId={sessionId} />
      )}
      {!error && session && session.status !== "running" && (
        <div className="empty">
          Session is {session.status}. {session.failureReason ?? ""}
        </div>
      )}
    </div>
  );
}
