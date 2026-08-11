import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { api, AuthUser, getToken, setToken } from "./api";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";

// Route-level code splitting: the console pulls in the whole VNC client and
// the admin panel is admin-only, so neither belongs in the initial bundle.
const Console = lazy(() => import("./pages/Console").then((m) => ({ default: m.Console })));
const Admin = lazy(() => import("./pages/Admin").then((m) => ({ default: m.Admin })));

function PageLoading() {
  return (
    <div style={{ height: "100%", display: "grid", placeItems: "center" }}>
      <div className="console-status">Loading…</div>
    </div>
  );
}

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
    return <PageLoading />;
  }

  return (
    <Suspense fallback={<PageLoading />}>
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
        <Route path="/admin" element={user?.role === "admin" ? <Admin /> : <Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

function ConsoleWrapper() {
  const navigate = useNavigate();
  return <Console onExit={() => navigate("/")} />;
}
