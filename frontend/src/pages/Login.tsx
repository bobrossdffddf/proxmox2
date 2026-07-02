import { FormEvent, useState } from "react";
import { api, AuthUser, setToken } from "../api";
import { Wordmark } from "../components/Brand";

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
      <div className="login-brand">
        <div className="top">
          <Wordmark tag="Cyber Lab" />
        </div>

        <div>
          <h1 className="headline">
            The practice range is <em>hot</em>.
          </h1>
          <p className="sub">
            Full Windows and Linux desktops, streamed to your browser. Every
            launch is a clean image — break it, harden it, throw it away.
          </p>
        </div>

        <div className="foot">
          <ul className="login-facts">
            <li>No install — runs on an HTML5 canvas</li>
            <li>Fresh VM per session, wiped on exit</li>
            <li>WCTA CyberPatriot practice infrastructure</li>
          </ul>
        </div>
      </div>

      <div className="login-form-col">
        <form className="login-card" onSubmit={submit}>
          <span className="k">Operator sign-in</span>
          <h2>Access the range</h2>

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
            {submitting ? "Signing in…" : "Sign in"}
          </button>

          {error && <div className="error">{error}</div>}
        </form>
      </div>
    </div>
  );
}
