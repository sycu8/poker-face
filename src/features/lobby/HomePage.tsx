import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type User } from "../../lib/api";

export function HomePage({
  user,
  copy,
  onAuthed,
}: {
  user: User | null;
  copy: { tagline: string; support: string; chips: string };
  onAuthed: (user: User) => void;
}) {
  void onAuthed;
  const navigate = useNavigate();
  const [name, setName] = useState("Friends table");
  const [smallBlind, setSmallBlind] = useState(1);
  const [startingStack, setStartingStack] = useState(100);
  const [invite, setInvite] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function createRoom() {
    setError(null);
    try {
      const { room } = await api.createRoom({
        name,
        smallBlind,
        startingStack,
      });
      setMessage(`Invite code ${room.inviteCode}`);
      navigate(`/table/${room.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create table.");
    }
  }

  async function askToJoin() {
    setError(null);
    try {
      const res = await api.joinRequest({
        inviteCode: invite.trim().toUpperCase(),
        idempotencyKey: crypto.randomUUID(),
      });
      setMessage(res.message ?? "Waiting for the host");
      if (res.status === "approved" && res.roomId) navigate(`/table/${res.roomId}`);
      else if (res.roomId) navigate(`/table/${res.roomId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not ask to join.");
    }
  }

  return (
    <section className="hero">
      <h1>{copy.tagline}</h1>
      <p>
        {copy.support} {copy.chips}
      </p>
      {!user ? (
        <div className="cta-row">
          <Link className="btn btn-primary" to="/auth">
            Create a room
          </Link>
          <Link className="btn btn-secondary" to="/auth">
            Ask to join
          </Link>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gap: "1rem",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          }}
        >
          <div className="panel">
            <h2 style={{ marginTop: 0, fontFamily: "var(--font-display)" }}>Create your table</h2>
            <div className="field">
              <label htmlFor="roomName">Table name</label>
              <input id="roomName" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="sb">Small blind</label>
              <input
                id="sb"
                type="number"
                min={1}
                value={smallBlind}
                onChange={(e) => setSmallBlind(Number(e.target.value))}
              />
              <span className="muted">Big blind is always {smallBlind * 2} (read-only).</span>
            </div>
            <div className="field">
              <label htmlFor="stack">Starting stack (10–1000)</label>
              <input
                id="stack"
                type="number"
                min={10}
                max={1000}
                value={startingStack}
                onChange={(e) => setStartingStack(Number(e.target.value))}
              />
            </div>
            <button className="btn btn-primary" type="button" onClick={() => void createRoom()}>
              Create a room
            </button>
          </div>
          <div className="panel">
            <h2 style={{ marginTop: 0, fontFamily: "var(--font-display)" }}>Ask to join</h2>
            <div className="field">
              <label htmlFor="invite">Invite code</label>
              <input
                id="invite"
                value={invite}
                onChange={(e) => setInvite(e.target.value.toUpperCase())}
                placeholder="ABC123"
              />
            </div>
            <button className="btn btn-secondary" type="button" onClick={() => void askToJoin()}>
              Ask to join
            </button>
          </div>
        </div>
      )}
      {message ? <p className="badge">{message}</p> : null}
      {error ? (
        <p role="alert" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}
    </section>
  );
}
