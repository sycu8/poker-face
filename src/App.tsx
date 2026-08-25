import { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { api, type User } from "./lib/api";
import { HomePage } from "./features/lobby/HomePage";
import { AuthPage } from "./features/auth/AuthPage";
import { TablePage } from "./features/table/TablePage";

type ThemeId = "felt" | "midnight" | "sunset";

function loadTheme(): ThemeId {
  const saved = localStorage.getItem("pf-theme");
  if (saved === "midnight" || saved === "sunset" || saved === "felt") return saved;
  return "felt";
}

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [theme, setTheme] = useState<ThemeId>(loadTheme);
  const [themesEnabled, setThemesEnabled] = useState(true);
  const [copy, setCopy] = useState({
    tagline: "Your table. Your people.",
    support: "Private poker nights, wherever everyone is.",
    chips: "Virtual chips only. No purchases or cash-out.",
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("pf-theme", theme);
  }, [theme]);

  useEffect(() => {
    void (async () => {
      try {
        const cfg = await api.config();
        setCopy(cfg.copy);
        if (cfg.flags?.themesEnabled === false) setThemesEnabled(false);
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
      <header className="app-header">
        <Link to="/" className="brand-lockup" style={{ textDecoration: "none", color: "inherit" }}>
          <img src="/logo/poker-faces-mark.svg" alt="" width={48} height={48} />
          <div>
            <strong style={{ fontSize: "1.15rem" }}>Poker Faces</strong>
            <div className="muted" style={{ fontSize: "0.85rem" }}>
              {copy.tagline}
            </div>
          </div>
        </Link>
        <div className="app-header-actions">
          {themesEnabled ? (
            <label className="theme-picker muted">
              Theme
              <select
                value={theme}
                onChange={(e) => setTheme(e.target.value as ThemeId)}
                aria-label="Table theme"
              >
                <option value="felt">Felt</option>
                <option value="midnight">Midnight</option>
                <option value="sunset">Sunset</option>
              </select>
            </label>
          ) : null}
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
        <Route path="/" element={<HomePage user={user} copy={copy} onAuthed={setUser} />} />
        <Route path="/auth" element={<AuthPage onAuthed={setUser} />} />
        <Route
          path="/table/:roomId"
          element={user ? <TablePage user={user} /> : <Navigate to="/auth" replace />}
        />
      </Routes>
    </div>
  );
}
