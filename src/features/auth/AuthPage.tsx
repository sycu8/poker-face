import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, type User } from "../../lib/api";

type Mode = "login" | "register";

export function AuthPage({ onAuthed }: { onAuthed: (user: User) => void }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const modeFromUrl: Mode = searchParams.get("mode") === "register" ? "register" : "login";
  const [mode, setMode] = useState<Mode>(modeFromUrl);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setMode(modeFromUrl);
  }, [modeFromUrl]);

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    navigate(next === "register" ? "/auth?mode=register" : "/auth", { replace: true });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "register") {
        const { user } = await api.register({
          username,
          password,
          displayName: displayName.trim() || undefined,
        });
        onAuthed(user);
      } else {
        const { user } = await api.login({ username, password });
        onAuthed(user);
      }
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="hero" style={{ justifyItems: "center", textAlign: "center" }}>
      <h1>{mode === "register" ? "Create your seat." : "Deal everyone in."}</h1>
      <p style={{ marginInline: "auto" }}>
        {mode === "register"
          ? "Sign up with a username and password to host or join a private table. Virtual chips only."
          : "Sign in with a username and password to host or join a private table. Virtual chips only."}
      </p>
      <form className="panel auth-panel" onSubmit={(e) => void submit(e)} style={{ textAlign: "left" }}>
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
            placeholder={mode === "register" ? "At least 8 characters" : "Your password"}
            autoComplete={mode === "register" ? "new-password" : "current-password"}
            required
            minLength={8}
            maxLength={128}
          />
        </div>
        {error ? (
          <p role="alert" style={{ color: "var(--danger)", textAlign: "center" }}>
            {error}
          </p>
        ) : null}
        <div className="cta-row auth-submit-row">
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? "Working…" : mode === "register" ? "Sign up" : "Sign in"}
          </button>
        </div>
        {mode === "login" ? (
          <p className="muted auth-switch">
            New here?{" "}
            <button type="button" disabled={busy} onClick={() => switchMode("register")}>
              Sign up
            </button>
          </p>
        ) : (
          <p className="muted auth-switch">
            Already have an account?{" "}
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
