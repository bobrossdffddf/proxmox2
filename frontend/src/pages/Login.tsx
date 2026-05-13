import { FormEvent, useState } from "react";
import { api, AuthUser, setToken } from "../api";

interface Props { onSignedIn: (u: AuthUser) => void }

export function Login({ onSignedIn }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.login(username, password);
      setToken(res.token);
      onSignedIn(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">WCTA<span style={{ color: "var(--cyan)" }}>RANGE</span></div>

        <label htmlFor="u">Username</label>
        <input
          id="u"
          autoFocus
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />

        <label htmlFor="p">Password</label>
        <input
          id="p"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <button className="primary submit" type="submit" disabled={submitting || !username || !password}>
          {submitting ? "Signing in..." : "Sign in"}
        </button>

        {error && <div className="error">{error}</div>}
      </form>
    </div>
  );
}
