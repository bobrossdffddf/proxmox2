import { useEffect, useState } from "react";

/** Reticle mark — the brand glyph. */
export function Glyph({ className }: { className?: string }) {
  return (
    <svg className={className ?? "glyph"} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="7.2" />
      <path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4" strokeLinecap="round" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function Wordmark({ tag }: { tag?: string }) {
  return (
    <span className="wordmark">
      <Glyph />
      WCTA&nbsp;RANGE
      {tag && <span className="tag">{tag}</span>}
    </span>
  );
}

/** Live clock for the top bar — mission-control furniture. */
export function TopClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const date = now.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "2-digit" }).toUpperCase();
  return (
    <span className="topbar-clock" aria-hidden="true">
      {date} <strong>{hh}:{mm}</strong>:{ss}
    </span>
  );
}

/** mm:ss / h:mm countdown, used for session time remaining. */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return "00:00";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
