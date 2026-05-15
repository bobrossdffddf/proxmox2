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

  const res = await fetch(path, { ...init, headers });

  if (res.status === 401) {
    setToken(null);
    if (typeof window !== "undefined") window.location.href = "/login";
    throw new Error("not authenticated");
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch { /* ignore */ }
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

  rdpToken: (sessionId: string) =>
    request<{ token: string; sessionPublicId: string }>("/api/rdp/connect", {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    }),
};
