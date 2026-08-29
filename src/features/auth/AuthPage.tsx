import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, type User } from "../../lib/api";

type Mode = "login" | "register" | "reset" | "guest";

const OAUTH_ERROR_COPY: Record<string, string> = {
  denied: "Sign-in was cancelled. You can try again or use a username and password.",
  rate_limited: "Too many sign-in attempts. Wait a moment and try again.",
  bad_state: "That sign-in link expired. Start again from this page.",
  missing_code: "Sign-in did not complete. Please try again.",
  token: "Could not finish provider sign-in. Try again shortly.",
  profile: "Could not read your provider profile. Try again shortly.",
  not_configured: "That sign-in provider is not available right now.",
  server_config: "Sign-in is temporarily unavailable. Try again shortly.",
  failed: "Sign-in failed. Try again or use a username and password.",
};

function modeFromSearch(params: URLSearchParams): Mode {
  const m = params.get("mode");
  if (m === "register") return "register";
  if (m === "reset") return "reset";
  if (m === "guest") return "guest";
  return "login";
}

function pathForMode(mode: Mode, invite?: string | null): string {
  const q = new URLSearchParams();
  if (mode === "register") q.set("mode", "register");
  if (mode === "reset") q.set("mode", "reset");
  if (mode === "guest") q.set("mode", "guest");
  if (invite) q.set("invite", invite);
  const s = q.toString();
  return s ? `/auth?${s}` : "/auth";
}

function oauthStartHref(provider: "github" | "google", invite?: string | null): string {
  const q = new URLSearchParams();
  if (invite) q.set("invite", invite);
  const s = q.toString();
  return s ? `/api/auth/oauth/${provider}?${s}` : `/api/auth/oauth/${provider}`;
}

function GitHubGlyph() {
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d="M12 2C6.477 2 2 6.584 2 12.217c0 4.506 2.865 8.33 6.839 9.679.5.094.682-.222.682-.49 0-.242-.009-.884-.014-1.733-2.782.617-3.369-1.368-3.369-1.368-.454-1.178-1.11-1.491-1.11-1.491-.908-.635.069-.622.069-.622 1.004.072 1.532 1.053 1.532 1.053.892 1.561 2.341 1.11 2.91.85.091-.66.35-1.11.636-1.365-2.22-.258-4.555-1.137-4.555-5.062 0-1.118.39-2.033 1.029-2.75-.103-.258-.446-1.297.098-2.703 0 0 .84-.274 2.75 1.05A9.37 9.37 0 0 1 12 6.948a9.37 9.37 0 0 1 2.504.344c1.909-1.324 2.747-1.05 2.747-1.05.546 1.406.203 2.445.1 2.703.64.717 1.028 1.632 1.028 2.75 0 3.935-2.339 4.801-4.566 5.054.359.316.679.94.679 1.895 0 1.368-.012 2.47-.012 2.806 0 .27.18.588.688.488C19.138 20.543 22 16.72 22 12.217 22 6.584 17.523 2 12 2z" />
    </svg>
  );
}

function GoogleGlyph() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24">
      <path
        fill="#EA4335"
        d="M12 10.2v3.6h5.1c-.2 1.2-.9 2.2-1.9 2.9l3.1 2.4c1.8-1.7 2.9-4.1 2.9-7 0-.7-.1-1.3-.2-1.9H12z"
      />
      <path
        fill="#34A853"
        d="M6.6 14.3 5.7 15l-2.1 1.6C5.3 19.5 8.4 21.5 12 21.5c2.7 0 5-.9 6.7-2.4l-3.1-2.4c-.9.6-2 .9-3.6.9-2.8 0-5.1-1.9-5.9-4.4z"
      />
      <path
        fill="#4A90E2"
        d="M3.6 7.4C2.9 8.8 2.5 10.4 2.5 12s.4 3.2 1.1 4.6l3-2.3c-.2-.6-.3-1.2-.3-2.3 0-.8.1-1.5.3-2.2L3.6 7.4z"
      />
      <path
        fill="#FBBC05"
        d="M12 5.5c1.5 0 2.8.5 3.9 1.5l2.9-2.9C16.9 2.4 14.7 1.5 12 1.5 8.4 1.5 5.3 3.5 3.6 7.4l3 2.3C7 7.4 9.2 5.5 12 5.5z"
      />
    </svg>
  );
}

export function AuthPage({ onAuthed }: { onAuthed: (user: User) => void }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const modeFromUrl = modeFromSearch(searchParams);
  const inviteFromUrl = searchParams.get("invite");
  const oauthErrorCode = searchParams.get("oauth_error");
  const [mode, setMode] = useState<Mode>(modeFromUrl);
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(
    oauthErrorCode
      ? (OAUTH_ERROR_COPY[oauthErrorCode] ?? OAUTH_ERROR_COPY.failed!)
      : null,
  );
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [oauth, setOauth] = useState<{ github: boolean; google: boolean }>({
    github: false,
    google: false,
  });

  useEffect(() => {
    setMode(modeFromUrl);
  }, [modeFromUrl]);

  useEffect(() => {
    void (async () => {
      try {
        const cfg = await api.config();
        setOauth({
          github: Boolean(cfg.oauth?.github),
          google: Boolean(cfg.oauth?.google),
        });
      } catch {
        /* keep buttons hidden */
      }
    })();
  }, []);

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setInfo(null);
    setPassword("");
    navigate(pathForMode(next, inviteFromUrl), { replace: true });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (mode === "guest") {
        const result = await api.guest({
          displayName: displayName.trim(),
        });
        onAuthed(result.user);
        if (result.privacyNote) setInfo(result.privacyNote);
        navigate(inviteFromUrl ? `/?invite=${encodeURIComponent(inviteFromUrl)}` : "/");
        return;
      }
      if (mode === "reset") {
        setError(
          "Password reset by username and email is disabled for security. Sign in and change your password, or create a new account.",
        );
        return;
      }
      if (mode === "register") {
        const { user } = await api.register({
          username,
          email,
          password,
          displayName: displayName.trim() || undefined,
        });
        onAuthed(user);
      } else {
        const { user } = await api.login({
          username,
          password,
        });
        onAuthed(user);
      }
      navigate(inviteFromUrl ? `/?invite=${encodeURIComponent(inviteFromUrl)}` : "/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  const title =
    mode === "register"
      ? "Create your seat."
      : mode === "reset"
        ? "Reset your password."
        : mode === "guest"
          ? "Continue as guest."
          : "Deal everyone in.";
  const subtitle =
    mode === "register"
      ? "Sign up with a username, email, and password to host or join a private table. Virtual chips only."
      : mode === "reset"
        ? "Unauthenticated reset is disabled. Sign in to change your password, or create a new account if you lost access."
        : mode === "guest"
          ? "Join with a display name only. Guest names are not accounts — you cannot host until you register."
          : "Sign in with a username and password, or continue with GitHub or Google. Virtual chips only.";

  const showOauth =
    (mode === "login" || mode === "register") && (oauth.github || oauth.google);

  return (
    <section className="hero" style={{ justifyItems: "center", textAlign: "center" }}>
      <h1>{title}</h1>
      <p style={{ marginInline: "auto" }}>{subtitle}</p>
      <form
        className="panel auth-panel"
        onSubmit={(e) => void submit(e)}
        style={{ textAlign: "left" }}
      >
        {mode !== "reset" && mode !== "guest" ? (
          <div className="cta-row auth-mode-tabs" role="tablist" aria-label="Auth mode">
            <button
              className={mode === "login" ? "btn btn-primary" : "btn btn-secondary"}
              type="button"
              role="tab"
              aria-selected={mode === "login"}
              disabled={busy}
              onClick={() => switchMode("login")}
            >
              Sign in
            </button>
            <button
              className={mode === "register" ? "btn btn-primary" : "btn btn-secondary"}
              type="button"
              role="tab"
              aria-selected={mode === "register"}
              disabled={busy}
              onClick={() => switchMode("register")}
            >
              Sign up
            </button>
          </div>
        ) : null}

        {showOauth ? (
          <div className="oauth-stack" aria-label="Continue with a provider">
            {oauth.github ? (
              <a
                className="btn btn-secondary oauth-btn"
                href={oauthStartHref("github", inviteFromUrl)}
                aria-disabled={busy || undefined}
                onClick={(e) => {
                  if (busy) e.preventDefault();
                }}
              >
                <GitHubGlyph />
                Continue with GitHub
              </a>
            ) : null}
            {oauth.google ? (
              <a
                className="btn btn-secondary oauth-btn"
                href={oauthStartHref("google", inviteFromUrl)}
                aria-disabled={busy || undefined}
                onClick={(e) => {
                  if (busy) e.preventDefault();
                }}
              >
                <GoogleGlyph />
                Continue with Google
              </a>
            ) : null}
            <p className="oauth-divider muted">
              <span>or use email credentials</span>
            </p>
          </div>
        ) : null}

        {mode === "guest" ? (
          <div className="field">
            <label htmlFor="guestDisplayName">Display name</label>
            <input
              id="guestDisplayName"
              name="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="What friends call you"
              autoComplete="nickname"
              required
              minLength={2}
              maxLength={32}
            />
            <span className="muted">
              Guest names are not accounts. Session lasts 24 hours.
            </span>
          </div>
        ) : mode === "reset" ? (
          <p className="muted" role="status">
            For security, passwords can no longer be changed with only a username and
            email. Sign in with your current password, or create a new account if you lost
            access.
          </p>
        ) : (
          <>
            <div className="field">
              <label htmlFor="username">Username</label>
              <input
                id="username"
                name="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="your_handle"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
                minLength={3}
                maxLength={32}
                pattern="[A-Za-z0-9_]+"
              />
            </div>
            {mode === "register" ? (
              <div className="field">
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  maxLength={254}
                />
              </div>
            ) : null}
            {mode === "register" ? (
              <div className="field">
                <label htmlFor="displayName">Display name (optional)</label>
                <input
                  id="displayName"
                  name="displayName"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="What friends call you"
                  autoComplete="nickname"
                  maxLength={32}
                />
              </div>
            ) : null}
            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                name="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === "login" ? "Your password" : "At least 8 characters"}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                required
                minLength={8}
                maxLength={128}
              />
            </div>
          </>
        )}
        {error ? (
          <p role="alert" style={{ color: "var(--danger)", textAlign: "center" }}>
            {error}
          </p>
        ) : null}
        {info ? (
          <p role="status" className="muted" style={{ textAlign: "center" }}>
            {info}
          </p>
        ) : null}
        <div className="cta-row auth-submit-row">
          {mode === "reset" ? (
            <button
              className="btn btn-primary"
              type="button"
              disabled={busy}
              onClick={() => switchMode("login")}
            >
              Back to sign in
            </button>
          ) : (
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy
                ? "Working…"
                : mode === "register"
                  ? "Sign up"
                  : mode === "guest"
                    ? "Continue as guest"
                    : "Sign in"}
            </button>
          )}
        </div>
        {mode === "login" ? (
          <>
            <p className="muted auth-switch">
              <button type="button" disabled={busy} onClick={() => switchMode("guest")}>
                Continue as guest
              </button>
              {" · "}joining with a display name only
            </p>
            <p className="muted auth-switch">
              <button type="button" disabled={busy} onClick={() => switchMode("reset")}>
                Forgot password?
              </button>
            </p>
            <p className="muted auth-switch">
              New here?{" "}
              <button
                type="button"
                disabled={busy}
                onClick={() => switchMode("register")}
              >
                Sign up
              </button>
            </p>
          </>
        ) : mode === "register" ? (
          <p className="muted auth-switch">
            Already have an account?{" "}
            <button type="button" disabled={busy} onClick={() => switchMode("login")}>
              Sign in
            </button>
            {" · "}
            <button type="button" disabled={busy} onClick={() => switchMode("guest")}>
              Continue as guest
            </button>
          </p>
        ) : mode === "guest" ? (
          <p className="muted auth-switch">
            Prefer an account?{" "}
            <button type="button" disabled={busy} onClick={() => switchMode("login")}>
              Sign in
            </button>
            {" · "}
            <button type="button" disabled={busy} onClick={() => switchMode("register")}>
              Sign up
            </button>
          </p>
        ) : (
          <p className="muted auth-switch">
            Remembered it?{" "}
            <button type="button" disabled={busy} onClick={() => switchMode("login")}>
              Sign in
            </button>
          </p>
        )}
      </form>
      <p className="muted auth-back">
        <Link to="/">Back to lobby</Link>
      </p>
    </section>
  );
}
