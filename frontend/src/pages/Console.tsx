import { ChangeEvent, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api, AuthUser, SessionView } from "../api";
import { formatRemaining } from "../components/Brand";
import {
  ConsoleKeyHandle,
  MAX_TYPE_LENGTH,
  NoVNCConsole,
  PERFORMANCE_LABELS,
  PerformanceMode,
} from "../components/NoVNCConsole";

interface Props { user: AuthUser; onExit: () => void }

// Typical provisioning takes ~90 seconds — we use this as our ETA baseline.
const PROVISION_ETA_SECONDS = 90;
const CLIPBOARD_HISTORY_KEY = "wcta.console.clipboardHistory";
// The QEMU guest agent caps file-write payloads; stay under it after base64.
const MAX_FILE_BYTES = 44 * 1024;

type ScalingMode = "scale" | "viewport" | "native";

const SCALING_LABELS: Record<ScalingMode, string> = {
  viewport: "Fit window",
  scale: "Fit + resize VM",
  native: "Actual size",
};

function loadClipboardHistory(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(CLIPBOARD_HISTORY_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

function saveClipboardHistory(items: string[]) {
  try {
    localStorage.setItem(CLIPBOARD_HISTORY_KEY, JSON.stringify(items.slice(0, 8)));
  } catch {
    /* private browsing, quota — the history is a convenience, not state */
  }
}

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
  const etaLabel = remaining > 0 ? `~${remaining}s remaining` : "Almost ready…";

  const stageLabel =
    session.status === "queued"        ? "Queued — waiting for a slot"
    : session.status === "provisioning" ? "Provisioning — cloning & booting"
    : session.status;

  return (
    <div className="startup-overlay">
      <div className="startup-card">
        <span className="k">Preparing environment</span>
        <div className="startup-title">{session.templateName}</div>
        <div className="startup-stage">{stageLabel}</div>
        <div className="startup-bar-track">
          <div className="startup-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="startup-eta"><span>{etaLabel}</span><span>{pct}%</span></div>
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
            {pwVisible ? "Hide" : "Show"}
          </button>
        </span>
      )}
    </div>
  );
}

function TimeLeft({ session, onExtend, canExtend }: {
  session: SessionView;
  onExtend: () => void;
  canExtend: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const msLeft = new Date(session.hardExpiresAt).getTime() - now;
  const minutes = msLeft / 60000;
  const cls = minutes < 5 ? "critical" : minutes < 15 ? "low" : "";
  return (
    <>
      <span className={`time-left ${cls}`} title={`Session ends ${new Date(session.hardExpiresAt).toLocaleString()}`}>
        T−{formatRemaining(msLeft)}
      </span>
      {canExtend && (
        <button onClick={onExtend} title="Add time to this session (once per session)">
          Extend
        </button>
      )}
    </>
  );
}

function StopModal({ templateName, busy, onCancel, onConfirm }: {
  templateName: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (notes: string) => void;
}) {
  const [notes, setNotes] = useState("");
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <span className="k">End session</span>
        <h3>Stop {templateName}?</h3>
        <p>
          The VM is deleted and unsaved work is lost. Before you go, jot down
          what you found or fixed — your coach can read it later.
        </p>
        <textarea
          autoFocus
          placeholder="Debrief notes (optional) — findings, fixes, where you got stuck…"
          value={notes}
          maxLength={4000}
          onChange={(e) => setNotes(e.target.value)}
        />
        <div className="modal-actions">
          <button onClick={onCancel} disabled={busy}>Keep working</button>
          <button className="danger" onClick={() => onConfirm(notes)} disabled={busy}>
            {busy ? "Stopping…" : "Stop VM"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DemoModal({ busy, onCancel, onConfirm }: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: (title: string) => void;
}) {
  const [title, setTitle] = useState("");
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <span className="k">Demo mode</span>
        <h3>Broadcast this screen?</h3>
        <p>
          Everyone signed in will get a <strong>Watch demo</strong> button on
          their dashboard that opens this console read-only. They can see your
          screen; they cannot type, click, or read the VM's login. Only one
          demo can run at a time.
        </p>
        <input
          autoFocus
          placeholder="What are you demoing? (optional)"
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className="modal-actions">
          <button onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="primary" onClick={() => onConfirm(title)} disabled={busy}>
            {busy ? "Starting…" : "Start demo"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Console({ user, onExit }: Props) {
  const { sessionId } = useParams<{ sessionId: string }>();
  const shellRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [session, setSession] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "error"; msg: string } | null>(null);
  const [clipboardText, setClipboardText] = useState("");
  const [clipboardHistory, setClipboardHistory] = useState<string[]>(() => loadClipboardHistory());
  const [typingProgress, setTypingProgress] = useState<number | null>(null);
  // null = the user has not chosen, so fall back to whatever suits their role.
  const [scalingMode, setScalingMode] = useState<ScalingMode | null>(null);
  const [performanceMode, setPerformanceMode] = useState<PerformanceMode>("lan");
  const [stopModalOpen, setStopModalOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [demoModalOpen, setDemoModalOpen] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const consoleRef = useRef<ConsoleKeyHandle | null>(null);

  // The backend tells us whether we own this session; admins and demo
  // watchers spectate.
  const spectating = session ? session.isOwner === false : false;
  const demoActive = session?.demoActive === true;
  const isAdmin = user.role === "admin";

  /**
   * Someone working in their own VM wants a 1:1 window they can scroll, so
   * "Fit window" (which clips) is right. Someone watching a demo has no way to
   * pan and just needs the whole screen visible, so they get "Fit + resize" —
   * which, because resizeSession is gated on not being view-only, scales the
   * picture down without touching the presenter's resolution.
   */
  const effectiveScaling: ScalingMode = scalingMode ?? (spectating ? "scale" : "viewport");

  // Poll until running
  useEffect(() => {
    if (!sessionId) return;

    let cancelled = false;
    // Tracked so the error copy can tell "this was never yours" apart from
    // "the demo you were watching just ended", which look identical from here
    // — both are a 404 — but mean very different things to the reader.
    let sawSession = false;
    let wasSpectating = false;

    async function poll() {
      try {
        const s = await api.getSession(sessionId!);
        if (cancelled) return;
        sawSession = true;
        wasSpectating = s.isOwner === false;
        setSession(s);
        if (s.status !== "running" && s.status !== "failed" && s.status !== "stopped") {
          setTimeout(poll, 2500);
        }
      } catch (err) {
        if (cancelled) return;
        if (sawSession && wasSpectating) {
          setError("This session is no longer available to watch — the demo has ended.");
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    poll();
    return () => { cancelled = true; };
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || session?.status !== "running" || spectating) return;
    const interval = setInterval(() => {
      api.heartbeat(sessionId).catch(() => undefined);
    }, 10_000);
    return () => clearInterval(interval);
  }, [sessionId, session?.status, spectating]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  // Keep the fullscreen button's label honest when the user leaves fullscreen
  // with Escape rather than the button.
  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  if (!sessionId) return null;

  const isStarting = session && (session.status === "queued" || session.status === "provisioning");
  const running = session?.status === "running";
  const interactive = running && !spectating;

  const rememberClipboard = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setClipboardHistory((current) => {
      const next = [trimmed, ...current.filter((item) => item !== trimmed)].slice(0, 8);
      saveClipboardHistory(next);
      return next;
    });
  };

  const sendCombo = (keys: Array<{ keysym: number; code: string }>) =>
    consoleRef.current?.sendCombo(keys);

  /**
   * Type a string into the guest as keystrokes.
   *
   * This is not a paste. QEMU's VNC console has no clipboard channel to the
   * guest — the RFB "client cut text" message the old Paste button sent was
   * accepted by QEMU and dropped on the floor, which is why nothing ever
   * appeared in the VM. Sending the characters as key events is the only path
   * that works on every image without installing an agent inside the guest.
   */
  const typeIntoVm = async (text: string) => {
    const trimmed = text.replace(/\r\n/g, "\n");
    if (!trimmed) {
      setToast({ kind: "error", msg: "Nothing to send — type or paste some text first." });
      return;
    }
    if (typingProgress !== null) return;

    const truncated = trimmed.length > MAX_TYPE_LENGTH;
    setTypingProgress(0);
    try {
      await consoleRef.current?.typeText(trimmed, (done, total) => {
        setTypingProgress(Math.round((done / total) * 100));
      });
      rememberClipboard(trimmed);
      setToast({
        kind: "ok",
        msg: truncated
          ? `Typed the first ${MAX_TYPE_LENGTH} characters into the VM.`
          : "Typed into the VM.",
      });
    } catch (err) {
      setToast({ kind: "error", msg: err instanceof Error ? err.message : "Could not send keystrokes" });
    } finally {
      setTypingProgress(null);
    }
  };

  const typeFromLocalClipboard = async () => {
    let text = "";
    try {
      text = (await navigator.clipboard?.readText()) ?? "";
    } catch {
      setToast({
        kind: "error",
        msg: "The browser blocked clipboard access. Paste into the box with Ctrl+V, then press Send.",
      });
      return;
    }
    if (!text) {
      setToast({ kind: "error", msg: "Your clipboard is empty." });
      return;
    }
    setClipboardText(text);
    await typeIntoVm(text);
  };

  const downloadScreenshot = () => {
    const image = consoleRef.current?.takeScreenshot();
    if (!image) {
      setToast({ kind: "error", msg: "Nothing to capture yet — the console is still connecting." });
      return;
    }
    const link = document.createElement("a");
    link.href = image;
    link.download = `wctarange-${session?.templateId ?? "vm"}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setToast({ kind: "ok", msg: "Screenshot saved to your downloads." });
  };

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await shellRef.current?.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      setToast({ kind: "error", msg: "Your browser refused fullscreen for this page." });
    }
  };

  const extend = async () => {
    try {
      const updated = await api.extendSession(sessionId);
      setSession(updated);
      setToast({ kind: "ok", msg: "Session extended." });
    } catch (err) {
      setToast({ kind: "error", msg: err instanceof Error ? err.message : "Could not extend" });
    }
  };

  const setDemo = async (active: boolean, title?: string) => {
    setDemoBusy(true);
    try {
      await api.setDemoMode(sessionId, active, title);
      setSession((current) => (current ? { ...current, demoActive: active, demoTitle: title ?? null } : current));
      setToast({
        kind: "ok",
        msg: active
          ? "Demo mode on — everyone can now watch this screen."
          : "Demo mode off.",
      });
      setDemoModalOpen(false);
    } catch (err) {
      setToast({ kind: "error", msg: err instanceof Error ? err.message : "Could not change demo mode" });
    } finally {
      setDemoBusy(false);
    }
  };

  const confirmStop = async (notes: string) => {
    setStopping(true);
    try {
      if (notes.trim()) {
        await api.saveSessionNotes(sessionId, notes.trim()).catch(() => undefined);
      }
      await api.stopSession(sessionId);
    } finally {
      setStopping(false);
      onExit();
    }
  };

  const onFilePicked = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setToast({ kind: "error", msg: `File too large — the guest agent accepts up to ${Math.floor(MAX_FILE_BYTES / 1024)} KB.` });
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      let binary = "";
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const b64 = btoa(binary);
      const res = await api.pushFileToVm(sessionId, file.name, b64);
      setToast({ kind: "ok", msg: `Sent — file landed at ${res.guestPath}` });
    } catch (err) {
      setToast({ kind: "error", msg: err instanceof Error ? err.message : "File push failed" });
    }
  };

  return (
    <div className="console-shell" ref={shellRef}>
      <div className="console-bar">
        <div className="left">
          <button onClick={onExit}>&larr; Back</button>
          <strong>{session?.templateName ?? "Loading…"}</strong>
          {session && (
            <span className={`status-pill ${session.status}`}>{session.status}</span>
          )}
          {demoActive && !spectating && <span className="demo-pill live">On air</span>}
          {running && !spectating && session && (
            <TimeLeft
              session={session}
              onExtend={extend}
              canExtend={session.extendedMinutes === 0}
            />
          )}
        </div>

        <div className="console-actions">
          {interactive && (
            <div className="console-group" aria-label="Send a key combination to the VM">
              <span className="console-group-label">Send keys</span>
              <button title="Ctrl + Alt + Delete — the Windows security screen" onClick={() => consoleRef.current?.sendCtrlAltDel()}>Ctrl+Alt+Del</button>
              <button title="The Windows key — opens the Start menu" onClick={() => consoleRef.current?.sendKey(0xffeb, "MetaLeft")}>Win</button>
              <button title="Alt + Tab — switch window" onClick={() => sendCombo([{ keysym: 0xffe9, code: "AltLeft" }, { keysym: 0xff09, code: "Tab" }])}>Alt+Tab</button>
              <button title="Windows + R — the Run box" onClick={() => sendCombo([{ keysym: 0xffeb, code: "MetaLeft" }, { keysym: 0x0072, code: "KeyR" }])}>Win+R</button>
              <button title="Windows + L — lock the VM" onClick={() => sendCombo([{ keysym: 0xffeb, code: "MetaLeft" }, { keysym: 0x006c, code: "KeyL" }])}>Win+L</button>
              <button title="Escape" onClick={() => consoleRef.current?.sendKey(0xff1b, "Escape")}>Esc</button>
            </div>
          )}

          {running && (
            <div className="console-group" aria-label="Display options">
              <span className="console-group-label">Display</span>
              <label className="console-select">
                <span className="sr-only">Screen fit</span>
                <select
                  value={effectiveScaling}
                  onChange={(e) => setScalingMode(e.target.value as ScalingMode)}
                  title="How the VM's screen is fitted into this window"
                >
                  {(Object.keys(SCALING_LABELS) as ScalingMode[]).map((mode) => (
                    <option key={mode} value={mode}>{SCALING_LABELS[mode]}</option>
                  ))}
                </select>
              </label>
              <label className="console-select">
                <span className="sr-only">Image quality</span>
                <select
                  value={performanceMode}
                  onChange={(e) => setPerformanceMode(e.target.value as PerformanceMode)}
                  title="Trade picture quality against bandwidth. Fast (LAN) is right on the club network."
                >
                  {(Object.keys(PERFORMANCE_LABELS) as PerformanceMode[]).map((mode) => (
                    <option key={mode} value={mode}>{PERFORMANCE_LABELS[mode]}</option>
                  ))}
                </select>
              </label>
              <button title="Save a PNG of the current screen" onClick={downloadScreenshot}>Screenshot</button>
              <button title="Fill the whole screen" onClick={toggleFullscreen}>
                {fullscreen ? "Exit full screen" : "Full screen"}
              </button>
            </div>
          )}

          {interactive && (
            <div className="console-group" aria-label="Session tools">
              <span className="console-group-label">Tools</span>
              <button
                title={`Drop a small file (max ${Math.floor(MAX_FILE_BYTES / 1024)} KB) onto the VM desktop`}
                onClick={() => fileInputRef.current?.click()}
              >
                Send file
              </button>
              {isAdmin && (
                <button
                  className={demoActive ? "demo-on" : ""}
                  title={
                    demoActive
                      ? "Stop broadcasting this screen"
                      : "Broadcast this screen so everyone can watch, read-only"
                  }
                  onClick={() => (demoActive ? setDemo(false) : setDemoModalOpen(true))}
                  disabled={demoBusy}
                >
                  {demoActive ? "Demo mode: ON" : "Demo mode"}
                </button>
              )}
            </div>
          )}

          {!spectating && (
            <button className="danger" onClick={() => setStopModalOpen(true)}>Stop VM</button>
          )}
        </div>
      </div>

      {spectating && session && (
        <div className={`spectate-banner ${demoActive ? "demo" : ""}`}>
          {demoActive
            ? `Watching a live demo${session.demoTitle ? ` — ${session.demoTitle}` : ""}. Read-only: your keyboard and mouse are not sent.`
            : "Spectating — read-only view. Input is disabled."}
        </div>
      )}

      {demoActive && !spectating && (
        <div className="demo-banner">
          <span className="demo-pill live">On air</span>
          <span>
            Everyone signed in can watch this screen right now. They cannot type
            or click, and they cannot see the VM login.
          </span>
          <button onClick={() => setDemo(false)} disabled={demoBusy}>End demo</button>
        </div>
      )}

      {session && !spectating && <CredentialsBadge session={session} />}

      {interactive && (
        <div className="clipboard-bar">
          <div className="clipboard-intro">
            <span className="cred-label">Send text</span>
            <span
              className="clipboard-hint"
              title="QEMU's console has no shared clipboard with the guest, so text is delivered as real keystrokes instead. Ctrl+C and Ctrl+V work normally inside the VM."
            >
              typed as keystrokes
            </span>
          </div>
          <input
            placeholder="Type or paste text here, then press Send to VM"
            value={clipboardText}
            maxLength={MAX_TYPE_LENGTH}
            disabled={typingProgress !== null}
            onChange={(e) => setClipboardText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void typeIntoVm(clipboardText);
              }
            }}
          />
          <button
            className="primary"
            disabled={typingProgress !== null || !clipboardText.trim()}
            onClick={() => void typeIntoVm(clipboardText)}
            title="Type the text above into the VM, character by character"
          >
            {typingProgress !== null ? `Sending… ${typingProgress}%` : "Send to VM"}
          </button>
          <button
            disabled={typingProgress !== null}
            onClick={() => void typeFromLocalClipboard()}
            title="Read your computer's clipboard and type it into the VM"
          >
            From my clipboard
          </button>
          <select
            value=""
            aria-label="Recently sent text"
            disabled={typingProgress !== null || clipboardHistory.length === 0}
            onChange={(e) => {
              const value = e.target.value;
              if (!value) return;
              setClipboardText(value);
              void typeIntoVm(value);
            }}
          >
            <option value="">
              {clipboardHistory.length === 0 ? "No recent text" : "Recent…"}
            </option>
            {clipboardHistory.map((item) => (
              <option key={item} value={item}>{item.length > 60 ? `${item.slice(0, 57)}…` : item}</option>
            ))}
          </select>
        </div>
      )}

      {error && <div className="empty">{error}</div>}

      {!error && isStarting && <StartupProgress session={session!} />}

      {!error && session && running && (
        <NoVNCConsole
          ref={consoleRef}
          sessionPublicId={sessionId}
          scalingMode={effectiveScaling}
          performanceMode={performanceMode}
          viewOnly={spectating}
        />
      )}

      {!error && session && !running && !isStarting && (
        <div className="empty">
          Session is {session.status}. {session.failureReason ?? ""}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        style={{ display: "none" }}
        onChange={onFilePicked}
      />

      {stopModalOpen && session && (
        <StopModal
          templateName={session.templateName}
          busy={stopping}
          onCancel={() => setStopModalOpen(false)}
          onConfirm={confirmStop}
        />
      )}

      {demoModalOpen && (
        <DemoModal
          busy={demoBusy}
          onCancel={() => setDemoModalOpen(false)}
          onConfirm={(title) => void setDemo(true, title)}
        />
      )}

      {toast && <div className={`toast ${toast.kind}`}>{toast.msg}</div>}
    </div>
  );
}
