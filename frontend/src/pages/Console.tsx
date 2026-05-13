import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api, SessionView } from "../api";
import { ConsoleKeyHandle, NoVNCConsole } from "../components/NoVNCConsole";

interface Props { onExit: () => void }

// Typical provisioning takes ~90 seconds — we use this as our ETA baseline.
const PROVISION_ETA_SECONDS = 90;

function StartupProgress({ session }: { session: SessionView }) {
  const startRef = useRef(new Date(session.createdAt).getTime());
  const [elapsed, setElapsed] = useState(
    () => Math.floor((Date.now() - startRef.current) / 1000)
  );

  useEffect(() => {
    const t = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 500);
    return () => clearInterval(t);
  }, []);

  const pct = Math.min(100, Math.round((elapsed / PROVISION_ETA_SECONDS) * 100));
  const remaining = Math.max(0, PROVISION_ETA_SECONDS - elapsed);
  const etaLabel = remaining > 0
    ? `~${remaining}s remaining`
    : "Almost ready…";

  const stageLabel =
    session.status === "queued"       ? "Queued — waiting for a slot…"
    : session.status === "provisioning" ? "Provisioning VM — cloning & booting…"
    : session.status;

  return (
    <div className="startup-overlay">
      <div className="startup-card">
        <div className="startup-spinner" />
        <div className="startup-title">{session.templateName}</div>
        <div className="startup-stage">{stageLabel}</div>
        <div className="startup-bar-track">
          <div className="startup-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="startup-eta">{etaLabel} &nbsp;·&nbsp; {pct}%</div>
      </div>
    </div>
  );
}

function CredentialsBadge({ session }: { session: SessionView }) {
  const [pwVisible, setPwVisible] = useState(false);
  if (!session.guestUsername && !session.guestPassword) return null;
  return (
    <div className="cred-banner">
      <span className="cred-label">VM Login</span>
      {session.guestUsername && (
        <span className="cred-item">
          <span className="cred-key">User</span>
          <code className="cred-val">{session.guestUsername}</code>
        </span>
      )}
      {session.guestPassword && (
        <span className="cred-item">
          <span className="cred-key">Pass</span>
          <code className="cred-val">
            {pwVisible ? session.guestPassword : "••••••••••"}
          </code>
          <button
            className="cred-toggle"
            onClick={() => setPwVisible((v) => !v)}
            title={pwVisible ? "Hide password" : "Show password"}
          >
            {pwVisible ? "🙈" : "👁"}
          </button>
        </span>
      )}
    </div>
  );
}

export function Console({ onExit }: Props) {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [session, setSession] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const consoleRef = useRef<ConsoleKeyHandle | null>(null);

  // Poll until running
  useEffect(() => {
    if (!sessionId) return;

    let cancelled = false;
    async function poll() {
      try {
        const s = await api.getSession(sessionId!);
        if (cancelled) return;
        setSession(s);
        if (s.status !== "running" && s.status !== "failed" && s.status !== "stopped") {
          setTimeout(poll, 2500);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }
    poll();
    return () => { cancelled = true; };
  }, [sessionId]);

  async function stop() {
    if (!sessionId) return;
    if (!confirm("Stop this VM? Unsaved work will be lost.")) return;
    try { await api.stopSession(sessionId); } finally { onExit(); }
  }

  if (!sessionId) return null;

  const isStarting = session && (session.status === "queued" || session.status === "provisioning");
  const sendCombo = (keys: Array<{ keysym: number; code: string }>) => consoleRef.current?.sendCombo(keys);

  return (
    <div className="console-shell">
      <div className="console-bar">
        <div className="left">
          <button onClick={onExit}>&larr; Back</button>
          <strong>{session?.templateName ?? "Loading…"}</strong>
          {session && (
            <span className={`status-pill ${session.status}`}>{session.status}</span>
          )}
        </div>
        <div className="console-actions">
          {session?.status === "running" && (
            <div className="console-key-actions" aria-label="Console key shortcuts">
              <span>Keyboard</span>
              <button title="Send Ctrl+Alt+Delete" onClick={() => consoleRef.current?.sendCtrlAltDel()}>Ctrl Alt Del</button>
              <button title="Press Windows key" onClick={() => consoleRef.current?.sendKey(0xffeb, "MetaLeft")}>Win</button>
              <button title="Send Alt+Tab" onClick={() => sendCombo([{ keysym: 0xffe9, code: "AltLeft" }, { keysym: 0xff09, code: "Tab" }])}>Alt Tab</button>
              <button title="Send Windows+R" onClick={() => sendCombo([{ keysym: 0xffeb, code: "MetaLeft" }, { keysym: 0x0072, code: "KeyR" }])}>Win R</button>
              <button title="Send Windows+L" onClick={() => sendCombo([{ keysym: 0xffeb, code: "MetaLeft" }, { keysym: 0x006c, code: "KeyL" }])}>Win L</button>
              <button title="Send Escape" onClick={() => consoleRef.current?.sendKey(0xff1b, "Escape")}>Esc</button>
            </div>
          )}
          <button className="danger" onClick={stop}>Stop VM</button>
        </div>
      </div>

      {session && <CredentialsBadge session={session} />}

      {error && <div className="empty">{error}</div>}

      {!error && isStarting && <StartupProgress session={session!} />}

      {!error && session && session.status === "running" && (
        <NoVNCConsole ref={consoleRef} sessionPublicId={sessionId} />
      )}

      {!error && session && session.status !== "running" && !isStarting && (
        <div className="empty">
          Session is {session.status}. {session.failureReason ?? ""}
        </div>
      )}
    </div>
  );
}
