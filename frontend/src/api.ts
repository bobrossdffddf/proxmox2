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
    request<{ jobId: string; templateId: string; status: string }>("/api/vm/request", {
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

  rdpToken: (sessionId: string) =>
    request<{ token: string; sessionPublicId: string }>("/api/rdp/connect", {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    }),
};
