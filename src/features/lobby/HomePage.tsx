import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, type MyRoom, type User } from "../../lib/api";
import { TurnstileWidget } from "../auth/TurnstileWidget";
import { PlayingCard } from "../table/PlayingCard";

export function HomePage({
  user,
  copy,
  onAuthed,
}: {
  user: User | null;
  copy: { tagline: string; support: string; chips: string };
  onAuthed: (user: User) => void;
}) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [name, setName] = useState("Friends table");
  const [smallBlind, setSmallBlind] = useState(1);
  const [startingStack, setStartingStack] = useState(100);
  const [invite, setInvite] = useState("");
  const [guestName, setGuestName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [myRooms, setMyRooms] = useState<MyRoom[]>([]);
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileReset, setTurnstileReset] = useState(0);
  const [guestBusy, setGuestBusy] = useState(false);
  const onToken = useCallback((token: string | null) => setTurnstileToken(token), []);

  function resetTurnstile() {
    setTurnstileToken(null);
    setTurnstileReset((n) => n + 1);
  }

  useEffect(() => {
    const fromUrl = searchParams.get("invite");
    if (fromUrl) setInvite(fromUrl.trim().toUpperCase());
  }, [searchParams]);

  useEffect(() => {
    void api
      .config()
      .then((cfg) => setSiteKey(cfg.turnstileSiteKey || null))
      .catch(() => setSiteKey(null));
  }, []);

  useEffect(() => {
    if (!user) {
      setMyRooms([]);
      return;
    }
    void api
      .myRooms()
      .then((r) => setMyRooms(r.rooms))
      .catch(() => setMyRooms([]));
  }, [user]);

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
        displayName: user?.isGuest ? user.displayName : undefined,
        turnstileToken: turnstileToken ?? undefined,
      });
      setMessage(res.message ?? "Waiting for the host");
      if (res.roomId) navigate(`/table/${res.roomId}`);
    } catch (e) {
      resetTurnstile();
      setError(e instanceof Error ? e.message : "Could not ask to join.");
    }
  }

  async function continueAsGuestAndJoin() {
    setError(null);
    setGuestBusy(true);
    try {
      const result = await api.joinAsGuest({
        inviteCode: invite.trim().toUpperCase(),
        displayName: guestName.trim(),
        idempotencyKey: crypto.randomUUID(),
        turnstileToken: turnstileToken ?? undefined,
      });
      onAuthed(result.user);
      setMessage(result.join.message ?? result.privacyNote ?? "Waiting for the host");
      if (result.join.roomId) navigate(`/table/${result.join.roomId}`);
    } catch (e) {
      resetTurnstile();
      setError(e instanceof Error ? e.message : "Could not join as guest.");
    } finally {
      setGuestBusy(false);
    }
  }

  return (
    <div className="home">
      <section className="hero home-hero" aria-labelledby="home-brand">
        <div className="home-hero-copy">
          <p className="home-brand" id="home-brand">
            Poker Faces
          </p>
          <h1>{copy.tagline}</h1>
          <p className="home-lead">
            {copy.support} {copy.chips}
          </p>
          {!user ? (
            <div className="cta-row">
              <Link className="btn btn-primary" to="/auth?mode=register">
                Sign up
              </Link>
              <Link className="btn btn-secondary" to="/auth">
                Sign in
              </Link>
              <a className="btn btn-secondary" href="#guest-join">
                Continue as guest
              </a>
            </div>
          ) : (
            <div className="cta-row">
              {!user.isGuest ? (
                <a className="btn btn-primary" href="#take-a-seat">
                  Create your table
                </a>
              ) : null}
              <a className="btn btn-secondary" href="#take-a-seat">
                Ask to join
              </a>
            </div>
          )}
        </div>
        <div className="home-hero-visual" aria-hidden="true">
          <div className="home-felt">
            <div className="home-felt-glow" />
            <div className="home-felt-cards">
              <PlayingCard code="As" size="md" className="home-mini-card--a" />
              <PlayingCard code="Kh" size="md" className="home-mini-card--b" />
            </div>
            <div className="home-felt-chip" />
          </div>
        </div>
      </section>

      {!user ? (
        <section className="home-section home-section--action" id="guest-join">
          <div className="home-section-intro">
            <h2>Join with an invite</h2>
            <p className="muted">
              Friends can sit down with a display name only. Guest names are not accounts.
            </p>
          </div>
          <div className="panel" style={{ maxWidth: 420, marginInline: "auto" }}>
            <h3 className="home-panel-title">Continue as guest</h3>
            <div className="field">
              <label htmlFor="guestInvite">Invite code</label>
              <input
                id="guestInvite"
                value={invite}
                onChange={(e) => setInvite(e.target.value.toUpperCase())}
                placeholder="ABC123"
              />
            </div>
            <div className="field">
              <label htmlFor="guestName">Display name</label>
              <input
                id="guestName"
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
                placeholder="What friends call you"
                maxLength={32}
              />
            </div>
            <TurnstileWidget
              siteKey={siteKey}
              onToken={onToken}
              resetKey={turnstileReset}
              action="join-as-guest"
            />
            <div className="home-panel-actions">
              <button
                className="btn btn-primary"
                type="button"
                disabled={
                  guestBusy || guestName.trim().length < 2 || invite.trim().length < 4
                }
                onClick={() => void continueAsGuestAndJoin()}
              >
                {guestBusy ? "Joining…" : "Continue as guest"}
              </button>
            </div>
            <p className="muted" style={{ marginTop: "0.75rem" }}>
              Prefer a lasting handle?{" "}
              <Link to={`/auth?mode=register${invite ? `&invite=${invite}` : ""}`}>
                Sign up
              </Link>
              {" · "}
              <Link to={`/auth${invite ? `?invite=${invite}` : ""}`}>Sign in</Link>
            </p>
          </div>
          {message || error ? (
            <div className="home-status">
              {message ? <p className="badge">{message}</p> : null}
              {error ? (
                <p role="alert" style={{ color: "var(--danger)", margin: 0 }}>
                  {error}
                </p>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {user ? (
        <section className="home-section home-section--action" id="take-a-seat">
          <div className="home-section-intro">
            <h2>Take a seat</h2>
            <p className="muted">
              {user.isGuest
                ? "Ask to join with your guest name. Register to host a table."
                : "Host a private table or join one with an invite code."}
            </p>
          </div>
          <div className="home-action-grid">
            {!user.isGuest ? (
              <div className="panel">
                <h3 className="home-panel-title">Create your table</h3>
                <div className="field">
                  <label htmlFor="roomName">Table name</label>
                  <input
                    id="roomName"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
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
                  <span className="muted">
                    Big blind is always {smallBlind * 2} (read-only).
                  </span>
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
                <div className="home-panel-actions">
                  <button
                    className="btn btn-primary"
                    type="button"
                    onClick={() => void createRoom()}
                  >
                    Create a room
                  </button>
                </div>
              </div>
            ) : (
              <div className="panel">
                <h3 className="home-panel-title">Guest session</h3>
                <p className="muted">
                  Signed in as <strong>{user.displayName}</strong> (guest). Guest names
                  are not accounts.{" "}
                  <Link to="/auth?mode=register">Create an account</Link> to host tables.
                </p>
              </div>
            )}
            <div className="panel">
              <h3 className="home-panel-title">Ask to join</h3>
              <div className="field">
                <label htmlFor="invite">Invite code</label>
                <input
                  id="invite"
                  value={invite}
                  onChange={(e) => setInvite(e.target.value.toUpperCase())}
                  placeholder="ABC123"
                />
              </div>
              <TurnstileWidget
                siteKey={siteKey}
                onToken={onToken}
                resetKey={turnstileReset}
                action="join"
              />
              <div className="home-panel-actions">
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => void askToJoin()}
                >
                  Ask to join
                </button>
              </div>
            </div>
          </div>
          {message || error ? (
            <div className="home-status">
              {message ? <p className="badge">{message}</p> : null}
              {error ? (
                <p role="alert" style={{ color: "var(--danger)", margin: 0 }}>
                  {error}
                </p>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {user && myRooms.length > 0 ? (
        <section className="home-section" aria-labelledby="my-tables">
          <div className="home-section-intro">
            <h2 id="my-tables">My tables</h2>
            <p className="muted">Rooms you host or have a seat at.</p>
          </div>
          <ul className="my-tables-list">
            {myRooms.map((r) => (
              <li key={r.id}>
                <Link className="my-table-link" to={`/table/${r.id}`}>
                  <strong>{r.name}</strong>
                  <span className="muted">
                    {r.isHost ? "Host" : "Player"}
                    {" · "}
                    blinds {r.smallBlind}/{r.bigBlind}
                    {r.inviteCode ? ` · ${r.inviteCode}` : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="home-section home-section--next" aria-labelledby="what-next">
        <div className="home-section-intro">
          <h2 id="what-next">What to do next</h2>
          <p className="muted">
            A private digital table for friends — sign up, then create or join a room.
            Play-money Texas Hold&apos;em with virtual chips only.
          </p>
        </div>
        <ol className="home-steps">
          <li className="home-step">
            <span className="home-step-num" aria-hidden="true">
              1
            </span>
            <div>
              <h3>Sign up</h3>
              <p className="muted">
                Create an account so you can host or take a seat at a table.
              </p>
            </div>
          </li>
          <li className="home-step">
            <span className="home-step-num" aria-hidden="true">
              2
            </span>
            <div>
              <h3>Create or join</h3>
              <p className="muted">
                Hosts open a room and share an invite code. Guests ask to join and wait
                for approval.
              </p>
            </div>
          </li>
          <li className="home-step">
            <span className="home-step-num" aria-hidden="true">
              3
            </span>
            <div>
              <h3>Deal the next hand</h3>
              <p className="muted">
                Once you have a seat, play continuous hands with your people — voice
                optional, chips always virtual.
              </p>
            </div>
          </li>
        </ol>
        {!user ? (
          <div className="cta-row home-section-cta">
            <Link className="btn btn-primary" to="/auth?mode=register">
              Sign up
            </Link>
            <Link className="btn btn-secondary" to="/auth">
              Sign in
            </Link>
          </div>
        ) : null}
      </section>

      <section className="home-section home-section--play" aria-labelledby="how-to-play">
        <div className="home-section-intro">
          <h2 id="how-to-play">How to play</h2>
          <p className="muted">
            Friendly Texas Hold&apos;em flow — enough to sit down and deal.
          </p>
        </div>
        <ol className="home-flow">
          <li>
            <strong>Blinds</strong>
            <span className="muted">
              Small and big blinds post. Big blind is always twice the small blind the
              host set.
            </span>
          </li>
          <li>
            <strong>Hole cards</strong>
            <span className="muted">
              Each player gets two private cards. No dealer hand.
            </span>
          </li>
          <li>
            <strong>Betting rounds</strong>
            <span className="muted">
              Bet through preflop, flop (3), turn (1), and river (1) as the board builds.
            </span>
          </li>
          <li>
            <strong>Showdown</strong>
            <span className="muted">
              Best five-card hand with hole cards and the board wins the pot. Next hand
              starts when you&apos;re ready.
            </span>
          </li>
        </ol>
      </section>

      <section
        className="home-section home-section--roles"
        aria-labelledby="hosts-guests"
      >
        <div className="home-section-intro">
          <h2 id="hosts-guests">Hosts and guests</h2>
          <p className="muted">
            Everyone plays the same game — hosts keep the table running.
          </p>
        </div>
        <div className="home-roles">
          <div className="home-role">
            <h3>If you host</h3>
            <ul>
              <li>Set the small blind and starting stacks (10–1000 virtual chips).</li>
              <li>Share the invite code with your people.</li>
              <li>Approve who gets a seat before they join the table.</li>
              <li>Rule changes mid-hand wait until the next hand starts.</li>
            </ul>
          </div>
          <div className="home-role">
            <h3>If you join</h3>
            <ul>
              <li>Enter the invite code and ask to join.</li>
              <li>Wait for the host — you&apos;ll see when you have a seat.</li>
              <li>Joining mid-hand? You sit out until the next deal.</li>
              <li>Reconnect anytime; your seat and private cards stay yours.</li>
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}
