/**
 * VM import wizard.
 *
 * Drop a VMware export — a zipped VM folder, an OVA, or a bare disk image — and
 * this walks it all the way to a dashboard tile: inspect, confirm, import,
 * prepare the guest, publish.
 *
 * The one manual step is guest preparation, and it's manual because it has to
 * be: a VM that came out of VMware has no QEMU guest agent, and without one the
 * range can never learn the clone's IP address. The wizard stops at that point,
 * says exactly what to do, and waits.
 */
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  BundleFileRole,
  ImportCapabilities,
  ImportedTemplate,
  ImportLogLine,
  ImportSettings,
  ImportStage,
  NodeCapability,
  VmImport,
} from "../api";

const STAGES: Array<{ id: ImportStage; label: string }> = [
  { id: "upload", label: "Upload" },
  { id: "inspect", label: "Inspect" },
  { id: "package", label: "Package" },
  { id: "transfer", label: "Transfer" },
  { id: "create", label: "Create VM" },
  { id: "prep", label: "Guest prep" },
  { id: "template", label: "Template" },
  { id: "done", label: "Done" },
];

const ROLE_LABEL: Record<BundleFileRole, string> = {
  ovf: "OVF descriptor",
  vmx: "VMX config",
  disk: "Disk",
  "disk-extent": "Disk extent",
  nvram: "UEFI vars",
  manifest: "Manifest",
  iso: "ISO",
  other: "Other",
};

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

const ACTIVE_STATUSES = ["queued", "running"];

export function ImportWizard() {
  const [caps, setCaps] = useState<ImportCapabilities | null>(null);
  const [history, setHistory] = useState<VmImport[]>([]);
  const [tiles, setTiles] = useState<ImportedTemplate[]>([]);
  const [active, setActive] = useState<VmImport | null>(null);
  const [log, setLog] = useState<ImportLogLine[]>([]);
  const [settings, setSettings] = useState<ImportSettings | null>(null);
  const [upload, setUpload] = useState<{ name: string; percent: number } | null>(null);
  const [commands, setCommands] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadXhr = useRef<XMLHttpRequest | null>(null);
  /** Highest log id already rendered, so polling only fetches the tail. */
  const logCursor = useRef(0);

  const refreshLists = useCallback(async () => {
    const [list, imported] = await Promise.all([api.listImports(), api.importedTemplates()]);
    setHistory(list);
    setTiles(imported);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        setCaps(await api.importCapabilities());
        await refreshLists();
      } catch (err) {
        setMessage({ kind: "error", text: (err as Error).message });
      }
    })();
  }, [refreshLists]);

  // Poll while the worker is doing something. Only the tail of the log is
  // fetched, so a long import doesn't re-send thousands of lines every few
  // seconds — the cursor lives in a ref so arriving lines don't restart the
  // interval.
  const activeId = active && ACTIVE_STATUSES.includes(active.status) ? active.id : null;

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const res = await api.getImport(activeId, logCursor.current);
        if (cancelled) return;
        setActive(res.import);
        if (res.log.length > 0) {
          logCursor.current = Number(res.log[res.log.length - 1].id);
          setLog((prev) => [...prev, ...res.log]);
        }
        if (!ACTIVE_STATUSES.includes(res.import.status)) void refreshLists();
      } catch {
        // A blip while polling isn't worth a banner; the next tick retries.
      }
    };

    const timer = window.setInterval(tick, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeId, refreshLists]);

  const selectedNode: NodeCapability | null = useMemo(
    () => caps?.nodes.find((n) => n.node === settings?.node) ?? null,
    [caps, settings?.node]
  );

  const openImport = useCallback(async (id: string) => {
    setBusy(true);
    try {
      const res = await api.getImport(id, 0);
      setActive(res.import);
      setLog(res.log);
      logCursor.current = res.log.length > 0 ? Number(res.log[res.log.length - 1].id) : 0;
      // An import that was uploaded but never started carries no saved
      // settings; the server sends a fresh suggestion in that case.
      setSettings(res.import.settings ?? res.suggested);
      setCommands(null);
      setMessage(null);
    } catch (err) {
      setMessage({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }, []);

  async function handleFile(file: File) {
    setMessage(null);
    setCommands(null);
    setLog([]);
    logCursor.current = 0;
    setUpload({ name: file.name, percent: 0 });
    try {
      const res = await api.uploadImport(
        file,
        (percent) => setUpload({ name: file.name, percent }),
        (xhr) => {
          uploadXhr.current = xhr;
        }
      );
      setActive(res.import);
      setSettings(res.suggested);
      const detail = await api.getImport(res.import.id, 0);
      setLog(detail.log);
      logCursor.current = detail.log.length > 0 ? Number(detail.log[detail.log.length - 1].id) : 0;
      await refreshLists();
      setMessage({ kind: "ok", text: `Inspected ${res.import.originalFilename}. Check the plan below.` });
    } catch (err) {
      setMessage({ kind: "error", text: (err as Error).message });
    } finally {
      setUpload(null);
      uploadXhr.current = null;
    }
  }

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setMessage({ kind: "ok", text: label });
      await refreshLists();
    } catch (err) {
      setMessage({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const update = <K extends keyof ImportSettings>(key: K, value: ImportSettings[K]) =>
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));

  // -------------------------------------------------------------------------

  const usable = caps?.nodes.filter((n) => n.supportsApiImport) ?? [];
  const blocked = caps?.nodes.filter((n) => n.reachable && !n.supportsApiImport) ?? [];

  return (
    <>
      {message && <div className={`admin-message ${message.kind}`}>{message.text}</div>}

      <section className="admin-panel">
        <div className="admin-head">
          <h2>Import a VM</h2>
          <div className="import-cluster-note">
            {caps === null ? (
              <span className="k">checking cluster…</span>
            ) : (
              <span className="k">
                {usable.length} node{usable.length === 1 ? "" : "s"} ready
                {caps.staging.freeLabel ? ` · ${caps.staging.freeLabel} staging space` : ""}
                {` · VMIDs ${caps.vmidRange.start}–${caps.vmidRange.end}`}
              </span>
            )}
          </div>
        </div>

        {blocked.length > 0 && (
          <div className="import-blockers">
            {blocked.map((node) => (
              <div key={node.node} className="import-blocker">
                <strong>{node.node}</strong>
                {node.version ? <span className="k"> PVE {node.version}</span> : null}
                <ul>
                  {node.blockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        {upload ? (
          <div className="import-dropzone uploading">
            <div className="name">Uploading {upload.name}</div>
            <div className="import-progress">
              <span className="fill" style={{ width: `${upload.percent}%` }} />
            </div>
            <div className="k">{upload.percent.toFixed(1)}% — keep this tab open</div>
            <button
              type="button"
              className="danger"
              onClick={() => uploadXhr.current?.abort()}
            >
              Cancel upload
            </button>
          </div>
        ) : (
          <div
            className={`import-dropzone${dragging ? " dragging" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files?.[0];
              if (file) void handleFile(file);
            }}
          >
            <div className="name">Drop a VMware export here</div>
            <p>
              A <code>.zip</code> of the VM folder (<code>.vmx</code> + <code>.vmdk</code>), an{" "}
              <code>.ova</code>, or a bare disk image. The contents are read on arrival — CPU,
              memory, disks and guest OS come from the bundle, so there's nothing to look up.
            </p>
            <input
              ref={fileInput}
              type="file"
              accept=".zip,.ova,.ovf,.vmdk,.qcow2,.raw,.img,.tar"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
                e.target.value = "";
              }}
            />
            <button type="button" className="primary" onClick={() => fileInput.current?.click()}>
              Choose a file
            </button>
          </div>
        )}
      </section>

      {active && settings && (
        <ImportDetail
          record={active}
          settings={settings}
          node={selectedNode}
          caps={caps}
          log={log}
          busy={busy}
          commands={commands}
          onChange={update}
          onStart={() =>
            act("Import queued.", async () => {
              const res = await api.startImport(active.id, settings);
              setActive(res.import);
            })
          }
          onFinalize={() =>
            act("Template created.", async () => {
              const res = await api.finalizeImport(active.id);
              setActive(res.import);
            })
          }
          onCancel={() =>
            act("Cancellation requested.", async () => {
              await api.cancelImport(active.id);
              const res = await api.getImport(active.id, 0);
              setActive(res.import);
              setLog(res.log);
            })
          }
          onDiscard={() =>
            act("Import discarded.", async () => {
              await api.deleteImport(active.id);
              setActive(null);
              setSettings(null);
              setLog([]);
            })
          }
          onShowCommands={async () => {
            try {
              const res = await api.importCommands(active.id);
              setCommands(res.commands);
            } catch (err) {
              setMessage({ kind: "error", text: (err as Error).message });
            }
          }}
          onClose={() => {
            setActive(null);
            setSettings(null);
            setLog([]);
            setCommands(null);
          }}
        />
      )}

      {history.length > 0 && (
        <section className="admin-panel">
          <h2>Recent imports</h2>
          <div className="import-steps">
            {history.map((row) => (
              <button
                key={row.id}
                type="button"
                className={`import-history-row${active?.id === row.id ? " current" : ""}`}
                onClick={() => void openImport(row.id)}
              >
                <span className="name">{row.originalFilename}</span>
                <span className={`import-status ${row.status}`}>{row.status.replace("_", " ")}</span>
                <span className="k">{formatBytes(row.uploadBytes)}</span>
                <span className="k">{new Date(row.createdAt).toLocaleString()}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {tiles.length > 0 && (
        <section className="admin-panel">
          <h2>Tiles created by import</h2>
          <p className="admin-hint">
            These live in the database rather than <code>config/templates.yaml</code>, so they survive
            restarts without editing a file. Removing one hides the tile; the Proxmox template VM is
            left alone.
          </p>
          <div className="import-steps">
            {tiles.map((tile) => (
              <div key={tile.id} className="import-tile-row">
                <span className="name">{tile.name}</span>
                <span className="k">
                  {tile.id} · VMID {tile.proxmoxTemplateId} · {tile.cpuCores} cores ·{" "}
                  {(tile.memoryMb / 1024).toFixed(1)} GB · {tile.protocol.toUpperCase()}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    act(tile.enabled ? "Tile hidden." : "Tile shown.", () =>
                      api.setImportedTemplateEnabled(tile.id, !tile.enabled)
                    )
                  }
                >
                  {tile.enabled ? "Hide" : "Show"}
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => act("Tile removed.", () => api.deleteImportedTemplate(tile.id))}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

interface DetailProps {
  record: VmImport;
  settings: ImportSettings;
  node: NodeCapability | null;
  caps: ImportCapabilities | null;
  log: ImportLogLine[];
  busy: boolean;
  commands: string[] | null;
  onChange: <K extends keyof ImportSettings>(key: K, value: ImportSettings[K]) => void;
  onStart: () => void;
  onFinalize: () => void;
  onCancel: () => void;
  onDiscard: () => void;
  onShowCommands: () => void;
  onClose: () => void;
}

function ImportDetail(props: DetailProps) {
  const { record, settings, node, caps, log, busy, commands } = props;
  const inspection = record.inspection;
  const running = ACTIVE_STATUSES.includes(record.status);
  // Once the VM exists there's no starting over — the uploaded bundle has been
  // consumed — so a failure past that point offers finalization, not the form.
  const vmCreated = Boolean(record.settings) && ["prep", "template", "register", "done"].includes(record.stage);
  const editable = (record.status === "ready" || record.status === "failed") && !vmCreated;
  const needsPrep = record.status === "awaiting_prep" || (record.status === "failed" && vmCreated);

  return (
    <>
      <section className="admin-panel">
        <div className="admin-head">
          <h2>{record.originalFilename}</h2>
          <div className="admin-toolbar-actions">
            <span className={`import-status ${record.status}`}>{record.status.replace("_", " ")}</span>
            <button type="button" onClick={props.onClose}>
              Close
            </button>
          </div>
        </div>

        <StageBar stage={record.stage} status={record.status} progress={record.progress} />

        {record.error && <div className="admin-message error">{record.error}</div>}

        {inspection && (
          <div className="import-findings">
            <div className="import-facts">
              <Fact label="Guest OS" value={inspection.spec.osLabel} />
              <Fact label="Read from" value={sourceLabel(inspection.spec.source)} />
              <Fact label="CPU" value={`${inspection.spec.cores} cores`} />
              <Fact label="Memory" value={`${(inspection.spec.memoryMb / 1024).toFixed(1)} GB`} />
              <Fact label="Firmware" value={inspection.spec.firmware === "ovmf" ? "UEFI" : "BIOS"} />
              <Fact label="Disks" value={String(inspection.spec.disks.length)} />
              <Fact label="Payload" value={formatBytes(inspection.totalDiskBytes)} />
              <Fact label="Container" value={inspection.container.toUpperCase()} />
            </div>

            <div className="import-files">
              {inspection.files.map((file) => (
                <div key={file.name} className={`import-file role-${file.role}`}>
                  <span className="role k">{ROLE_LABEL[file.role]}</span>
                  <span className="fname mono">{file.flatName}</span>
                  <span className="size mono">{formatBytes(file.size)}</span>
                </div>
              ))}
            </div>

            {inspection.warnings.length > 0 && (
              <ul className="import-warnings">
                {inspection.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {editable && (
        <section className="admin-panel">
          <h2>Import plan</h2>
          <p className="admin-hint">
            Everything below was filled in from the bundle and the cluster. Change what you need and
            start — the only field with no sensible default is the guest password.
          </p>

          <h3 className="import-section-head">Dashboard tile</h3>
          <div className="import-grid">
            <Field label="Tile name">
              <input value={settings.templateName} onChange={(e) => props.onChange("templateName", e.target.value)} />
            </Field>
            <Field label="Template id">
              <input value={settings.templateId} onChange={(e) => props.onChange("templateId", e.target.value)} />
            </Field>
            <Field label="Icon">
              <select value={settings.icon} onChange={(e) => props.onChange("icon", e.target.value as ImportSettings["icon"])}>
                {["windows", "server", "linux", "network", "generic"].map((icon) => (
                  <option key={icon} value={icon}>
                    {icon}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Warm clones">
              <input
                type="number"
                min={0}
                max={20}
                value={settings.stagingPoolSize}
                onChange={(e) => props.onChange("stagingPoolSize", Number(e.target.value))}
              />
            </Field>
            <Field label="Description" wide>
              <input value={settings.description} onChange={(e) => props.onChange("description", e.target.value)} />
            </Field>
          </div>

          <h3 className="import-section-head">Target</h3>
          <div className="import-grid">
            <Field label="Node">
              <select value={settings.node} onChange={(e) => props.onChange("node", e.target.value)}>
                {(caps?.nodes ?? []).map((n) => (
                  <option key={n.node} value={n.node} disabled={!n.supportsApiImport}>
                    {n.node}
                    {n.supportsApiImport ? "" : " (unavailable)"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Disk storage">
              <select value={settings.storage} onChange={(e) => props.onChange("storage", e.target.value)}>
                {(node?.imageStorages ?? []).map((s) => (
                  <option key={s.storage} value={s.storage}>
                    {s.storage} ({formatBytes(s.avail)} free)
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Landing storage">
              <select value={settings.importStorage} onChange={(e) => props.onChange("importStorage", e.target.value)}>
                {(node?.importStorages ?? []).map((s) => (
                  <option key={s.storage} value={s.storage}>
                    {s.storage} ({formatBytes(s.avail)} free)
                  </option>
                ))}
              </select>
            </Field>
            <Field label="VMID">
              <input
                type="number"
                value={settings.vmid}
                onChange={(e) => props.onChange("vmid", Number(e.target.value))}
              />
            </Field>
            <Field label="Bridge">
              <select value={settings.bridge} onChange={(e) => props.onChange("bridge", e.target.value)}>
                {(node?.bridges ?? [settings.bridge]).map((bridge) => (
                  <option key={bridge} value={bridge}>
                    {bridge}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="VLAN tag">
              <input
                type="number"
                placeholder="none"
                value={settings.vlanTag ?? ""}
                onChange={(e) => props.onChange("vlanTag", e.target.value ? Number(e.target.value) : null)}
              />
            </Field>
          </div>

          <h3 className="import-section-head">Hardware</h3>
          <div className="import-grid">
            <Field label="Cores">
              <input
                type="number"
                min={1}
                value={settings.cores}
                onChange={(e) => props.onChange("cores", Number(e.target.value))}
              />
            </Field>
            <Field label="Memory (MB)">
              <input
                type="number"
                min={512}
                step={512}
                value={settings.memoryMb}
                onChange={(e) => props.onChange("memoryMb", Number(e.target.value))}
              />
            </Field>
            <Field label="Proxmox ostype">
              <input value={settings.ostype} onChange={(e) => props.onChange("ostype", e.target.value)} />
            </Field>
            <Field label="Firmware">
              <select
                value={settings.firmware}
                onChange={(e) => props.onChange("firmware", e.target.value as ImportSettings["firmware"])}
              >
                <option value="seabios">BIOS (SeaBIOS)</option>
                <option value="ovmf">UEFI (OVMF)</option>
              </select>
            </Field>
            <Field
              label="Disk bus"
              hint="Auto attaches Windows disks to SATA — an unmodified VMware image has no VirtIO driver and won't boot from virtio-scsi."
            >
              <select
                value={settings.busType}
                onChange={(e) => props.onChange("busType", e.target.value as ImportSettings["busType"])}
              >
                <option value="auto">Auto (recommended)</option>
                <option value="sata">SATA</option>
                <option value="scsi">VirtIO SCSI</option>
                <option value="virtio">VirtIO block</option>
                <option value="ide">IDE</option>
              </select>
            </Field>
            <Field label="Driver ISO">
              <select
                value={settings.virtioIso ?? ""}
                onChange={(e) => props.onChange("virtioIso", e.target.value || null)}
              >
                <option value="">none</option>
                {(node?.virtioIsos ?? []).map((iso) => (
                  <option key={iso} value={iso}>
                    {iso.split("/").pop()}
                  </option>
                ))}
                {settings.virtioIso && !(node?.virtioIsos ?? []).includes(settings.virtioIso) && (
                  <option value={settings.virtioIso}>{settings.virtioIso}</option>
                )}
              </select>
            </Field>
          </div>

          <h3 className="import-section-head">Console credentials</h3>
          <p className="admin-hint">
            What the range hands students when they open this VM. It has to match an account that
            already exists inside the guest.
          </p>
          <div className="import-grid">
            <Field label="Protocol">
              <select
                value={settings.protocol}
                onChange={(e) => {
                  const protocol = e.target.value as ImportSettings["protocol"];
                  props.onChange("protocol", protocol);
                  props.onChange("port", protocol === "rdp" ? 3389 : 5900);
                }}
              >
                <option value="rdp">RDP</option>
                <option value="vnc">VNC</option>
              </select>
            </Field>
            <Field label="Port">
              <input
                type="number"
                value={settings.port}
                onChange={(e) => props.onChange("port", Number(e.target.value))}
              />
            </Field>
            <Field label="Username">
              <input value={settings.username} onChange={(e) => props.onChange("username", e.target.value)} />
            </Field>
            <Field label="Password">
              <input
                type="password"
                placeholder="required"
                value={settings.password}
                onChange={(e) => props.onChange("password", e.target.value)}
              />
            </Field>
          </div>

          <h3 className="import-section-head">Options</h3>
          <div className="import-toggles">
            <Toggle
              label="Add a virtual TPM"
              hint="Windows 11 expects one."
              checked={settings.addTpm}
              onChange={(v) => props.onChange("addTpm", v)}
            />
            <Toggle
              label="Start the VM after import"
              hint="So you can install the guest agent straight away."
              checked={settings.startAfterImport}
              onChange={(v) => props.onChange("startAfterImport", v)}
            />
            <Toggle
              label="Publish a dashboard tile"
              checked={settings.registerTemplate}
              onChange={(v) => props.onChange("registerTemplate", v)}
            />
            <Toggle
              label="Keep the uploaded copy on the node"
              hint="Off by default — it's a second copy of the whole image."
              checked={settings.keepUpload}
              onChange={(v) => props.onChange("keepUpload", v)}
            />
          </div>

          <div className="import-actions">
            <button
              type="button"
              className="primary"
              disabled={busy || !settings.password || !node?.supportsApiImport}
              onClick={props.onStart}
            >
              {record.status === "failed" ? "Retry import" : "Start import"}
            </button>
            <button type="button" disabled={busy} onClick={props.onShowCommands}>
              Show equivalent commands
            </button>
            <button type="button" className="danger" disabled={busy} onClick={props.onDiscard}>
              Discard upload
            </button>
            {!settings.password && <span className="k">a guest password is required</span>}
          </div>

          {commands && (
            <div className="import-step">
              <div className="name">Run these on {settings.node} instead</div>
              <div className="meta">
                For a cluster older than Proxmox 8.2, or when you'd rather do it by hand. Copy the
                bundle to the node first.
              </div>
              <pre>{commands.join("\n")}</pre>
            </div>
          )}
        </section>
      )}

      {needsPrep && (
        <GuestPrep record={record} settings={settings} node={node} busy={busy} onFinalize={props.onFinalize} />
      )}

      {record.status === "succeeded" && record.result && (
        <section className="admin-panel">
          <h2>Done</h2>
          <p>
            VM <strong>{record.result.vmid}</strong> on <strong>{record.result.node}</strong> is now a
            Proxmox template
            {record.result.templateId ? (
              <>
                {" "}
                and the <strong>{record.result.templateId}</strong> tile is live on the dashboard.
              </>
            ) : (
              "."
            )}
          </p>
        </section>
      )}

      {(running || log.length > 0) && (
        <section className="admin-panel">
          <div className="admin-head">
            <h2>Import log</h2>
            {running && (
              <button type="button" className="danger" disabled={busy} onClick={props.onCancel}>
                Cancel import
              </button>
            )}
          </div>
          <LogView lines={log} />
        </section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function GuestPrep({
  record,
  settings,
  node,
  busy,
  onFinalize,
}: {
  record: VmImport;
  settings: ImportSettings;
  node: NodeCapability | null;
  busy: boolean;
  onFinalize: () => void;
}) {
  const windows = record.inspection?.spec.family === "windows";
  const consoleUrl = node
    ? `https://${node.host}:${node.port}/?console=kvm&novnc=1&vmid=${settings.vmid}&node=${node.node}`
    : null;

  return (
    <section className="admin-panel import-prep">
      <h2>Prepare the guest</h2>
      <p>
        VM <strong>{settings.vmid}</strong> exists on <strong>{settings.node}</strong> and its disks are
        converted. It can't become a range template yet: an image out of VMware has no QEMU guest
        agent, and WCTARange uses the agent to learn each clone's IP address. Do these inside the
        guest, shut it down, then finish here.
      </p>

      <ol className="import-checklist">
        <li>
          Open the console and boot the VM.
          {consoleUrl && (
            <>
              {" "}
              <a href={consoleUrl} target="_blank" rel="noreferrer">
                Open it in Proxmox
              </a>
              .
            </>
          )}
        </li>
        {windows ? (
          <>
            <li>
              Uninstall VMware Tools, then install the QEMU guest agent from the{" "}
              <code>virtio-win</code> ISO
              {settings.virtioIso ? " (already mounted on the CD drive)" : ""} —{" "}
              <code>guest-agent\qemu-ga-x86_64.msi</code>. Start the <code>QEMU Guest Agent</code>{" "}
              service.
            </li>
            <li>
              Enable Remote Desktop, and set the <code>{settings.username}</code> password to the one
              you entered here.
            </li>
            <li>Leave the network adapter on DHCP.</li>
          </>
        ) : (
          <>
            <li>
              Install and enable the agent: <code>apt install qemu-guest-agent</code> then{" "}
              <code>systemctl enable --now qemu-guest-agent</code>.
            </li>
            <li>
              Make sure a VNC server listens on port {settings.port}, and that{" "}
              <code>{settings.username}</code> uses the password you entered here.
            </li>
          </>
        )}
        <li>Shut the VM down cleanly.</li>
      </ol>

      <div className="import-actions">
        <button type="button" className="primary" disabled={busy} onClick={onFinalize}>
          Guest is ready — convert to template
        </button>
        <span className="k">this shuts the VM down if it's still running</span>
      </div>
    </section>
  );
}

function StageBar({ stage, status, progress }: { stage: ImportStage; status: string; progress: number }) {
  const index = STAGES.findIndex((s) => s.id === stage);
  const failed = status === "failed" || status === "cancelled";

  return (
    <div className="import-stagebar">
      <div className="import-progress">
        <span
          className={`fill${failed ? " failed" : ""}`}
          style={{ width: `${status === "succeeded" ? 100 : progress}%` }}
        />
      </div>
      <div className="import-stages">
        {STAGES.map((s, i) => {
          const state = status === "succeeded" || i < index ? "done" : i === index ? (failed ? "failed" : "current") : "todo";
          return (
            <span key={s.id} className={`import-stage ${state}`}>
              {s.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function LogView({ lines }: { lines: ImportLogLine[] }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Follow the tail, the way a terminal would.
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines.length]);

  if (lines.length === 0) return <div className="k">nothing logged yet</div>;

  return (
    <div className="import-log" ref={box}>
      {lines.map((line) => (
        <div key={line.id} className={`import-log-line ${line.level}`}>
          <span className="ts">{new Date(line.created_at).toLocaleTimeString()}</span>
          <span className="msg">{line.message}</span>
        </div>
      ))}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="import-fact">
      <span className="k">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Field({
  label,
  hint,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={wide ? "import-wide" : undefined} title={hint}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="import-toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <em>{hint}</em>}
      </span>
    </label>
  );
}

function sourceLabel(source: "ovf" | "vmx" | "heuristic"): string {
  if (source === "ovf") return "OVF descriptor";
  if (source === "vmx") return "VMX config";
  return "file names (guessed)";
}
