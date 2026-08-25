import { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { api, type User } from "./lib/api";
import { HomePage } from "./features/lobby/HomePage";
import { AuthPage } from "./features/auth/AuthPage";
import { TablePage } from "./features/table/TablePage";

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [copy, setCopy] = useState({
    tagline: "Your table. Your people.",
    support: "Private poker nights, wherever everyone is.",
    chips: "Virtual chips only. No purchases or cash-out.",
  });

  useEffect(() => {
    void (async () => {
      try {
        const cfg = await api.config();
        setCopy(cfg.copy);
      } catch {
        /* keep defaults */
      }
      try {
        const me = await api.me();
        setUser(me.user);
      } catch {
        setUser(null);
      }
    })();
  }, []);

  if (user === undefined) {
    return (
      <div className="app-shell">
        <p className="muted">Loading your table…</p>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "1rem",
          marginBottom: "0.5rem",
        }}
      >
        <Link to="/" className="brand-lockup" style={{ textDecoration: "none", color: "inherit" }}>
          <img src="/logo/poker-faces-mark.svg" alt="" width={48} height={48} />
          <div>
            <strong style={{ fontSize: "1.15rem" }}>Poker Faces</strong>
            <div className="muted" style={{ fontSize: "0.85rem" }}>
              {copy.tagline}
            </div>
          </div>
        </Link>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          {user ? (
            <>
              <span className="badge" aria-label={`Signed in as ${user.displayName}`}>
                {user.displayName}
              </span>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() =>
                  void api.logout().then(() => {
                    setUser(null);
                  })
                }
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <Link className="btn btn-secondary" to="/auth">
                Sign in
              </Link>
              <Link className="btn btn-primary" to="/auth?mode=register">
                Sign up
              </Link>
            </>
          )}
        </div>
      </header>

      <Routes>
        <Route
          path="/"
          element={<HomePage user={user} copy={copy} onAuthed={setUser} />}
        />
        <Route path="/auth" element={<AuthPage onAuthed={setUser} />} />
        <Route
          path="/table/:roomId"
          element={user ? <TablePage user={user} /> : <Navigate to="/auth" replace />}
        />
      </Routes>
    </div>
  );
}
