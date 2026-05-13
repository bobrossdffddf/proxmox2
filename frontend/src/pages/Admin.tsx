import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AdminUser, api, AuditLog } from "../api";

type Tab = "users" | "logs";

export function Admin() {
  const [tab, setTab] = useState<Tab>("users");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [form, setForm] = useState({
    username: "",
    password: "",
    role: "student",
    maxVms: 1,
    allowedTemplates: "*",
  });

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

  useEffect(() => {
    loadUsers().catch((err) => setMessage({ kind: "error", text: err.message ?? "Failed to load users" }));
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
            <p className="subtitle">Manage access, passwords, VM limits, and user activity.</p>
          </div>
          <div className="admin-tabs">
            <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}>Users</button>
            <button className={tab === "logs" ? "active" : ""} onClick={() => setTab("logs")}>Logs</button>
          </div>
        </div>

        {tab === "users" ? (
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
