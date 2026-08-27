import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, type User } from "../../lib/api";

type Mode = "login" | "register" | "reset" | "guest";

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

export function AuthPage({ onAuthed }: { onAuthed: (user: User) => void }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const modeFromUrl = modeFromSearch(searchParams);
  const inviteFromUrl = searchParams.get("invite");
  const [mode, setMode] = useState<Mode>(modeFromUrl);
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setMode(modeFromUrl);
  }, [modeFromUrl]);

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
          : "Sign in with a username and password to host or join a private table. Virtual chips only.";

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
