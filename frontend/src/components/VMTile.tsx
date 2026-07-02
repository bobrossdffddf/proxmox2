import { memo } from "react";
import { TileTemplate } from "../api";

interface Props {
  tpl: TileTemplate;
  busy: boolean;
  onLaunch: (id: string) => void;
}

const ICON_PATHS: Record<TileTemplate["icon"], JSX.Element> = {
  windows: (
    // Four-pane window
    <>
      <path d="M4 5.5 11 4.5v6.5H4z" />
      <path d="M13 4.2 20 3.2v7.8h-7z" />
      <path d="M4 13h7v6.5l-7-1z" />
      <path d="M13 13h7v7.8l-7-1z" />
    </>
  ),
  linux: (
    // Terminal prompt
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="m7 9 3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.5 15H17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </>
  ),
  server: (
    // Rack unit
    <>
      <rect x="3" y="4" width="18" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="7" cy="7.5" r="1" />
      <circle cx="7" cy="16.5" r="1" />
    </>
  ),
  network: (
    // Linked nodes
    <>
      <circle cx="12" cy="5" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="5" cy="18" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="19" cy="18" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M10.9 7 6.2 16M13.1 7l4.7 9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </>
  ),
  generic: (
    // Monitor
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9 20h6M12 16.5V20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </>
  ),
};

export const VMTile = memo(function VMTile({ tpl, busy, onLaunch }: Props) {
  return (
    <div
      className={`tile ${busy ? "busy" : ""}`}
      onClick={() => !busy && onLaunch(tpl.id)}
      style={tpl.color ? ({ borderColor: tpl.color } as React.CSSProperties) : undefined}
      role="button"
      tabIndex={0}
      aria-label={`Launch ${tpl.name}`}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !busy) {
          e.preventDefault();
          onLaunch(tpl.id);
        }
      }}
    >
      <div className="icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="currentColor">{ICON_PATHS[tpl.icon]}</svg>
      </div>
      <span className="launch-hint" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </span>
      <div className="name">{tpl.name}</div>
      <div className="desc">{tpl.description}</div>
      {busy && (
        <div className="tile-startup">
          <div className="tile-startup-label">Starting VM…</div>
          <div className="tile-startup-track"><div className="tile-startup-fill" /></div>
        </div>
      )}
      <div className="meta">
        <span>{tpl.cpu_cores} vCPU</span>
        <span>{Math.round(tpl.memory_mb / 1024)} GB RAM</span>
        <span>{tpl.protocol.toUpperCase()}</span>
      </div>
    </div>
  );
});
