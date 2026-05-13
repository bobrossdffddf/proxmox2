import { TileTemplate } from "../api";

interface Props {
  tpl: TileTemplate;
  busy: boolean;
  onLaunch: (id: string) => void;
}

const ICONS: Record<TileTemplate["icon"], string> = {
  windows: "WIN",
  server: "SRV",
  linux: "TUX",
  network: "NET",
  generic: "VM",
};

export function VMTile({ tpl, busy, onLaunch }: Props) {
  return (
    <div
      className={`tile ${busy ? "busy" : ""}`}
      onClick={() => !busy && onLaunch(tpl.id)}
      style={tpl.color ? ({ borderColor: tpl.color } as React.CSSProperties) : undefined}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !busy) onLaunch(tpl.id);
      }}
    >
      <div className="icon">{ICONS[tpl.icon]}</div>
      <div className="name">{tpl.name}</div>
      <div className="desc">{tpl.description}</div>
      <div className="meta">
        <span>{tpl.cpu_cores} vCPU</span>
        <span>{Math.round(tpl.memory_mb / 1024)} GB</span>
        <span>{tpl.protocol.toUpperCase()}</span>
      </div>
    </div>
  );
}
