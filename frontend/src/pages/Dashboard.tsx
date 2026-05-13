import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, AuthUser, SessionView, TileTemplate } from "../api";
import { VMTile } from "../components/VMTile";

interface Props { user: AuthUser; onSignOut: () => void }

export function Dashboard({ user, onSignOut }: Props) {
  const [templates, setTemplates] = useState<TileTemplate[]>([]);
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "error"; msg: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api.listSessions();
      setSessions(s);
    } catch (err) {
      // ignore — handled by global 401 redirect
    }
  }, []);

  useEffect(() => {
    api.templates().then(setTemplates).catch((err) =>
      setToast({ kind: "error", msg: err.message ?? "Failed to load templates" })
    );
    refresh();
    const i = setInterval(refresh, 4000);
    return () => clearInterval(i);
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const launch = useCallback(async (templateId: string) => {
    setBusy(templateId);
    try {
      await api.requestVm(templateId);
      setToast({ kind: "ok", msg: "VM requested. It will appear below in a moment." });
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
      await refresh();
    } catch (err) {
      setToast({ kind: "error", msg: err instanceof Error ? err.message : "Failed" });
    }
  }, [refresh]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="logo">WCTA<span className="accent">RANGE</span></div>
        <div className="user-strip">
          <span>signed in as <strong>{user.username}</strong> ({user.role})</span>
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
