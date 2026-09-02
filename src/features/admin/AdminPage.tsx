import type { FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type AdminStats, type User } from "../../lib/api";
import { TurnstileWidget } from "../auth/TurnstileWidget";

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString();
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint?: string;
}) {
  return (
    <article className="admin-stat-card">
      <p className="admin-stat-label">{label}</p>
      <p className="admin-stat-value">{value.toLocaleString()}</p>
      {hint ? <p className="muted admin-stat-hint">{hint}</p> : null}
    </article>
  );
}

export function AdminPage({
  user,
  onAuthed,
}: {
  user: User | null;
  onAuthed: (user: User | null) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | undefined>();
  const [turnstileSiteKey, setTurnstileSiteKey] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);

  const isSuperAdmin = user?.role === "super_admin";

  useEffect(() => {
    void api.config().then((cfg) => {
      if (cfg.turnstileSiteKey) setTurnstileSiteKey(cfg.turnstileSiteKey);
    });
  }, []);

  const loadStats = useCallback(async () => {
    setLoadingStats(true);
    setStatsError(null);
    try {
      const data = await api.adminStats(5);
      setStats(data);
    } catch (err) {
      setStats(null);
      setStatsError(err instanceof Error ? err.message : "Could not load stats.");
    } finally {
      setLoadingStats(false);
    }
  }, []);

  useEffect(() => {
    if (!isSuperAdmin) return;
    void loadStats();
  }, [isSuperAdmin, loadStats]);

  async function onLogin(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.login({ username, password, turnstileToken });
      onAuthed(res.user);
      if (res.user.role !== "super_admin") {
        setError("This account does not have admin access.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
      setTurnstileToken(undefined);
    }
  }

  return (
    <div className="admin-shell">
      <header className="admin-header">
        <div>
          <p className="admin-eyebrow">Poker Faces</p>
          <h1>Admin portal</h1>
        </div>
        <div className="admin-header-actions">
          {user ? (
            <>
              <span className="badge">
                {user.displayName}
                {user.username ? ` (@${user.username})` : ""}
              </span>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() =>
                  void api.logout().then(() => {
                    onAuthed(null);
                    setStats(null);
                  })
                }
              >
                Sign out
              </button>
            </>
          ) : null}
          <Link className="btn btn-secondary" to="/">
            Back to lobby
          </Link>
        </div>
      </header>

      {!user ? (
        <section className="card admin-panel">
          <h2>Sign in</h2>
          <p className="muted">Super-admin accounts only.</p>
          {error ? (
            <p role="alert" style={{ color: "var(--danger)", textAlign: "center" }}>
              {error}
            </p>
          ) : null}
          <form className="auth-panel" onSubmit={(e) => void onLogin(e)}>
            <label>
              Username
              <input
                name="username"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            {turnstileSiteKey ? (
              <TurnstileWidget
                siteKey={turnstileSiteKey}
                action="login"
                onToken={(token) => setTurnstileToken(token ?? undefined)}
              />
            ) : null}
            <div className="cta-row auth-submit-row">
              <button className="btn btn-primary" type="submit" disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
              </button>
            </div>
          </form>
        </section>
      ) : !isSuperAdmin ? (
        <section className="card admin-panel">
          <h2>Access denied</h2>
          <p className="muted">
            Your account is signed in but is not a super admin. Contact the site owner if
            you need access.
          </p>
        </section>
      ) : (
        <section className="admin-dashboard">
          <div className="admin-dashboard-head">
            <div>
              <h2>Room statistics</h2>
              <p className="muted">
                Last {stats?.periodDays ?? 5} days
                {stats ? ` · since ${formatDate(stats.periodStart)}` : ""}
              </p>
            </div>
            <button
              className="btn btn-secondary"
              type="button"
              disabled={loadingStats}
              onClick={() => void loadStats()}
            >
              {loadingStats ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          {statsError ? (
            <p role="alert" style={{ color: "var(--danger)" }}>
              {statsError}
            </p>
          ) : null}

          {stats ? (
            <>
              <div className="admin-stat-grid">
                <StatCard label="Total rooms" value={stats.rooms.total} hint="All time" />
                <StatCard
                  label="Rooms created"
                  value={stats.rooms.createdInPeriod}
                  hint={`In last ${stats.periodDays} days`}
                />
                <StatCard
                  label="Open rooms"
                  value={stats.rooms.open}
                  hint="Currently open"
                />
                <StatCard
                  label="Active rooms"
                  value={stats.rooms.activeInPeriod}
                  hint="Open, with members, updated in period"
                />
                <StatCard
                  label="Rooms with hands"
                  value={stats.rooms.withHandsInPeriod}
                  hint="At least one completed hand in period"
                />
                <StatCard
                  label="Rooms closed"
                  value={stats.rooms.closedInPeriod}
                  hint="Closed in period"
                />
              </div>

              <h3 className="admin-section-title">Users</h3>
              <div className="admin-stat-grid admin-stat-grid--compact">
                <StatCard label="Total users" value={stats.users.total} />
                <StatCard
                  label="New registrations"
                  value={stats.users.registeredInPeriod}
                  hint={`In last ${stats.periodDays} days`}
                />
                <StatCard
                  label="Guest accounts"
                  value={stats.users.guests}
                  hint="All time"
                />
              </div>
            </>
          ) : loadingStats ? (
            <p className="muted">Loading statistics…</p>
          ) : null}
        </section>
      )}
    </div>
  );
}
