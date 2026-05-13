import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { api, AuthUser, getToken, setToken } from "./api";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { Console } from "./pages/Console";

export default function App() {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  // undefined = loading, null = anon, AuthUser = signed in

  useEffect(() => {
    if (!getToken()) {
      setUser(null);
      return;
    }
    api.me().then(setUser).catch(() => {
      setToken(null);
      setUser(null);
    });
  }, []);

  if (user === undefined) {
    return <div className="login-shell"><div className="console-status">Loading...</div></div>;
  }

  return (
    <Routes>
      <Route path="/login" element={
        user ? <Navigate to="/" replace /> : <Login onSignedIn={setUser} />
      } />
      <Route path="/" element={
        user ? <Dashboard user={user} onSignOut={() => { setToken(null); setUser(null); }} />
             : <Navigate to="/login" replace />
      } />
      <Route path="/console/:sessionId" element={
        user ? <ConsoleWrapper /> : <Navigate to="/login" replace />
      } />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function ConsoleWrapper() {
  const navigate = useNavigate();
  return <Console onExit={() => navigate("/")} />;
}
