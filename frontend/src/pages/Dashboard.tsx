import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, AuthUser, SessionView, TileTemplate } from "../api";
import { VMTile } from "../components/VMTile";

interface Props { user: AuthUser; onSignOut: () => void }

const PROVISION_ETA_SECONDS = 90;

function SessionProgress({ session }: { session: SessionView }) {
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

  const pct = Math.min(97, Math.round((elapsed / PROVISION_ETA_SECONDS) * 100));
  const remaining = Math.max(0, PROVISION_ETA_SECONDS - elapsed);
  const etaLabel = remaining > 0 ? `~${remaining}s` : "Almost ready…";
  const stageLabel = session.status === "queued" ? "Queued" : "Provisioning…";

  return (
    <div className="session-progress">
      <div className="session-progress-header">
        <span>{stageLabel}</span>
        <span>{etaLabel} · {pct}%</span>
      </div>
      <div className="session-progress-track">
        <div className="session-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Dashboard({ user, onSignOut }: Props) {
  const [templates, setTemplates] = useState<TileTemplate[]>([]);
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "error"; msg: string } | null>(null);
  const navigate = useNavigate();

  // Track which sessions were previously not-running so we can auto-navigate
  const prevSessionsRef = useRef<Map<string, string>>(new Map());

  const refresh = useCallback(async () => {
    try {
      const s = await api.listSessions();
      setSessions(s);

      // Auto-navigate to console if a session just became "running"
      for (const session of s) {
        const prev = prevSessionsRef.current.get(session.id);
        if (
          prev &&
          prev !== "running" &&
          session.status === "running"
        ) {
          navigate(`/console/${session.id}`);
          return;
        }
      }
      // Update ref
      const next = new Map<string, string>();
      for (const session of s) next.set(session.id, session.status);
      prevSessionsRef.current = next;
    } catch {
      // ignore — handled by global 401 redirect
    }
  }, [navigate]);

  useEffect(() => {
    api.templates().then(setTemplates).catch((err) =>
      setToast({ kind: "error", msg: err.message ?? "Failed to load templates" })
    );
    refresh();
    const i = setInterval(refresh, 3000);
    return () => clearInterval(i);
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const launch = useCallback(async (templateId: string) => {
    setBusy(templateId);
    try {
      await api.requestVm(templateId);
      setToast({ kind: "ok", msg: "VM requested — it will appear below." });
      await refresh();
    } catch (err) {
      setToast({ kind: "error", msg: err instanceof Error ? err.message : "Failed" });
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const stop = useCallback(async (publicId: string) => {
    if (!confirm("Stop this VM? Unsaved work will be lost.")) return;
    try {
      await api.stopSession(publicId);
      setToast({ kind: "ok", msg: "Stop requested. VM is cleaning up." });
      await refresh();
    } catch (err) {
      setToast({ kind: "error", msg: err instanceof Error ? err.message : "Failed" });
    }
  }, [refresh]);

  const isStarting = (s: SessionView) =>
    s.status === "queued" || s.status === "provisioning";

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="logo">WCTA<span className="accent">RANGE</span></div>
        <div className="user-strip">
          <span>signed in as <strong>{user.username}</strong> ({user.role})</span>
          {user.role === "admin" && <Link to="/admin"><button>Admin</button></Link>}
          <button onClick={onSignOut}>Sign out</button>
        </div>
      </header>

      <main className="content">
        <h1>Practice images</h1>
        <p className="subtitle">
          Click a tile to spin up a fresh, sandboxed clone. Snapshots reset on exit, so it's safe to break things.
        </p>

        {templates.length === 0 ? (
          <div className="empty">
            No practice images configured. Ask an admin to edit <code>config/templates.yaml</code>.
          </div>
        ) : (
          <div className="tile-grid">
            {templates.map((t) => (
              <VMTile key={t.id} tpl={t} busy={busy === t.id} onLaunch={launch} />
            ))}
          </div>
        )}

        <h2>Your active sessions</h2>
        {sessions.length === 0 ? (
          <div className="empty">No active sessions.</div>
        ) : (
          <div className="session-strip">
            {sessions.map((s) => (
              <div key={s.id} className="session-row">
                <div>
                  <div className="name">{s.templateName}</div>
                  <div className="meta">
                    started {new Date(s.createdAt).toLocaleTimeString()} on {s.proxmoxNode}
                  </div>
                  {isStarting(s) && <SessionProgress session={s} />}
                </div>
                <div><span className={`status-pill ${s.status}`}>{s.status}</span></div>
                <div className="meta">{s.protocol.toUpperCase()}</div>
                <div className="meta">
                  expires {new Date(s.hardExpiresAt).toLocaleTimeString()}
                </div>
                <div className="actions">
                  {s.status === "running" ? (
                    <Link to={`/console/${s.id}`}>
                      <button className="primary">Open</button>
                    </Link>
                  ) : isStarting(s) ? (
                    <Link to={`/console/${s.id}`}>
                      <button className="primary">Watch</button>
                    </Link>
                  ) : (
                    <button disabled>Open</button>
                  )}
                  <button className="danger" onClick={() => stop(s.id)}>Stop</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {toast && <div className={`toast ${toast.kind}`}>{toast.msg}</div>}
    </div>
  );
}

