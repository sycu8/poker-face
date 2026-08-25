import type { FormEvent } from "react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type User } from "../../lib/api";

type Mode = "login" | "register";

export function AuthPage({ onAuthed }: { onAuthed: (user: User) => void }) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    <section className="hero">
      <h1>Deal everyone in.</h1>
      <p>Sign in with a username and password to host or join a private table. Virtual chips only.</p>
      <form className="panel" style={{ maxWidth: 420 }} onSubmit={(e) => void submit(e)}>
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
          <p role="alert" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        ) : null}
        <div className="cta-row">
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? "Working…" : mode === "register" ? "Create account" : "Sign in"}
          </button>
          <button
            className="btn btn-secondary"
            type="button"
            disabled={busy}
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError(null);
            }}
          >
            {mode === "login" ? "Need an account?" : "Have an account?"}
          </button>
        </div>
      </form>
    </section>
  );
}
