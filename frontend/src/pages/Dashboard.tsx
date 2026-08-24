import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Announcement, api, AuthUser, LiveDemo, SessionView, TileTemplate } from "../api";
import { formatRemaining, TopClock, Wordmark } from "../components/Brand";
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
  const stageLabel = session.status === "queued" ? "Queued" : "Provisioning";

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
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [demo, setDemo] = useState<LiveDemo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "error"; msg: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
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
        if (prev && prev !== "running" && session.status === "running") {
          navigate(`/console/${session.id}`);
          return;
        }
      }
      const next = new Map<string, string>();
      for (const session of s) next.set(session.id, session.status);
      prevSessionsRef.current = next;
    } catch {
      // ignore — handled by global 401 redirect
    }
  }, [navigate]);

  const loadTemplates = useCallback(() => {
    api.templates().then(setTemplates).catch((err) =>
      setToast({ kind: "error", msg: err.message ?? "Failed to load templates" })
    );
  }, []);

  // Demo mode is something an admin flips on mid-class, so this has to appear
  // without a reload. It rides the same visibility-gated interval as the rest.
  const loadDemo = useCallback(() => {
    api.liveDemo().then(setDemo).catch(() => undefined);
  }, []);

  useEffect(() => {
    loadTemplates();
    loadDemo();
    api.announcements().then(setAnnouncements).catch(() => undefined);
    refresh();
    // Only poll while the tab is visible; catch up immediately on return.
    const i = setInterval(() => {
      if (!document.hidden) refresh();
    }, 3000);
    // Availability changes as staged VMs are claimed/refilled — refresh slower.
    const t = setInterval(() => {
      if (!document.hidden) { loadTemplates(); loadDemo(); }
    }, 15000);
    const onVisible = () => {
      if (!document.hidden) { refresh(); loadTemplates(); loadDemo(); }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(i);
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, loadTemplates, loadDemo]);

  // Tick the expiry countdowns while sessions are visible
  useEffect(() => {
    if (sessions.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [sessions.length > 0]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const launch = useCallback(async (templateId: string) => {
    setBusy(templateId);
    try {
      const result = await api.requestVm(templateId);
      setToast({ kind: "ok", msg: "VM ready." });
      await refresh();
      navigate(`/console/${result.sessionId}`);
    } catch (err) {
      setToast({ kind: "error", msg: err instanceof Error ? err.message : "Failed" });
    } finally {
      setBusy(null);
    }
  }, [navigate, refresh]);

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

  const readyTotal = templates.reduce((sum, t) => sum + t.ready_count, 0);
  const running = sessions.filter((s) => s.status === "running").length;

  return (
    <div className="app-shell">
      <header className="topbar">
        <Wordmark />
        <TopClock />
        <div className="user-strip">
          <span className="who"><strong>{user.username}</strong> / {user.role}</span>
          {user.role === "admin" && <Link to="/admin"><button>Admin</button></Link>}
          <button className="ghost" onClick={onSignOut}>Sign out</button>
        </div>
      </header>

      <main className="content">
        <div className="page-head">
          <div>
            <h1>Practice images</h1>
            <p className="subtitle">
              Pick an image to open a disposable sandbox. Every VM is wiped when the session ends.
            </p>
          </div>
        </div>

        {/* The admin running the demo is already looking at it — don't invite
            them to watch themselves. */}
        {demo && demo.host !== user.username && (
          <div className="demo-live-banner">
            <span className="demo-pill live">Live</span>
            <div className="demo-live-copy">
              <div className="name">{demo.title || `${demo.templateName} demo`}</div>
              <div className="meta">
                {demo.host} is demonstrating {demo.templateName}. You'll watch read-only.
              </div>
            </div>
            <button className="primary" onClick={() => navigate(`/console/${demo.sessionId}`)}>
              Watch demo
            </button>
          </div>
        )}

        {announcements.length > 0 && (
          <div className="announcement-stack">
            {announcements.map((announcement) => (
              <div key={announcement.id} className="announcement-banner">
                <div className="name">{announcement.title}</div>
                <div className="meta">{announcement.message}</div>
              </div>
            ))}
          </div>
        )}

        <div className="readout-strip">
          <div className="readout">
            <span className="k">Images</span>
            <div className="val">{templates.length}</div>
          </div>
          <div className="readout">
            <span className="k">Warm &amp; ready</span>
            <div className={`val ${readyTotal > 0 ? "good" : ""}`}>{readyTotal}</div>
          </div>
          <div className="readout">
            <span className="k">Your active VMs</span>
            <div className={`val ${running > 0 ? "signal" : ""}`}>{sessions.length}</div>
          </div>
        </div>

        <div className="section-head">
          <span className="idx">01</span>
          <h2>Launch an image</h2>
          <span className="aux">{templates.length} configured</span>
        </div>

        {templates.length === 0 ? (
          <div className="empty">
            No practice images configured. Ask an admin to edit config/templates.yaml.
          </div>
        ) : (
          <div className="tile-grid">
            {templates.map((t, i) => (
              <VMTile key={t.id} tpl={t} ordinal={i + 1} busy={busy === t.id} onLaunch={launch} />
            ))}
          </div>
        )}

        <div className="section-head">
          <span className="idx">02</span>
          <h2>Your sessions</h2>
          <span className="aux">{sessions.length} active</span>
        </div>

        {sessions.length === 0 ? (
          <div className="empty">No active sessions.</div>
        ) : (
          <div className="session-strip">
            {sessions.map((s) => {
              const msLeft = new Date(s.hardExpiresAt).getTime() - now;
              return (
                <div key={s.id} className="session-row">
                  <div>
                    <div className="name">{s.templateName}</div>
                    <div className="meta">
                      started {new Date(s.createdAt).toLocaleTimeString()} on {s.proxmoxNode}
                    </div>
                    {isStarting(s) && <SessionProgress session={s} />}
                  </div>
                  <div><span className={`status-pill ${s.status}`}>{s.status}</span></div>
                  <div className="mono-cell">{s.protocol}</div>
                  <div className="mono-cell" title={`Hard expiry ${new Date(s.hardExpiresAt).toLocaleString()}`}>
                    {s.status === "running" ? `${formatRemaining(msLeft)} left` : ""}
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
              );
            })}
          </div>
        )}
      </main>

      {toast && <div className={`toast ${toast.kind}`}>{toast.msg}</div>}
    </div>
  );
}
