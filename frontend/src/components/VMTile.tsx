import { memo } from "react";
import { TileTemplate } from "../api";

interface Props {
  tpl: TileTemplate;
  ordinal: number;
  busy: boolean;
  onLaunch: (id: string) => void;
}

const ICON_PATHS: Record<TileTemplate["icon"], JSX.Element> = {
  windows: (
    // Four-pane window
    <g fill="currentColor" stroke="none">
      <path d="M4 5.5 11 4.5v6.5H4z" />
      <path d="M13 4.2 20 3.2v7.8h-7z" />
      <path d="M4 13h7v6.5l-7-1z" />
      <path d="M13 13h7v7.8l-7-1z" />
    </g>
  ),
  linux: (
    // Terminal prompt
    <>
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="m7 9 3 3-3 3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.5 15H17" strokeLinecap="round" />
    </>
  ),
  server: (
    // Rack units
    <>
      <rect x="3" y="4" width="18" height="7" rx="1" />
      <rect x="3" y="13" width="18" height="7" rx="1" />
      <circle cx="7" cy="7.5" r="0.4" fill="currentColor" />
      <circle cx="7" cy="16.5" r="0.4" fill="currentColor" />
    </>
  ),
  network: (
    // Linked nodes
    <>
      <circle cx="12" cy="5" r="2.2" />
      <circle cx="5" cy="18" r="2.2" />
      <circle cx="19" cy="18" r="2.2" />
      <path d="M10.9 7 6.2 16M13.1 7l4.7 9" strokeLinecap="round" />
    </>
  ),
  generic: (
    // Monitor
    <>
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="M9 20h6M12 16.5V20" strokeLinecap="round" />
    </>
  ),
};

export const VMTile = memo(function VMTile({ tpl, ordinal, busy, onLaunch }: Props) {
  const ready = tpl.ready_count > 0;
  // A template whose staging keeps failing used to be indistinguishable from
  // one that was merely between clones: both said "Warming up", forever. Now
  // the tile says so, and stops pretending it is about to become available.
  const stalled = tpl.stalled && !ready;
  const disabled = busy || stalled;

  const launch = () => { if (!disabled) onLaunch(tpl.id); };

  return (
    <div
      className={`tile ticked ${busy ? "busy" : ""} ${stalled ? "stalled" : ""}`}
      onClick={launch}
      role="button"
      aria-disabled={stalled}
      tabIndex={0}
      aria-label={stalled ? `${tpl.name} — unavailable` : `Launch ${tpl.name}`}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          launch();
        }
      }}
    >
      <div className="tile-top">
        <div className="icon" aria-hidden="true" style={tpl.color ? { color: tpl.color } : undefined}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
            {ICON_PATHS[tpl.icon]}
          </svg>
        </div>
        <span className="ordinal">{String(ordinal).padStart(2, "0")}</span>
      </div>

      <div className="name">{tpl.name}</div>
      <div className="desc">{tpl.description}</div>

      {busy && (
        <div className="tile-startup">
          <div className="tile-startup-label">Claiming VM…</div>
          <div className="tile-startup-track"><div className="tile-startup-fill" /></div>
        </div>
      )}

      {stalled && tpl.staging_error && (
        <div className="tile-fault" title={tpl.staging_error}>
          {tpl.staging_error}
        </div>
      )}

      <div className="tile-foot">
        <span className="spec">
          {tpl.cpu_cores}C · {Math.round(tpl.memory_mb / 1024)}G · {tpl.protocol}
        </span>
        {ready ? (
          <span className="avail ready" title={`${tpl.ready_count} warm VM(s) waiting`}>
            Ready now{tpl.ready_count > 1 ? ` ×${tpl.ready_count}` : ""}
          </span>
        ) : stalled ? (
          <span className="avail fault" title={tpl.staging_error ?? "Staging is failing"}>
            Unavailable
          </span>
        ) : tpl.pending_count > 0 ? (
          <span className="avail cold" title={`${tpl.pending_count} VM(s) cloning and booting right now`}>
            Warming up
          </span>
        ) : (
          <span className="avail cold" title="Nothing warm is staged yet — launching one will take a minute or two">
            Not staged
          </span>
        )}
      </div>
    </div>
  );
});
