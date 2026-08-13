/**
 * Tiny fetch wrapper. Reads the JWT from localStorage, attaches it to every
 * request, throws on non-2xx with the server's error message.
 */
const TOKEN_KEY = "wcta.token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string | null) {
  if (token === null) localStorage.removeItem(TOKEN_KEY);
  else localStorage.setItem(TOKEN_KEY, token);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  headers.set("Content-Type", "application/json");
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch {
    // fetch only rejects when the request never got a response at all. The
    // browser's own message for this is "Failed to fetch", which sends people
    // looking in the wrong place — say what it actually means.
    throw new Error(
      `Could not reach the server (${init.method ?? "GET"} ${path}). ` +
        `The backend may be down or restarting — check: docker compose logs -f backend`
    );
  }

  if (res.status === 401) {
    setToken(null);
    if (typeof window !== "undefined") window.location.href = "/login";
    throw new Error("not authenticated");
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      // A non-JSON body means the error came from something in front of the
      // backend (nginx, another proxy) rather than the app itself.
      if (res.status === 413) {
        msg = "Upload rejected as too large by a proxy in front of the app, before it reached the backend.";
      }
    }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

// ---- typed helpers ----

export interface AuthUser { id: number; username: string; role: "student" | "admin" }
export interface LoginResponse { token: string; user: AuthUser }

export interface AdminUser {
  id: number;
  username: string;
  role: "student" | "admin";
  disabled: boolean;
  max_vms: number;
  allowed_templates: string;
  created_at: string;
  last_login_at: string | null;
}

export interface AuditLog {
  id: number;
  action: string;
  session_id: number | null;
  ip_address: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

export interface AdminSession {
  id: number;
  public_id: string;
  user_id: number;
  template_id: string;
  template_name: string;
  proxmox_node: string;
  proxmox_vmid: number;
  status: SessionStatus;
  failure_reason: string | null;
  created_at: string;
  hard_expires_at: string;
}

export interface StagedVm {
  id: number;
  template_id: string;
  template_name: string;
  proxmox_node: string;
  proxmox_vmid: number;
  guest_ip: string | null;
  status: "queued" | "provisioning" | "running" | "failed";
  failure_reason: string | null;
}

export interface StagingTarget {
  templateId: string;
  templateName: string;
  nodes: string[];
  poolSize: number;
  currentReady: number;
  currentLive: number;
}

export interface Announcement {
  id: number;
  title: string;
  message: string;
  active?: boolean;
  created_at: string;
}

export interface ResourceReport {
  generatedAt: string;
  nodes: Array<{
    name: string;
    enabled: boolean;
    reachable: boolean;
    cpuPct?: number;
    memoryUsed?: number;
    memoryTotal?: number;
    error?: string;
  }>;
  users: Array<{
    userId: number;
    username: string;
    activeVms: number;
    cpuPct: number;
    mem: number;
    maxmem: number;
  }>;
  templates: Array<{
    templateId: string;
    templateName: string;
    activeVms: number;
    cpuPct: number;
    mem: number;
  }>;
  vms: Array<AdminSession & {
    username: string;
    metrics: null | {
      status: string;
      cpuPct: number;
      cpus: number | null;
      mem: number | null;
      maxmem: number | null;
      netin: number;
      netout: number;
      diskread: number;
      diskwrite: number;
      uptime: number;
    };
    error?: string;
  }>;
}

export interface TileTemplate {
  id: string;
  name: string;
  description: string;
  icon: "windows" | "server" | "linux" | "network" | "generic";
  protocol: "rdp" | "vnc";
  color: string | null;
  cpu_cores: number;
  memory_mb: number;
  ready_count: number;
}

export interface AdminStats {
  perDay: Array<{ day: string; count: number }>;
  perTemplate: Array<{ templateId: string; templateName: string; count: number; users: number }>;
  perUser: Array<{ username: string; count: number; minutes: number }>;
  totals: { total: number; last7: number; avgMinutes: number | null };
}

export interface SessionNote {
  id: number;
  username: string;
  template_name: string;
  created_at: string;
  cleaned_up_at: string | null;
  notes: string;
}

// ---- VM import ----

export type ImportStatus =
  | "uploading" | "inspecting" | "ready" | "queued" | "running" | "awaiting_prep" | "succeeded" | "failed" | "cancelled";

export type ImportStage =
  | "upload" | "inspect" | "package" | "transfer" | "create" | "configure" | "prep" | "template" | "register" | "done";

export type BundleFileRole = "ovf" | "vmx" | "disk" | "disk-extent" | "nvram" | "manifest" | "iso" | "other";

export interface BundleFile {
  name: string;
  flatName: string;
  size: number;
  role: BundleFileRole;
}

export interface GuestSpec {
  name: string;
  ostype: string;
  osLabel: string;
  family: "windows" | "linux" | "other";
  icon: TileTemplate["icon"];
  protocol: "rdp" | "vnc";
  port: number;
  defaultUsername: string;
  cores: number;
  memoryMb: number;
  firmware: "seabios" | "ovmf";
  scsihw: string;
  nicModel: string;
  disks: Array<{ file: string; capacityBytes: number | null; slot: number }>;
  source: "ovf" | "vmx" | "heuristic";
}

export interface BundleInspection {
  container: "zip" | "ova" | "raw";
  files: BundleFile[];
  spec: GuestSpec;
  totalDiskBytes: number;
  warnings: string[];
}

export interface ImportSettings {
  templateId: string;
  templateName: string;
  description: string;
  icon: TileTemplate["icon"];
  node: string;
  storage: string;
  importStorage: string;
  bridge: string;
  vlanTag: number | null;
  vmid: number;
  cores: number;
  memoryMb: number;
  ostype: string;
  firmware: "seabios" | "ovmf";
  protocol: "rdp" | "vnc";
  port: number;
  username: string;
  password: string;
  stagingPoolSize: number;
  strategy: "ova" | "disk";
  busType: "auto" | "sata" | "scsi" | "ide" | "virtio";
  addTpm: boolean;
  virtioIso: string | null;
  keepUpload: boolean;
  registerTemplate: boolean;
  startAfterImport: boolean;
}

export interface VmImport {
  id: string;
  originalFilename: string;
  uploadBytes: number;
  status: ImportStatus;
  stage: ImportStage;
  progress: number;
  inspection: BundleInspection | null;
  settings: ImportSettings | null;
  result: { vmid: number; node: string; templateId: string | null; storage: string } | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface ImportLogLine {
  id: string;
  level: "info" | "warn" | "error";
  message: string;
  created_at: string;
}

export interface ImportStorageInfo {
  storage: string;
  type: string;
  avail: number | null;
  total: number | null;
}

export interface NodeCapability {
  node: string;
  host: string;
  port: number;
  reachable: boolean;
  version: string | null;
  supportsApiImport: boolean;
  importStorages: ImportStorageInfo[];
  imageStorages: ImportStorageInfo[];
  virtioIsos: string[];
  bridges: string[];
  blockers: string[];
}

export interface ImportCapabilities {
  nodes: NodeCapability[];
  staging: { dir: string; freeBytes: number | null; freeLabel: string | null; maxUploadGb: number };
  vmidRange: { start: number; end: number };
}

export interface ImportedTemplate {
  id: string;
  name: string;
  icon: TileTemplate["icon"];
  protocol: "rdp" | "vnc";
  proxmoxTemplateId: number;
  cpuCores: number;
  memoryMb: number;
  stagingPoolSize: number;
  enabled: boolean;
  createdAt: string;
}

/**
 * The upload endpoint accepts a plain file name only. Real exports are called
 * things like "CyberPatriot Win11 (final).zip", so the punctuation is folded
 * down here rather than rejected server-side.
 */
export function sanitizeUploadName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  return (cleaned || "upload.zip").slice(0, 200);
}

export type SessionStatus =
  | "queued" | "provisioning" | "running" | "cleaning" | "stopped" | "failed" | "cleanup_failed";

export interface SessionView {
  id: string;            // public id
  templateId: string;
  templateName: string;
  protocol: "rdp" | "vnc";
  proxmoxNode: string;
  status: SessionStatus;
  failureReason: string | null;
  createdAt: string;
  lastActivityAt: string;
  hardExpiresAt: string;
  guestUsername: string | null;
  guestPassword: string | null;
  extendedMinutes: number;
  notes: string | null;
  isOwner?: boolean;
}

export const api = {
  login: (username: string, password: string) =>
    request<LoginResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  me: () => request<AuthUser>("/api/auth/me"),

  templates: () => request<TileTemplate[]>("/api/templates"),

  requestVm: (templateId: string) =>
    request<{ sessionId: string; templateId: string; status: string; source: string }>("/api/vm/request", {
      method: "POST",
      body: JSON.stringify({ templateId }),
    }),
  listSessions: () => request<SessionView[]>("/api/vm/sessions"),
  getSession: (publicId: string) =>
    request<SessionView>(`/api/vm/sessions/${publicId}`),
  heartbeat: (publicId: string) =>
    request<{ ok: boolean; status?: SessionStatus }>(`/api/vm/sessions/${publicId}/heartbeat`, {
      method: "POST",
    }),
  stopSession: (publicId: string) =>
    request<{ ok: true }>(`/api/vm/sessions/${publicId}`, { method: "DELETE" }),
  extendSession: (publicId: string) =>
    request<SessionView>(`/api/vm/sessions/${publicId}/extend`, { method: "POST" }),
  saveSessionNotes: (publicId: string, notes: string) =>
    request<{ ok: true }>(`/api/vm/sessions/${publicId}/notes`, {
      method: "POST",
      body: JSON.stringify({ notes }),
    }),
  pushFileToVm: (publicId: string, name: string, contentBase64: string) =>
    request<{ ok: true; guestPath: string }>(`/api/vm/sessions/${publicId}/files`, {
      method: "POST",
      body: JSON.stringify({ name, contentBase64 }),
    }),
  announcements: () => request<Announcement[]>("/api/announcements"),

  adminUsers: () => request<AdminUser[]>("/api/admin/users"),
  createUser: (payload: { username: string; password: string; role: string; maxVms: number; allowedTemplates: string }) => request<AdminUser>("/api/admin/users", { method: "POST", body: JSON.stringify(payload) }),
  updateUser: (id: number, payload: { role?: string; maxVms?: number; allowedTemplates?: string }) =>
    request<AdminUser>(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  setUserEnabled: (id: number, enabled: boolean) =>
    request<{ ok: true }>(`/api/admin/users/${id}/${enabled ? "enable" : "disable"}`, { method: "POST" }),
  resetUserPassword: (id: number, password: string) =>
    request<{ ok: true }>(`/api/admin/users/${id}/password`, { method: "POST", body: JSON.stringify({ password }) }),
  userAudit: (id: number) => request<AuditLog[]>(`/api/admin/users/${id}/audit`),
  adminResources: () => request<ResourceReport>("/api/admin/resources"),
  adminSessions: () => request<AdminSession[]>("/api/admin/sessions"),
  stopAdminSession: (id: number) =>
    request<{ ok: true }>(`/api/admin/sessions/${id}/stop`, { method: "POST" }),
  forgetAdminSession: (id: number) =>
    request<{ ok: true }>(`/api/admin/sessions/${id}/forget`, { method: "POST" }),
  stopAllAdminSessions: () =>
    request<{ ok: true; count: number }>("/api/admin/sessions/stop-all", { method: "POST" }),
  stagedVms: () => request<StagedVm[]>("/api/admin/staged"),
  ensureStaging: () => request<{ ok: true }>("/api/admin/staged/ensure", { method: "POST" }),
  stagingTargets: () => request<StagingTarget[]>("/api/admin/staging-targets"),
  updateStagingTarget: (templateId: string, poolSize: number) =>
    request<{ ok: true }>(`/api/admin/staging-targets/${templateId}`, {
      method: "PATCH",
      body: JSON.stringify({ poolSize }),
    }),
  destroyStagedVm: (id: number) =>
    request<{ ok: true }>(`/api/admin/staged/${id}`, { method: "DELETE" }),
  forgetStagedVm: (id: number) =>
    request<{ ok: true }>(`/api/admin/staged/${id}/forget`, { method: "POST" }),
  deleteAllVms: () =>
    request<{ ok: true; activeQueued: number; stagedDestroyed: number }>("/api/admin/vms/all", { method: "DELETE" }),
  deleteInactiveVms: () =>
    request<{
      ok: boolean;
      kept: null | { vmId: number; node: string; name: string; status: string };
      deleted: number;
      failed: Array<{ vmid: number; node: string; name: string; error: string }>;
      protected: number;
    }>("/api/admin/vms/delete-inactive", { method: "POST" }),
  adminAnnouncements: () => request<Announcement[]>("/api/admin/announcements"),
  createAnnouncement: (payload: { title: string; message: string; active: boolean }) =>
    request<Announcement>("/api/admin/announcements", { method: "POST", body: JSON.stringify(payload) }),
  deactivateAnnouncement: (id: number) =>
    request<{ ok: true }>(`/api/admin/announcements/${id}/deactivate`, { method: "POST" }),
  adminStats: () => request<AdminStats>("/api/admin/stats"),
  adminNotes: () => request<SessionNote[]>("/api/admin/notes"),

  // ---- VM import ----
  importCapabilities: () => request<ImportCapabilities>("/api/admin/imports/capabilities"),
  listImports: () => request<VmImport[]>("/api/admin/imports"),
  getImport: (id: string, since = 0) =>
    request<{ import: VmImport; log: ImportLogLine[]; suggested: ImportSettings | null }>(
      `/api/admin/imports/${id}?since=${since}`
    ),
  startImport: (id: string, settings: ImportSettings) =>
    request<{ ok: true; import: VmImport }>(`/api/admin/imports/${id}/start`, {
      method: "POST",
      body: JSON.stringify(settings),
    }),
  finalizeImport: (id: string) =>
    request<{ ok: true; vmid: number; templateId: string | null; import: VmImport }>(
      `/api/admin/imports/${id}/finalize`,
      { method: "POST" }
    ),
  cancelImport: (id: string) =>
    request<{ ok: true }>(`/api/admin/imports/${id}/cancel`, { method: "POST" }),
  deleteImport: (id: string) => request<{ ok: true }>(`/api/admin/imports/${id}`, { method: "DELETE" }),
  importCommands: (id: string) => request<{ commands: string[] }>(`/api/admin/imports/${id}/commands`),

  importedTemplates: () => request<ImportedTemplate[]>("/api/admin/imports/templates"),
  setImportedTemplateEnabled: (id: string, enabled: boolean) =>
    request<{ ok: true }>(`/api/admin/imports/templates/${id}/enabled`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
  deleteImportedTemplate: (id: string) =>
    request<{ ok: true }>(`/api/admin/imports/templates/${id}`, { method: "DELETE" }),

  /**
   * Reserve an import record before sending any bytes. Doing this first is what
   * lets the wizard poll the server's own log during the upload — and it's
   * where an oversized file or a full disk gets rejected, before a browser
   * spends an hour uploading something that can't land.
   */
  createImport: (filename: string, sizeBytes: number) =>
    request<{ import: VmImport }>("/api/admin/imports", {
      method: "POST",
      body: JSON.stringify({ filename: sanitizeUploadName(filename), sizeBytes }),
    }),

  /**
   * Upload a bundle into a reserved record. Uses XMLHttpRequest rather than
   * fetch purely for `upload.onprogress` — these files run to tens of
   * gigabytes and a bar that doesn't move is indistinguishable from a hang.
   */
  uploadImport(
    id: string,
    file: File,
    onProgress: (percent: number, loaded: number) => void,
    onXhr?: (xhr: XMLHttpRequest) => void
  ): Promise<{ import: VmImport; suggested: ImportSettings }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `/api/admin/imports/${id}/upload`);

      const token = getToken();
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress((event.loaded / event.total) * 100, event.loaded);
      };
      xhr.onload = () => {
        let body: unknown = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          /* handled below */
        }
        if (xhr.status >= 200 && xhr.status < 300 && body) {
          resolve(body as { import: VmImport; suggested: ImportSettings });
        } else if (xhr.status === 413) {
          // nginx and friends answer 413 with HTML, so there's no error field
          // to read. The backend never saw this request.
          reject(
            new Error(
              "A proxy in front of the app rejected the upload as too large before it reached the backend. " +
                "Check client_max_body_size on any reverse proxy you run in front of WCTARange."
            )
          );
        } else {
          const message =
            (body as { error?: string } | null)?.error ??
            `Upload failed with ${xhr.status} ${xhr.statusText || "(no response)"}`;
          reject(new Error(message));
        }
      };
      xhr.onerror = () =>
        reject(
          new Error(
            "Upload failed — the connection dropped. Check the import log below; the server may have recorded why."
          )
        );
      xhr.onabort = () => reject(new Error("Upload cancelled"));

      onXhr?.(xhr);
      xhr.send(file);
    });
  },
};
