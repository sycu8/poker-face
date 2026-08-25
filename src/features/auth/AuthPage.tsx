import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type User } from "../../lib/api";

export function AuthPage({ onAuthed }: { onAuthed: (user: User) => void }) {
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function register() {
    setBusy(true);
    setError(null);
    try {
      const { challengeId, options, displayName: name } = await api.registerOptions(displayName);
      const response = await startRegistration({ optionsJSON: options as never });
      const { user } = await api.registerVerify({ challengeId, displayName: name, response });
      onAuthed(user);
      navigate("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create your passkey.");
    } finally {
      setBusy(false);
    }
  }

  async function login() {
    setBusy(true);
    setError(null);
    try {
      const { challengeId, options } = await api.loginOptions();
      const response = await startAuthentication({ optionsJSON: options as never });
      const { user } = await api.loginVerify({ challengeId, response });
      onAuthed(user);
      navigate("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="hero">
      <h1>Deal everyone in.</h1>
      <p>Use a passkey to host or join a private table. Virtual chips only.</p>
      <div className="panel" style={{ maxWidth: 420 }}>
        <div className="field">
          <label htmlFor="displayName">Display name</label>
          <input
            id="displayName"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="What friends call you"
            autoComplete="nickname"
          />
        </div>
        {error ? (
          <p role="alert" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        ) : null}
        <div className="cta-row">
          <button
            className="btn btn-primary"
            type="button"
            disabled={busy || displayName.trim().length < 2}
            onClick={() => void register()}
          >
            Create passkey
          </button>
          <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => void login()}>
            Sign in with passkey
          </button>
        </div>
      </div>
    </section>
  );
}
