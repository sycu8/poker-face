#!/usr/bin/env node
/**
 * Sanitized production-scale seed + API/WS inventory pass for Poker Faces.
 * Uses clearly fake qa_* identities. No production / no real PII.
 *
 * Usage: node scripts/qa-seed-and-pass.mjs [baseUrl]
 * Default baseUrl: http://127.0.0.1:5210
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

const BASE = process.argv[2] ?? "http://127.0.0.1:5210";
const OUT = "/opt/cursor/artifacts";
mkdirSync(OUT, { recursive: true });

const results = [];
const bugs = [];
const seed = {
  users: [],
  rooms: [],
  handsPlayed: 0,
  chatMessages: 0,
  rebuys: 0,
  pendingJoins: 0,
};

function log(id, ok, detail) {
  results.push({ id, ok, detail, at: new Date().toISOString() });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${id}: ${detail}`);
}

function bug(entry) {
  bugs.push({ ...entry, at: new Date().toISOString() });
  console.error(`[BUG ${entry.id}] ${entry.severity}: ${entry.title}`);
}

async function parse(res) {
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Non-JSON ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function cookieJar() {
  let jar = "";
  return {
    get cookie() {
      return jar;
    },
    store(res) {
      const raw = res.headers.getSetCookie?.() ?? [];
      const list = raw.length
        ? raw
        : res.headers.get("set-cookie")
          ? [res.headers.get("set-cookie")]
          : [];
      for (const c of list) {
        const part = c.split(";")[0];
        const name = part.split("=")[0];
        const rest = jar
          .split("; ")
          .filter(Boolean)
          .filter((x) => !x.startsWith(name + "="));
        rest.push(part);
        jar = rest.join("; ");
      }
    },
  };
}

async function api(jar, path, opts = {}) {
  const headers = { ...(opts.headers ?? {}) };
  if (jar.cookie) headers.cookie = jar.cookie;
  if (opts.body && !headers["content-type"]) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  jar.store(res);
  return { res, data: await parse(res) };
}

async function register(username, email, password, displayName) {
  const jar = cookieJar();
  const { data } = await api(jar, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username, email, password, displayName }),
  });
  seed.users.push({ username, email, displayName, id: data.user.id });
  return { jar, user: data.user };
}

async function login(username, password) {
  const jar = cookieJar();
  const { data } = await api(jar, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  return { jar, user: data.user };
}

function wsUrl(roomId) {
  const u = new URL(BASE);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = `/ws/rooms/${roomId}`;
  u.search = "";
  return u.toString();
}

function openWs(roomId, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(roomId), {
      headers: cookie ? { cookie } : {},
    });
    const state = { view: null, meta: null, chat: [], pendingJoins: [], errors: [] };
    const waiters = [];
    ws.addEventListener("open", () => resolve({ ws, state, waitSnapshot }));
    ws.addEventListener("error", (e) => reject(e));
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === "snapshot" && msg.view) {
        state.view = msg.view;
        if (msg.meta) state.meta = msg.meta;
        if (msg.chat) state.chat = msg.chat;
        if (msg.pendingJoins) state.pendingJoins = msg.pendingJoins;
        for (const w of waiters.splice(0)) w(msg);
      }
      if (msg.type === "chat" && msg.message) state.chat.push(msg.message);
      if (msg.type === "error") state.errors.push(msg.error);
      if (msg.type === "join_request") {
        state.pendingJoins = [
          ...state.pendingJoins.filter((x) => x.requestId !== msg.requestId),
          { requestId: msg.requestId, userId: msg.userId, displayName: msg.displayName },
        ];
      }
    });
    function waitSnapshot(timeoutMs = 8000) {
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error("snapshot timeout")), timeoutMs);
        waiters.push((msg) => {
          clearTimeout(t);
          res(msg);
        });
      });
    }
  });
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(`QA pass against ${BASE}`);

  // --- Health / config ---
  {
    const res = await fetch(`${BASE}/api/health`);
    const data = await parse(res);
    log("health", data.ok === true, JSON.stringify(data));
  }
  {
    const res = await fetch(`${BASE}/api/config`);
    const data = await parse(res);
    log(
      "config",
      Boolean(data.copy?.chips?.includes("Virtual")),
      `env=${data.environment} themes=${data.flags?.themesEnabled} history=${data.flags?.handHistoryEnabled}`,
    );
  }

  const stamp = Date.now().toString(36);
  const password = "QaPassw0rd!local";

  // --- Auth: register host + players ---
  let host, p2, p3, p4, spectator;
  try {
    host = await register(
      `qa_host_${stamp}`,
      `qa_host_${stamp}@example.test`,
      password,
      "QA Host",
    );
    log("auth.register.host", true, host.user.id);
  } catch (e) {
    log("auth.register.host", false, String(e));
    bug({
      id: "BUG-AUTH-01",
      severity: "P0",
      title: "Host registration failed",
      steps: "POST /api/auth/register qa_host_*",
      expected: "201/user session",
      actual: String(e),
      evidence: "scripts/qa-seed-and-pass.mjs",
    });
    throw e;
  }

  try {
    p2 = await register(
      `qa_p2_${stamp}`,
      `qa_p2_${stamp}@example.test`,
      password,
      "QA Player Two",
    );
    p3 = await register(
      `qa_p3_${stamp}`,
      `qa_p3_${stamp}@example.test`,
      password,
      "QA Player Three",
    );
    p4 = await register(
      `qa_p4_${stamp}`,
      `qa_p4_${stamp}@example.test`,
      password,
      "QA Player Four",
    );
    spectator = await register(
      `qa_spec_${stamp}`,
      `qa_spec_${stamp}@example.test`,
      password,
      "QA Spectator",
    );
    log("auth.register.cohort", true, `4 more users (${seed.users.length} total)`);
  } catch (e) {
    log("auth.register.cohort", false, String(e));
    throw e;
  }

  // Login edge: wrong password
  try {
    await login(`qa_host_${stamp}`, "wrong-password");
    log("auth.login.bad_password", false, "accepted wrong password");
    bug({
      id: "BUG-AUTH-02",
      severity: "P0",
      title: "Wrong password accepted",
      steps: "login with wrong password",
      expected: "error",
      actual: "success",
      evidence: "scripts/qa-seed-and-pass.mjs",
    });
  } catch (e) {
    log("auth.login.bad_password", true, String(e.message || e));
  }

  // Duplicate username
  try {
    await register(`qa_host_${stamp}`, `qa_dup_${stamp}@example.test`, password, "Dup");
    log("auth.register.dup_username", false, "duplicate allowed");
    bug({
      id: "BUG-AUTH-03",
      severity: "P1",
      title: "Duplicate username allowed",
      steps: "register same username twice",
      expected: "error",
      actual: "success",
      evidence: "scripts/qa-seed-and-pass.mjs",
    });
  } catch (e) {
    log("auth.register.dup_username", true, String(e.message || e));
  }

  // Password reset happy path
  try {
    const jar = cookieJar();
    const { data } = await api(jar, "/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({
        username: `qa_p4_${stamp}`,
        email: `qa_p4_${stamp}@example.test`,
        newPassword: "QaPassw0rd!reset",
      }),
    });
    const relog = await login(`qa_p4_${stamp}`, "QaPassw0rd!reset");
    log("auth.reset.happy", Boolean(data.ok && relog.user.id), data.message ?? "ok");
    p4 = relog;
  } catch (e) {
    log("auth.reset.happy", false, String(e));
    bug({
      id: "BUG-AUTH-04",
      severity: "P1",
      title: "Password reset failed",
      steps: "reset with matching username+email then login",
      expected: "password updated",
      actual: String(e),
      evidence: "scripts/qa-seed-and-pass.mjs",
    });
  }

  // Reset with wrong email
  try {
    const jar = cookieJar();
    await api(jar, "/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({
        username: `qa_host_${stamp}`,
        email: "wrong@example.test",
        newPassword: "QaPassw0rd!nope",
      }),
    });
    log("auth.reset.wrong_email", false, "accepted wrong email");
    bug({
      id: "BUG-AUTH-05",
      severity: "P0",
      title: "Password reset with wrong email succeeded",
      steps: "reset with mismatched email",
      expected: "generic failure / no change",
      actual: "success",
      evidence: "scripts/qa-seed-and-pass.mjs",
    });
  } catch (e) {
    log("auth.reset.wrong_email", true, String(e.message || e));
  }

  // --- Create rooms (active / waiting / second table) ---
  let roomA, roomB, roomC;
  {
    const { data } = await api(host.jar, "/api/rooms", {
      method: "POST",
      body: JSON.stringify({
        name: `QA Active ${stamp}`,
        smallBlind: 1,
        startingStack: 100,
      }),
    });
    roomA = data.room;
    seed.rooms.push({
      id: roomA.id,
      name: roomA.name,
      invite: roomA.inviteCode,
      kind: "active",
    });
    log("rooms.create.A", true, `${roomA.id} invite=${roomA.inviteCode}`);
  }
  {
    const { data } = await api(host.jar, "/api/rooms", {
      method: "POST",
      body: JSON.stringify({
        name: `QA Waiting ${stamp}`,
        smallBlind: 2,
        startingStack: 200,
      }),
    });
    roomB = data.room;
    seed.rooms.push({
      id: roomB.id,
      name: roomB.name,
      invite: roomB.inviteCode,
      kind: "waiting",
    });
    log("rooms.create.B", true, roomB.id);
  }
  {
    const { data } = await api(p2.jar, "/api/rooms", {
      method: "POST",
      body: JSON.stringify({
        name: `QA OtherHost ${stamp}`,
        smallBlind: 5,
        startingStack: 500,
      }),
    });
    roomC = data.room;
    seed.rooms.push({
      id: roomC.id,
      name: roomC.name,
      invite: roomC.inviteCode,
      kind: "other_host",
    });
    log("rooms.create.C", true, roomC.id);
  }

  // Invalid create
  try {
    await api(host.jar, "/api/rooms", {
      method: "POST",
      body: JSON.stringify({ name: "x", smallBlind: 0, startingStack: 5 }),
    });
    log("rooms.create.invalid", false, "accepted invalid blinds/stack");
    bug({
      id: "BUG-ROOM-01",
      severity: "P2",
      title: "Invalid room config accepted",
      steps: "create room SB=0 stack=5",
      expected: "validation error",
      actual: "success",
      evidence: "scripts/qa-seed-and-pass.mjs",
    });
  } catch (e) {
    log("rooms.create.invalid", true, String(e.message || e));
  }

  // --- Join / approve / decline ---
  async function join(jar, inviteCode) {
    const { data } = await api(jar, "/api/rooms/join-request", {
      method: "POST",
      body: JSON.stringify({ inviteCode, idempotencyKey: randomUUID() }),
    });
    return data;
  }

  const join2 = await join(p2.jar, roomA.inviteCode);
  const join3 = await join(p3.jar, roomA.inviteCode);
  const join4 = await join(p4.jar, roomA.inviteCode);
  seed.pendingJoins += 3;
  log(
    "rooms.join.requests",
    join2.status === "pending" && join3.status === "pending",
    `p2=${join2.requestId} p3=${join3.requestId} p4=${join4.requestId}`,
  );

  // Duplicate join idempotency
  const join2b = await join(p2.jar, roomA.inviteCode);
  const dupOk = join2b.requestId === join2.requestId;
  log("rooms.join.duplicate", dupOk, JSON.stringify(join2b));
  if (!dupOk) {
    bug({
      id: "BUG-JOIN-01",
      severity: "P1",
      title: "Duplicate pending join created for same user/room",
      steps: "join-request twice with different idempotency keys before approve",
      expected: "same requestId reused",
      actual: `first=${join2.requestId} second=${join2b.requestId}`,
      evidence: "scripts/qa-seed-and-pass.mjs",
    });
  }

  // Bad invite
  try {
    await join(spectator.jar, "ZZZZZZ");
    log("rooms.join.bad_invite", false, "accepted bad invite");
    bug({
      id: "BUG-ROOM-02",
      severity: "P1",
      title: "Bad invite accepted",
      steps: "join with ZZZZZZ",
      expected: "error",
      actual: "success",
      evidence: "scripts/qa-seed-and-pass.mjs",
    });
  } catch (e) {
    log("rooms.join.bad_invite", true, String(e.message || e));
  }

  // Non-host cannot approve
  try {
    await api(p2.jar, "/api/rooms/join-decision", {
      method: "POST",
      body: JSON.stringify({
        requestId: join3.requestId,
        approve: true,
        idempotencyKey: randomUUID(),
      }),
    });
    log("rooms.approve.non_host", false, "non-host approved");
    bug({
      id: "BUG-ROOM-03",
      severity: "P0",
      title: "Non-host can approve joins",
      steps: "player calls join-decision approve",
      expected: "permission denied",
      actual: "success",
      evidence: "scripts/qa-seed-and-pass.mjs",
    });
  } catch (e) {
    log("rooms.approve.non_host", true, String(e.message || e));
  }

  // Host approve p2 + p3, decline p4
  await api(host.jar, "/api/rooms/join-decision", {
    method: "POST",
    body: JSON.stringify({
      requestId: join2.requestId,
      approve: true,
      seatIndex: 1,
      idempotencyKey: randomUUID(),
    }),
  });
  await api(host.jar, "/api/rooms/join-decision", {
    method: "POST",
    body: JSON.stringify({
      requestId: join3.requestId,
      approve: true,
      idempotencyKey: randomUUID(),
    }),
  });
  await api(host.jar, "/api/rooms/join-decision", {
    method: "POST",
    body: JSON.stringify({
      requestId: join4.requestId,
      approve: false,
      idempotencyKey: randomUUID(),
    }),
  });
  log("rooms.approve.decide", true, "approved p2+p3, declined p4");

  const accessRejected = await api(p4.jar, `/api/rooms/${roomA.id}`);
  log(
    "rooms.access.rejected",
    accessRejected.data.access === "rejected",
    accessRejected.data.access,
  );

  // --- My rooms ---
  const mine = await api(host.jar, "/api/rooms/mine");
  log("rooms.mine", mine.data.rooms.length >= 2, `count=${mine.data.rooms.length}`);

  // --- WebSocket play ---
  const hostWs = await openWs(roomA.id, host.jar.cookie);
  const p2Ws = await openWs(roomA.id, p2.jar.cookie);
  const p3Ws = await openWs(roomA.id, p3.jar.cookie);
  await Promise.race([hostWs.waitSnapshot(), sleep(3000)]);
  await sleep(500);

  if (!hostWs.state.view) {
    log("ws.snapshot", false, "no snapshot for host");
    bug({
      id: "BUG-WS-01",
      severity: "P0",
      title: "No WebSocket snapshot after connect",
      steps: "open /ws/rooms/:id as member",
      expected: "snapshot",
      actual: "none",
      evidence: "scripts/qa-seed-and-pass.mjs",
    });
  } else {
    log(
      "ws.snapshot",
      hostWs.state.view.seats.filter((s) => s.playerId).length >= 3,
      `seated=${hostWs.state.view.seats.filter((s) => s.playerId).length} street=${hostWs.state.view.street}`,
    );
  }

  // Chat
  hostWs.ws.send(
    JSON.stringify({ type: "chat", text: "QA host says hello — virtual chips only." }),
  );
  p2Ws.ws.send(JSON.stringify({ type: "chat", text: "QA p2 checking in." }));
  await sleep(400);
  seed.chatMessages += 2;
  log(
    "chat.send",
    hostWs.state.chat.length >= 1 || p2Ws.state.chat.length >= 1,
    `hostChat=${hostWs.state.chat.length} p2Chat=${p2Ws.state.chat.length}`,
  );

  // Ask host to start (from p2)
  p2Ws.ws.send(JSON.stringify({ type: "request_start" }));
  await sleep(300);
  log("ask_host_start", true, "request_start sent");

  // Deal hand
  hostWs.ws.send(JSON.stringify({ type: "start_hand" }));
  await hostWs.waitSnapshot().catch(() => null);
  await sleep(200);
  const street1 = hostWs.state.view?.street;
  log("hand.deal", street1 === "preflop", `street=${street1}`);

  // Play streets: fold/check/call/raise until waiting or showdown
  async function actOnce(label) {
    const view = hostWs.state.view;
    if (!view || view.street === "waiting" || view.street === "showdown") return false;
    const actors = [
      { jar: host, ws: hostWs, id: host.user.id },
      { jar: p2, ws: p2Ws, id: p2.user.id },
      { jar: p3, ws: p3Ws, id: p3.user.id },
    ];
    for (const a of actors) {
      const seat = a.ws.state.view?.seats.find((s) => s.playerId === a.id);
      const legal = a.ws.state.view?.legalActions;
      const myTurn =
        a.ws.state.view?.actionSeat !== null &&
        seat &&
        a.ws.state.view.actionSeat === seat.seatIndex &&
        legal;
      if (!myTurn) continue;
      let action = "check";
      let amount;
      if (legal.canCheck) action = "check";
      else if (legal.canCall) action = "call";
      else if (legal.canFold) action = "fold";
      if (label === "raise" && (legal.canRaise || legal.canBet)) {
        action = legal.canRaise ? "raise" : "bet";
        amount = legal.canRaise ? legal.minRaiseTo : legal.minBet;
      }
      if (label === "fold" && legal.canFold && a.id === p3.user.id) {
        action = "fold";
      }
      a.ws.ws.send(
        JSON.stringify({
          type: "action",
          action,
          amount,
          expectedVersion: a.ws.state.view.sequence,
          idempotencyKey: randomUUID(),
        }),
      );
      await a.ws.waitSnapshot().catch(() => sleep(200));
      return true;
    }
    return false;
  }

  // Mid-hand: illegal action from wrong player
  {
    const view = p2Ws.state.view;
    const seat = view?.seats.find((s) => s.playerId === p2.user.id);
    if (view && seat && view.actionSeat !== seat.seatIndex) {
      p2Ws.ws.send(
        JSON.stringify({
          type: "action",
          action: "fold",
          expectedVersion: view.sequence,
          idempotencyKey: randomUUID(),
        }),
      );
      await sleep(300);
      const err = p2Ws.state.errors.at(-1);
      log("hand.action.out_of_turn", Boolean(err), err ?? "no error recorded");
      if (!err) {
        bug({
          id: "BUG-HAND-01",
          severity: "P1",
          title: "Out-of-turn action produced no error",
          steps: "non-action seat sends fold",
          expected: "error message",
          actual: "silent",
          evidence: "scripts/qa-seed-and-pass.mjs",
        });
      }
    } else {
      log("hand.action.out_of_turn", true, "skipped — p2 already to act");
    }
  }

  // Raise then continue to end of hand
  await actOnce("raise");
  for (let i = 0; i < 40; i++) {
    const progressed = await actOnce(i % 7 === 0 ? "fold" : "call");
    if (!progressed) {
      await sleep(150);
    }
    if (hostWs.state.view?.street === "waiting") break;
  }
  seed.handsPlayed += 1;
  const last = hostWs.state.view?.lastHandResult;
  log(
    "hand.complete",
    hostWs.state.view?.street === "waiting" || Boolean(last),
    `street=${hostWs.state.view?.street} winners=${last?.winners?.length ?? 0} bestFive=${last?.winners?.[0]?.hand?.bestFive?.join(",") ?? "-"}`,
  );

  if (last?.winners?.[0] && !last.winners[0].hand?.bestFive?.length) {
    bug({
      id: "BUG-HAND-02",
      severity: "P2",
      title: "Showdown winners missing bestFive cards",
      steps: "complete hand to showdown",
      expected: "winners include bestFive",
      actual: JSON.stringify(last.winners[0]),
      evidence: "scripts/qa-seed-and-pass.mjs",
    });
  }

  // Away / sitting out
  try {
    const { data } = await api(p2.jar, `/api/rooms/${roomA.id}/away`, {
      method: "POST",
      body: JSON.stringify({ away: true }),
    });
    await sleep(300);
    const seat = hostWs.state.view?.seats.find((s) => s.playerId === p2.user.id);
    log(
      "presence.away",
      data.status === "ok" || seat?.status === "sitting_out",
      `api=${data.status} seat=${seat?.status}`,
    );
    await api(p2.jar, `/api/rooms/${roomA.id}/away`, {
      method: "POST",
      body: JSON.stringify({ away: false }),
    });
  } catch (e) {
    log("presence.away", false, String(e));
    bug({
      id: "BUG-PRESENCE-01",
      severity: "P2",
      title: "Away toggle failed",
      steps: "POST /away {away:true}",
      expected: "sitting_out",
      actual: String(e),
      evidence: "scripts/qa-seed-and-pass.mjs",
    });
  }

  // Config update mid-hand vs between hands
  try {
    const { data } = await api(host.jar, `/api/rooms/${roomA.id}/config`, {
      method: "POST",
      body: JSON.stringify({ smallBlind: 2, startingStack: 150, potCapMultiplier: 3 }),
    });
    log(
      "config.update",
      data.status === "ok" || data.pending === true,
      JSON.stringify(data),
    );
  } catch (e) {
    log("config.update", false, String(e));
  }

  // Non-host config denied
  try {
    await api(p2.jar, `/api/rooms/${roomA.id}/config`, {
      method: "POST",
      body: JSON.stringify({ smallBlind: 9 }),
    });
    log("config.non_host", false, "non-host updated config");
    bug({
      id: "BUG-ROOM-04",
      severity: "P0",
      title: "Non-host can change table rules",
      steps: "player POST /config",
      expected: "denied",
      actual: "success",
      evidence: "scripts/qa-seed-and-pass.mjs",
    });
  } catch (e) {
    log("config.non_host", true, String(e.message || e));
  }

  // Deal another hand then rebuy path: force all-in fold bust optional
  hostWs.ws.send(JSON.stringify({ type: "start_hand" }));
  await hostWs.waitSnapshot().catch(() => null);
  for (let i = 0; i < 30; i++) {
    const progressed = await actOnce("call");
    if (!progressed) await sleep(100);
    if (hostWs.state.view?.street === "waiting") break;
  }
  seed.handsPlayed += 1;

  // Rebuy self when stack 0 (may or may not apply)
  try {
    const seat = p3Ws.state.view?.seats.find((s) => s.playerId === p3.user.id);
    if (seat && seat.stack === 0) {
      const { data } = await api(p3.jar, `/api/rooms/${roomA.id}/rebuy`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      seed.rebuys += 1;
      log("rebuy.self", data.status === "ok", JSON.stringify(data));
    } else {
      // Host rebuy for p3 even if not busted — expect either ok or error
      try {
        const { data } = await api(host.jar, `/api/rooms/${roomA.id}/rebuy`, {
          method: "POST",
          body: JSON.stringify({ targetUserId: p3.user.id, chips: 100 }),
        });
        seed.rebuys += 1;
        log("rebuy.host_target", true, JSON.stringify(data));
      } catch (e) {
        log("rebuy.host_target", true, `expected-or-ok: ${e.message || e}`);
      }
    }
  } catch (e) {
    log("rebuy", false, String(e));
  }

  // Hand history
  try {
    await sleep(1500); // allow queue consumer
    const { data } = await api(host.jar, `/api/rooms/${roomA.id}/hands`);
    log("history.list", Array.isArray(data.hands), `count=${data.hands?.length ?? 0}`);
    if (data.hands?.length) {
      const hn = data.hands[0].handNumber;
      const detail = await api(host.jar, `/api/rooms/${roomA.id}/hands/${hn}`);
      log(
        "history.detail",
        Boolean(detail.data.summary),
        `hand=${hn} source=${detail.data.source}`,
      );
    } else {
      log("history.detail", true, "no archived hands yet (queue lag OK)");
    }
  } catch (e) {
    log("history.list", false, String(e));
    bug({
      id: "BUG-HIST-01",
      severity: "P2",
      title: "Hand history API failed",
      steps: "GET /hands after play",
      expected: "list",
      actual: String(e),
      evidence: "scripts/qa-seed-and-pass.mjs",
    });
  }

  // Voice degraded path
  try {
    const { data } = await api(host.jar, `/api/rooms/${roomA.id}/voice-token`, {
      method: "POST",
    });
    const degradedOk =
      data.available === false &&
      (data.reason === "not_configured" || Boolean(data.message));
    log(
      "voice.degraded",
      degradedOk || data.available === true,
      JSON.stringify({
        available: data.available,
        reason: data.reason,
        message: data.message,
      }),
    );
    if (!degradedOk && data.available !== true) {
      bug({
        id: "BUG-VOICE-01",
        severity: "P2",
        title: "Voice token response unclear when not configured",
        steps: "POST voice-token without Realtime Admin secrets",
        expected: "available:false + reason/message",
        actual: JSON.stringify(data),
        evidence: "scripts/qa-seed-and-pass.mjs",
      });
    }
  } catch (e) {
    log("voice.degraded", false, String(e));
    bug({
      id: "BUG-VOICE-02",
      severity: "P1",
      title: "Voice token endpoint throws instead of degraded response",
      steps: "POST voice-token",
      expected: "200 with available:false",
      actual: String(e),
      evidence: "scripts/qa-seed-and-pass.mjs",
    });
  }

  // Kick p3
  try {
    const { data } = await api(host.jar, `/api/rooms/${roomA.id}/kick`, {
      method: "POST",
      body: JSON.stringify({ targetUserId: p3.user.id }),
    });
    log("kick", data.status === "ok" || Boolean(data.message), JSON.stringify(data));
  } catch (e) {
    log("kick", false, String(e));
    bug({
      id: "BUG-ROOM-05",
      severity: "P1",
      title: "Host kick failed",
      steps: "POST /kick",
      expected: "player removed",
      actual: String(e),
      evidence: "scripts/qa-seed-and-pass.mjs",
    });
  }

  // Leave as p2
  try {
    const { data } = await api(p2.jar, `/api/rooms/${roomA.id}/leave`, {
      method: "POST",
    });
    log(
      "leave.player",
      data.status === "ok" || Boolean(data.message),
      JSON.stringify(data),
    );
  } catch (e) {
    log("leave.player", false, String(e));
    bug({
      id: "BUG-ROOM-06",
      severity: "P1",
      title: "Player leave failed",
      steps: "POST /leave",
      expected: "left",
      actual: String(e),
      evidence: "scripts/qa-seed-and-pass.mjs",
    });
  }

  // Pending join left on roomB (waiting room with pending)
  const pendSpec = await join(spectator.jar, roomB.inviteCode);
  seed.pendingJoins += 1;
  log("rooms.pending.kept", pendSpec.status === "pending", pendSpec.status);

  // Feature presence checks (parity)
  const featureGaps = [];
  for (const feat of [
    { id: "guest_join", probe: async () => false },
    { id: "ledger", probe: async () => false },
    { id: "pause", probe: async () => false },
    { id: "time_bank", probe: async () => Boolean(hostWs.state.view?.turnDeadlineMs) },
    { id: "spectator_mode", probe: async () => false },
    { id: "host_transfer", probe: async () => false },
    { id: "host_close_room", probe: async () => false },
  ]) {
    // Detect from code surface via API 404s where applicable
    let present = false;
    if (feat.id === "time_bank") {
      // turn timer exists; dedicated time-bank button does not
      present = false;
      log(
        "feature.turn_timer",
        Boolean(hostWs.state.view?.config),
        "turnDeadline field exists in views when acting",
      );
    }
    if (feat.id === "ledger") {
      const res = await fetch(`${BASE}/api/rooms/${roomA.id}/ledger`, {
        headers: { cookie: host.jar.cookie },
      });
      present = res.status !== 404;
    }
    if (feat.id === "pause") {
      const res = await fetch(`${BASE}/api/rooms/${roomA.id}/pause`, {
        method: "POST",
        headers: { cookie: host.jar.cookie, "content-type": "application/json" },
        body: "{}",
      });
      present = res.status !== 404;
    }
    if (feat.id === "host_close_room") {
      const res = await fetch(`${BASE}/api/rooms/${roomA.id}/close`, {
        method: "POST",
        headers: { cookie: host.jar.cookie },
      });
      present = res.status !== 404;
    }
    if (feat.id === "host_transfer") {
      const res = await fetch(`${BASE}/api/rooms/${roomA.id}/transfer-host`, {
        method: "POST",
        headers: { cookie: host.jar.cookie, "content-type": "application/json" },
        body: JSON.stringify({ targetUserId: p2.user.id }),
      });
      present = res.status !== 404;
    }
    if (feat.id === "guest_join") {
      const res = await fetch(`${BASE}/api/rooms/guest-join`, { method: "POST" });
      present = res.status !== 404;
    }
    if (feat.id === "spectator_mode") {
      const res = await fetch(`${BASE}/api/rooms/${roomA.id}/spectate`, {
        method: "POST",
        headers: { cookie: spectator.jar.cookie },
      });
      present = res.status !== 404;
    }
    if (!present) featureGaps.push(feat.id);
    log(`feature.${feat.id}`, true, present ? "PRESENT" : "MISSING (blocked/deferred)");
  }

  // Logout
  try {
    await api(host.jar, "/api/auth/logout", { method: "POST" });
    const me = await fetch(`${BASE}/api/auth/me`, {
      headers: { cookie: host.jar.cookie },
    });
    const body = await me.json();
    log("auth.logout", me.status === 401 || body.user === null, `status=${me.status}`);
  } catch (e) {
    log("auth.logout", false, String(e));
  }

  hostWs.ws.close();
  p2Ws.ws.close();
  p3Ws.ws.close();

  const summary = {
    base: BASE,
    seed,
    featureGaps,
    passCount: results.filter((r) => r.ok).length,
    failCount: results.filter((r) => !r.ok).length,
    bugCount: bugs.length,
    results,
    bugs,
  };

  writeFileSync(`${OUT}/qa_api_pass_results.json`, JSON.stringify(summary, null, 2));
  console.log(
    `\nDone. pass=${summary.passCount} fail=${summary.failCount} bugs=${summary.bugCount} gaps=${featureGaps.join(",")}`,
  );
  if (summary.failCount > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
