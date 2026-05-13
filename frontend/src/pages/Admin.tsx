import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AdminSession, AdminUser, Announcement, api, AuditLog, StagedVm } from "../api";

type Tab = "overview" | "users" | "sessions" | "staging" | "announcements" | "logs";

export function Admin() {
  const [tab, setTab] = useState<Tab>("overview");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [stagedVms, setStagedVms] = useState<StagedVm[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [form, setForm] = useState({
    username: "",
    password: "",
    role: "student",
    maxVms: 1,
    allowedTemplates: "*",
  });
  const [announcementForm, setAnnouncementForm] = useState({ title: "", message: "" });

  const selectedUser = useMemo(
    () => users.find((user) => user.id === selectedUserId) ?? users[0] ?? null,
    [selectedUserId, users]
  );

  const loadUsers = async () => {
    const nextUsers = await api.adminUsers();
    setUsers(nextUsers);
    if (!selectedUserId && nextUsers.length > 0) setSelectedUserId(nextUsers[0].id);
  };

  const loadLogs = async (userId: number) => {
    setLogs(await api.userAudit(userId));
  };

  const loadSessions = async () => {
    setSessions(await api.adminSessions());
  };

  const loadStaged = async () => {
    setStagedVms(await api.stagedVms());
  };

  const loadAnnouncements = async () => {
    setAnnouncements(await api.adminAnnouncements());
  };

  useEffect(() => {
    loadUsers().catch((err) => setMessage({ kind: "error", text: err.message ?? "Failed to load users" }));
    loadSessions().catch((err) => setMessage({ kind: "error", text: err.message ?? "Failed to load sessions" }));
    loadStaged().catch((err) => setMessage({ kind: "error", text: err.message ?? "Failed to load staging" }));
    loadAnnouncements().catch((err) => setMessage({ kind: "error", text: err.message ?? "Failed to load announcements" }));
  }, []);

  useEffect(() => {
    if (!selectedUser) return;
    loadLogs(selectedUser.id).catch((err) => setMessage({ kind: "error", text: err.message ?? "Failed to load logs" }));
  }, [selectedUser?.id]);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 5000);
    return () => clearTimeout(timer);
  }, [message]);

  const createUser = async () => {
    try {
      await api.createUser(form);
      setForm({ username: "", password: "", role: "student", maxVms: 1, allowedTemplates: "*" });
      await loadUsers();
      setMessage({ kind: "ok", text: "User added." });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "Failed to add user" });
    }
  };

  const saveUser = async (user: AdminUser) => {
    try {
      await api.updateUser(user.id, {
        role: user.role,
        maxVms: user.max_vms,
        allowedTemplates: user.allowed_templates,
      });
      await loadUsers();
      setMessage({ kind: "ok", text: "User updated." });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "Failed to update user" });
    }
  };

  const setEnabled = async (user: AdminUser, enabled: boolean) => {
    try {
      await api.setUserEnabled(user.id, enabled);
      await loadUsers();
      setMessage({ kind: "ok", text: enabled ? "User enabled." : "User disabled." });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "Failed to update user" });
    }
  };

  const resetPassword = async (user: AdminUser) => {
    const password = prompt(`New password for ${user.username}`);
    if (!password) return;
    try {
      await api.resetUserPassword(user.id, password);
      await loadLogs(user.id);
      setMessage({ kind: "ok", text: "Password reset." });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "Failed to reset password" });
    }
  };

  const updateLocalUser = (id: number, patch: Partial<AdminUser>) => {
    setUsers((current) => current.map((user) => (user.id === id ? { ...user, ...patch } : user)));
  };

  const stopSession = async (session: AdminSession) => {
    if (!confirm(`Stop and delete VM ${session.proxmox_vmid}?`)) return;
    try {
      await api.stopAdminSession(session.id);
      await loadSessions();
      setMessage({ kind: "ok", text: "Cleanup requested." });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "Failed to stop session" });
    }
  };

  const stopAllSessions = async () => {
    if (!confirm("Stop and delete every active user VM?")) return;
    try {
      const result = await api.stopAllAdminSessions();
      await loadSessions();
      setMessage({ kind: "ok", text: `Cleanup requested for ${result.count} active VM(s).` });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "Failed to stop active VMs" });
    }
  };

  const deleteAllVms = async () => {
    if (!confirm("Delete every tracked active and staged VM? This will also empty warm staging inventory.")) return;
    try {
      const result = await api.deleteAllVms();
      await Promise.all([loadSessions(), loadStaged()]);
      setMessage({
        kind: "ok",
        text: `Queued ${result.activeQueued} active VM(s), destroyed ${result.stagedDestroyed} staged VM(s).`,
      });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "Failed to delete VMs" });
    }
  };

  const refillStaging = async () => {
    try {
      await api.ensureStaging();
      await loadStaged();
      setMessage({ kind: "ok", text: "Staging refill started." });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "Failed to refill staging" });
    }
  };

  const destroyStagedVm = async (vm: StagedVm) => {
    if (!confirm(`Destroy staged VM ${vm.proxmox_vmid}?`)) return;
    try {
      await api.destroyStagedVm(vm.id);
      await loadStaged();
      setMessage({ kind: "ok", text: "Staged VM destroyed and replacement requested." });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "Failed to destroy staged VM" });
    }
  };

  const createAnnouncement = async () => {
    try {
      await api.createAnnouncement({ ...announcementForm, active: true });
      setAnnouncementForm({ title: "", message: "" });
      await loadAnnouncements();
      setMessage({ kind: "ok", text: "Announcement posted." });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "Failed to post announcement" });
    }
  };

  const deactivateAnnouncement = async (announcement: Announcement) => {
    try {
      await api.deactivateAnnouncement(announcement.id);
      await loadAnnouncements();
      setMessage({ kind: "ok", text: "Announcement hidden." });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "Failed to hide announcement" });
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="logo">WCTA<span className="accent">RANGE</span></div>
        <div className="user-strip">
          <Link to="/"><button>Dashboard</button></Link>
        </div>
      </header>

      <main className="content">
        <div className="admin-head">
          <div>
            <h1>Admin</h1>
            <p className="subtitle">Manage users, active VMs, staging inventory, announcements, and logs.</p>
          </div>
          <div className="admin-tabs">
            <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>Overview</button>
            <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}>Users</button>
            <button className={tab === "sessions" ? "active" : ""} onClick={() => setTab("sessions")}>Sessions</button>
            <button className={tab === "staging" ? "active" : ""} onClick={() => setTab("staging")}>Staging</button>
            <button className={tab === "announcements" ? "active" : ""} onClick={() => setTab("announcements")}>Announcements</button>
            <button className={tab === "logs" ? "active" : ""} onClick={() => setTab("logs")}>Logs</button>
          </div>
        </div>

        {tab === "overview" ? (
          <>
            <section className="admin-overview-grid">
              <div className="admin-summary-card">
                <div className="admin-summary-value">{users.length}</div>
                <div className="admin-summary-label">Users</div>
                <button onClick={() => setTab("users")}>Manage Users</button>
              </div>
              <div className="admin-summary-card">
                <div className="admin-summary-value">{sessions.length}</div>
                <div className="admin-summary-label">Active VMs</div>
                <button onClick={() => setTab("sessions")}>View Active VMs</button>
              </div>
              <div className="admin-summary-card">
                <div className="admin-summary-value">{stagedVms.filter((vm) => vm.status === "running").length}</div>
                <div className="admin-summary-label">Ready Staged VMs</div>
                <button onClick={() => setTab("staging")}>View Staging</button>
              </div>
              <div className="admin-summary-card">
                <div className="admin-summary-value">{announcements.filter((item) => item.active).length}</div>
                <div className="admin-summary-label">Announcements</div>
                <button onClick={() => setTab("announcements")}>Make Announcement</button>
              </div>
            </section>

            <section className="admin-panel">
              <h2>Quick Actions</h2>
              <div className="admin-quick-actions">
                <button onClick={loadSessions}>Refresh Active VMs</button>
                <button className="danger" onClick={stopAllSessions}>Stop All Active VMs</button>
                <button className="danger" onClick={deleteAllVms}>Delete All VMs</button>
                <button className="primary" onClick={refillStaging}>Refill Staging</button>
                <button onClick={() => setTab("announcements")}>Post Announcement</button>
              </div>
            </section>
          </>
        ) : tab === "users" ? (
          <>
            <section className="admin-panel">
              <h2>Add User</h2>
              <div className="admin-create-grid">
                <input placeholder="username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
                <input placeholder="password" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  <option value="student">student</option>
                  <option value="admin">admin</option>
                </select>
                <input aria-label="max VMs" type="number" min={1} value={form.maxVms} onChange={(e) => setForm({ ...form, maxVms: Number(e.target.value) })} />
                <input placeholder="templates (* or csv)" value={form.allowedTemplates} onChange={(e) => setForm({ ...form, allowedTemplates: e.target.value })} />
                <button className="primary" onClick={createUser}>Add User</button>
              </div>
            </section>

            <section className="admin-panel">
              <h2>Users</h2>
              <div className="admin-user-list">
                {users.map((user) => (
                  <div key={user.id} className={`admin-user-row ${user.disabled ? "disabled" : ""}`}>
                    <button className="admin-user-name" onClick={() => { setSelectedUserId(user.id); setTab("logs"); }}>
                      <span>{user.username}</span>
                      <small>{user.disabled ? "disabled" : user.role}</small>
                    </button>
                    <select value={user.role} onChange={(e) => updateLocalUser(user.id, { role: e.target.value as AdminUser["role"] })}>
                      <option value="student">student</option>
                      <option value="admin">admin</option>
                    </select>
                    <input aria-label={`${user.username} max VMs`} type="number" min={1} value={user.max_vms} onChange={(e) => updateLocalUser(user.id, { max_vms: Number(e.target.value) })} />
                    <input aria-label={`${user.username} templates`} value={user.allowed_templates} onChange={(e) => updateLocalUser(user.id, { allowed_templates: e.target.value })} />
                    <button onClick={() => saveUser(user)}>Save</button>
                    <button onClick={() => resetPassword(user)}>Reset Password</button>
                    <button className={user.disabled ? "primary" : "danger"} onClick={() => setEnabled(user, user.disabled)}>
                      {user.disabled ? "Enable" : "Disable"}
                    </button>
                  </div>
                ))}
              </div>
            </section>
          </>
        ) : tab === "sessions" ? (
          <section className="admin-panel">
            <div className="admin-log-toolbar">
              <h2>Active Sessions</h2>
              <div className="admin-toolbar-actions">
                <button onClick={loadSessions}>Refresh</button>
                <button className="danger" onClick={stopAllSessions}>Stop All</button>
                <button className="danger" onClick={deleteAllVms}>Delete All VMs</button>
              </div>
            </div>
            {sessions.length === 0 ? (
              <div className="empty">No active sessions.</div>
            ) : (
              <div className="admin-session-list">
                {sessions.map((session) => {
                  const owner = users.find((user) => user.id === session.user_id);
                  return (
                    <div key={session.id} className="admin-session-row">
                      <div>
                        <div className="name">{session.template_name}</div>
                        <div className="meta">{owner?.username ?? `user #${session.user_id}`} · VM {session.proxmox_vmid} · {session.proxmox_node}</div>
                      </div>
                      <span className={`status-pill ${session.status}`}>{session.status}</span>
                      <div className="meta">expires {new Date(session.hard_expires_at).toLocaleString()}</div>
                      <button className="danger" onClick={() => stopSession(session)}>Stop & Delete</button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        ) : tab === "staging" ? (
          <section className="admin-panel">
            <div className="admin-log-toolbar">
              <h2>Staged VMs</h2>
              <div className="admin-toolbar-actions">
                <button onClick={loadStaged}>Refresh</button>
                <button className="primary" onClick={refillStaging}>Refill</button>
                <button className="danger" onClick={deleteAllVms}>Delete All VMs</button>
              </div>
            </div>
            {stagedVms.length === 0 ? (
              <div className="empty">No staged VMs are ready yet.</div>
            ) : (
              <div className="admin-session-list">
                {stagedVms.map((vm) => (
                  <div key={vm.id} className="admin-session-row">
                    <div>
                      <div className="name">{vm.template_name}</div>
                      <div className="meta">VM {vm.proxmox_vmid} · {vm.proxmox_node} · {vm.guest_ip ?? "no IP yet"}</div>
                    </div>
                    <span className={`status-pill ${vm.status}`}>{vm.status}</span>
                    <div className="meta">{vm.failure_reason ?? "warm inventory only"}</div>
                    <button className="danger" onClick={() => destroyStagedVm(vm)}>Destroy</button>
                  </div>
                ))}
              </div>
            )}
          </section>
        ) : tab === "announcements" ? (
          <>
            <section className="admin-panel">
              <h2>Make Announcement</h2>
              <div className="announcement-form">
                <input
                  placeholder="title"
                  value={announcementForm.title}
                  onChange={(e) => setAnnouncementForm({ ...announcementForm, title: e.target.value })}
                />
                <textarea
                  placeholder="message"
                  value={announcementForm.message}
                  onChange={(e) => setAnnouncementForm({ ...announcementForm, message: e.target.value })}
                />
                <button className="primary" onClick={createAnnouncement}>Post</button>
              </div>
            </section>
            <section className="admin-panel">
              <div className="admin-log-toolbar">
                <h2>Announcements</h2>
                <button onClick={loadAnnouncements}>Refresh</button>
              </div>
              {announcements.length === 0 ? (
                <div className="empty">No announcements yet.</div>
              ) : (
                <div className="admin-session-list">
                  {announcements.map((announcement) => (
                    <div key={announcement.id} className="admin-session-row">
                      <div>
                        <div className="name">{announcement.title}</div>
                        <div className="meta">{announcement.message}</div>
                      </div>
                      <span className={`status-pill ${announcement.active ? "running" : "stopped"}`}>
                        {announcement.active ? "active" : "hidden"}
                      </span>
                      <div className="meta">{new Date(announcement.created_at).toLocaleString()}</div>
                      {announcement.active ? (
                        <button onClick={() => deactivateAnnouncement(announcement)}>Hide</button>
                      ) : (
                        <button disabled>Hidden</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        ) : (
          <section className="admin-panel">
            <div className="admin-log-toolbar">
              <h2>User Logs</h2>
              <select value={selectedUser?.id ?? ""} onChange={(e) => setSelectedUserId(Number(e.target.value))}>
                {users.map((user) => <option key={user.id} value={user.id}>{user.username}</option>)}
              </select>
            </div>
            {logs.length === 0 ? (
              <div className="empty">No logs for this user.</div>
            ) : (
              <div className="admin-log-list">
                {logs.map((log) => (
                  <div key={log.id} className="admin-log-row">
                    <div>
                      <div className="name">{log.action}</div>
                      <div className="meta">{new Date(log.created_at).toLocaleString()} {log.ip_address ? `from ${log.ip_address}` : ""}</div>
                    </div>
                    <pre>{JSON.stringify(log.details, null, 2)}</pre>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </main>

      {message && <div className={`toast ${message.kind}`}>{message.text}</div>}
    </div>
  );
}
