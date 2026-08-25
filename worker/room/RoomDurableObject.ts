import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import {
  applyAction,
  createInitialGameState,
  projectForPlayer,
  rebuyPlayer,
  seatPlayer,
  setPlayerAway,
  startHand,
  flushDeferredLeaves,
  unseatPlayer,
  type ActionType,
  type GameState,
} from "../domain/engine";
import type { TableConfig } from "../domain/config";
import { writeAnalytics } from "../lib/analytics";

interface ChatMessage {
  id: string;
  userId: string;
  displayName: string;
  text: string;
  at: number;
}

interface StartRequest {
  userId: string;
  displayName: string;
  at: number;
}

interface ClientAttachment {
  userId: string;
  displayName: string;
  lastAckSequence: number;
}

/**
 * One SQLite-backed Durable Object per room.
 * Authoritative game state + hibernatable WebSockets + text chat.
 *
 * Reconnect model: snapshot-only. Clients receive a private projected snapshot
 * (with monotonic `sequence`) on connect / after stale actions. The legacy
 * `room_events` table is not used and is dropped when present.
 */
export class RoomDurableObject extends DurableObject<Env> {
  private game: GameState | null = null;
  private roomId: string | null = null;
  private hostUserId: string | null = null;
  private roomName: string | null = null;
  private inviteCode: string | null = null;
  private chat: ChatMessage[] = [];
  private pendingJoins: Array<{
    requestId: string;
    userId: string;
    displayName: string;
  }> = [];
  /** Non-host players asking the host to deal the next hand (coalesced by userId). */
  private startRequests: StartRequest[] = [];
  /** Players who left/kicked mid-hand — cleared when street returns to waiting. */
  private pendingLeaves = new Set<string>();
  private actionIdempotency = new Map<string, string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS room_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      // Snapshot-only reconnect — drop unused event log if an older DO created it.
      try {
        this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS room_events`);
      } catch {
        /* ignore */
      }
      const row = this.ctx.storage.sql
        .exec<{ value: string }>(`SELECT value FROM room_meta WHERE key = 'snapshot'`)
        .toArray()[0];
      if (row) {
        const snap = JSON.parse(row.value) as {
          roomId: string;
          hostUserId: string;
          roomName?: string;
          inviteCode?: string;
          game: GameState;
          chat: ChatMessage[];
          pendingJoins: Array<{
            requestId: string;
            userId: string;
            displayName: string;
          }>;
          startRequests?: StartRequest[];
          pendingLeaves?: string[];
        };
        this.roomId = snap.roomId;
        this.hostUserId = snap.hostUserId;
        this.roomName = snap.roomName ?? null;
        this.inviteCode = snap.inviteCode ?? null;
        this.game = snap.game;
        this.chat = snap.chat ?? [];
        this.pendingJoins = snap.pendingJoins ?? [];
        this.startRequests = snap.startRequests ?? [];
        this.pendingLeaves = new Set(snap.pendingLeaves ?? []);
      }
    });
  }

  private persist(): void {
    if (!this.game || !this.roomId || !this.hostUserId) return;
    const value = JSON.stringify({
      roomId: this.roomId,
      hostUserId: this.hostUserId,
      roomName: this.roomName,
      inviteCode: this.inviteCode,
      game: this.game,
      chat: this.chat.slice(-100),
      pendingJoins: this.pendingJoins,
      startRequests: this.startRequests,
      pendingLeaves: [...this.pendingLeaves],
    });
    this.ctx.storage.sql.exec(
      `INSERT INTO room_meta (key, value) VALUES ('snapshot', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      value,
    );
  }

  private flushLeavesIfWaiting(): void {
    if (!this.game || this.game.street !== "waiting" || this.pendingLeaves.size === 0) return;
    flushDeferredLeaves(this.game, [...this.pendingLeaves]);
    this.pendingLeaves.clear();
  }

  private broadcast(message: unknown, exceptUserId?: string): void {
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as ClientAttachment | null;
      if (exceptUserId && att?.userId === exceptUserId) continue;
      try {
        ws.send(payload);
      } catch {
        /* ignore broken sockets */
      }
    }
  }

  private startRequestSummary() {
    const latest = this.startRequests[this.startRequests.length - 1] ?? null;
    return {
      count: this.startRequests.length,
      latestDisplayName: latest?.displayName ?? null,
      requesters: this.startRequests.map((r) => ({
        userId: r.userId,
        displayName: r.displayName,
      })),
    };
  }

  private sendProjection(ws: WebSocket): void {
    if (!this.game) return;
    const att = ws.deserializeAttachment() as ClientAttachment | null;
    const view = projectForPlayer(this.game, att?.userId ?? null);
    const isHost = att?.userId === this.hostUserId;
    ws.send(
      JSON.stringify({
        type: "snapshot",
        view,
        meta: {
          roomId: this.roomId,
          roomName: this.roomName,
          inviteCode: this.inviteCode,
          hostUserId: this.hostUserId,
        },
        chat: this.chat.slice(-50),
        pendingJoins: isHost ? this.pendingJoins : undefined,
        startRequests: isHost ? this.startRequestSummary() : undefined,
        askedToStart:
          !isHost && att?.userId
            ? this.startRequests.some((r) => r.userId === att.userId)
            : undefined,
      }),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/init" && request.method === "POST") {
      const body = (await request.json()) as {
        roomId: string;
        hostUserId: string;
        hostDisplayName: string;
        roomName?: string;
        inviteCode?: string;
        config: TableConfig;
      };
      this.roomId = body.roomId;
      this.hostUserId = body.hostUserId;
      this.roomName = body.roomName ?? "Friends table";
      this.inviteCode = body.inviteCode ?? null;
      this.game = createInitialGameState(body.config);
      seatPlayer(this.game, body.hostUserId, body.hostDisplayName, 0);
      this.persist();
      return Response.json({ ok: true });
    }

    if (url.pathname === "/join-request" && request.method === "POST") {
      const body = (await request.json()) as {
        requestId: string;
        userId: string;
        displayName: string;
      };
      this.pendingJoins.push(body);
      this.persist();
      this.broadcast({ type: "join_request", ...body });
      for (const ws of this.ctx.getWebSockets()) this.sendProjection(ws);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/reject" && request.method === "POST") {
      const body = (await request.json()) as { requestId: string; userId: string };
      this.pendingJoins = this.pendingJoins.filter((j) => j.requestId !== body.requestId);
      this.persist();
      this.broadcast({ type: "join_rejected", requestId: body.requestId, userId: body.userId });
      for (const ws of this.ctx.getWebSockets()) this.sendProjection(ws);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/config" && request.method === "POST") {
      if (!this.game) return Response.json({ ok: false, error: "Room not ready." });
      const body = (await request.json()) as {
        smallBlind?: number;
        startingStack?: number;
        potCapMultiplier?: number;
      };
      const pending = {
        ...(body.smallBlind !== undefined ? { smallBlind: body.smallBlind } : {}),
        ...(body.startingStack !== undefined ? { startingStack: body.startingStack } : {}),
        ...(body.potCapMultiplier !== undefined
          ? { potCapMultiplier: body.potCapMultiplier }
          : {}),
      };
      if (this.game.street === "waiting") {
        const next = {
          ...this.game.config,
          ...(pending.smallBlind !== undefined
            ? { smallBlind: pending.smallBlind, bigBlind: pending.smallBlind * 2 }
            : {}),
          ...(pending.startingStack !== undefined
            ? { startingStack: pending.startingStack }
            : {}),
          ...(pending.potCapMultiplier !== undefined
            ? { potCapMultiplier: pending.potCapMultiplier }
            : {}),
        };
        this.game.config = next;
        this.game.pendingConfig = null;
        this.game.sequence += 1;
        this.persist();
        for (const ws of this.ctx.getWebSockets()) this.sendProjection(ws);
        return Response.json({ ok: true, pending: false });
      }
      this.game.pendingConfig = { ...this.game.pendingConfig, ...pending };
      this.game.sequence += 1;
      this.persist();
      for (const ws of this.ctx.getWebSockets()) this.sendProjection(ws);
      return Response.json({ ok: true, pending: true });
    }

    if (url.pathname === "/approve" && request.method === "POST") {
      if (!this.game) return Response.json({ ok: false, error: "Room not ready." });
      const body = (await request.json()) as {
        userId: string;
        displayName: string;
        seatIndex?: number;
        requestId: string;
      };
      let seatIndex = body.seatIndex;
      if (seatIndex === undefined) {
        seatIndex = this.game.seats.findIndex((s) => !s.playerId);
      } else if (this.game.seats[seatIndex]?.playerId) {
        return Response.json({ ok: false, error: "That seat is taken." });
      }
      if (seatIndex < 0) {
        return Response.json({ ok: false, error: "This table is full." });
      }
      const result = seatPlayer(this.game, body.userId, body.displayName, seatIndex);
      if (!result.ok) return Response.json(result);
      this.pendingJoins = this.pendingJoins.filter((j) => j.requestId !== body.requestId);
      this.persist();
      this.broadcast({
        type: "player_seated",
        userId: body.userId,
        displayName: body.displayName,
        seatIndex,
        message: "You have a seat",
      });
      writeAnalytics(this.env, "player_seated", this.roomId ?? "unknown", [seatIndex], [
        body.userId.slice(0, 8),
      ]);
      for (const ws of this.ctx.getWebSockets()) this.sendProjection(ws);
      return Response.json({ ok: true, seatIndex });
    }

    if (url.pathname === "/leave" && request.method === "POST") {
      if (!this.game) return Response.json({ ok: false, error: "Room not ready." });
      const body = (await request.json()) as { userId: string };
      if (body.userId === this.hostUserId) {
        return Response.json({
          ok: false,
          error: "Host cannot leave while hosting. Transfer host or close the table.",
        });
      }
      const result = unseatPlayer(this.game, body.userId, Date.now());
      if (!result.ok) return Response.json(result);
      this.startRequests = this.startRequests.filter((r) => r.userId !== body.userId);
      if (result.deferred) this.pendingLeaves.add(body.userId);
      else this.pendingLeaves.delete(body.userId);
      this.flushLeavesIfWaiting();
      this.persist();
      this.broadcast({ type: "player_left", userId: body.userId });
      writeAnalytics(this.env, "player_left", this.roomId ?? "unknown");
      for (const ws of this.ctx.getWebSockets()) this.sendProjection(ws);
      if (result.events.length) this.broadcast({ type: "events", events: result.events });
      return Response.json({ ok: true });
    }

    if (url.pathname === "/kick" && request.method === "POST") {
      if (!this.game) return Response.json({ ok: false, error: "Room not ready." });
      const body = (await request.json()) as { hostUserId: string; targetUserId: string };
      if (body.hostUserId !== this.hostUserId) {
        return Response.json({ ok: false, error: "Only the host can kick players." });
      }
      if (body.targetUserId === this.hostUserId) {
        return Response.json({ ok: false, error: "Host cannot kick themselves." });
      }
      const result = unseatPlayer(this.game, body.targetUserId, Date.now());
      if (!result.ok) return Response.json(result);
      this.startRequests = this.startRequests.filter((r) => r.userId !== body.targetUserId);
      if (result.deferred) this.pendingLeaves.add(body.targetUserId);
      else this.pendingLeaves.delete(body.targetUserId);
      this.flushLeavesIfWaiting();
      this.persist();
      this.broadcast({ type: "player_kicked", userId: body.targetUserId });
      writeAnalytics(this.env, "player_kicked", this.roomId ?? "unknown");
      for (const ws of this.ctx.getWebSockets()) this.sendProjection(ws);
      if (result.events.length) this.broadcast({ type: "events", events: result.events });
      return Response.json({ ok: true });
    }

    if (url.pathname === "/rebuy" && request.method === "POST") {
      if (!this.game) return Response.json({ ok: false, error: "Room not ready." });
      const body = (await request.json()) as {
        requesterId: string;
        targetUserId: string;
        chips?: number;
      };
      const isHost = body.requesterId === this.hostUserId;
      const isSelf = body.requesterId === body.targetUserId;
      if (!isHost && !isSelf) {
        return Response.json({ ok: false, error: "Only the host or the player can rebuy." });
      }
      const result = rebuyPlayer(this.game, body.targetUserId, body.chips);
      if (!result.ok) return Response.json(result);
      this.persist();
      this.broadcast({ type: "rebuy", userId: body.targetUserId });
      writeAnalytics(this.env, "rebuy", this.roomId ?? "unknown", [body.chips ?? 0]);
      for (const ws of this.ctx.getWebSockets()) this.sendProjection(ws);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/away" && request.method === "POST") {
      if (!this.game) return Response.json({ ok: false, error: "Room not ready." });
      const body = (await request.json()) as { userId: string; away: boolean };
      const result = setPlayerAway(this.game, body.userId, body.away);
      if (!result.ok) return Response.json(result);
      this.persist();
      this.broadcast({ type: "away", userId: body.userId, away: body.away });
      for (const ws of this.ctx.getWebSockets()) this.sendProjection(ws);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/open-seats" && request.method === "GET") {
      if (!this.game) return Response.json({ ok: false, error: "Room not ready." });
      const open = this.game.seats
        .filter((s) => !s.playerId)
        .map((s) => s.seatIndex);
      return Response.json({ ok: true, openSeats: open });
    }

    if (url.pathname === "/ws") {
      const userId = url.searchParams.get("userId");
      const displayName = url.searchParams.get("displayName") ?? "Player";
      if (!userId) return new Response("userId required", { status: 400 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({
        userId,
        displayName,
        lastAckSequence: 0,
      } satisfies ClientAttachment);
      this.sendProjection(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (!this.game) return;
    const att = ws.deserializeAttachment() as ClientAttachment;
    let data: {
      type: string;
      action?: ActionType;
      amount?: number;
      text?: string;
      expectedVersion?: number;
      idempotencyKey?: string;
    };
    try {
      data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "Invalid message." }));
      return;
    }

    if (data.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", sequence: this.game.sequence }));
      return;
    }

    if (data.type === "chat" && data.text) {
      const text = data.text.trim().slice(0, 280);
      if (!text) return;
      const msg: ChatMessage = {
        id: crypto.randomUUID(),
        userId: att.userId,
        displayName: att.displayName,
        text,
        at: Date.now(),
      };
      this.chat.push(msg);
      this.persist();
      this.broadcast({ type: "chat", message: msg });
      return;
    }

    if (data.type === "request_start") {
      if (att.userId === this.hostUserId) {
        ws.send(JSON.stringify({ type: "error", error: "You can deal whenever you are ready." }));
        return;
      }
      if (this.game.street !== "waiting") {
        ws.send(JSON.stringify({ type: "error", error: "A hand is already in progress." }));
        return;
      }
      const seated = this.game.seats.some((s) => s.playerId === att.userId);
      if (!seated) {
        ws.send(JSON.stringify({ type: "error", error: "Take a seat before asking to deal." }));
        return;
      }

      const now = Date.now();
      const existing = this.startRequests.find((r) => r.userId === att.userId);
      if (existing) {
        // Idempotent: same player clicking again does not spam the host.
        if (now - existing.at < 5_000) {
          ws.send(
            JSON.stringify({
              type: "start_request_ack",
              askedToStart: true,
              ...this.startRequestSummary(),
            }),
          );
          return;
        }
        existing.displayName = att.displayName;
        existing.at = now;
        // Move to end so they are the latest requester.
        this.startRequests = [
          ...this.startRequests.filter((r) => r.userId !== att.userId),
          existing,
        ];
      } else {
        this.startRequests.push({
          userId: att.userId,
          displayName: att.displayName,
          at: now,
        });
      }
      this.persist();
      const summary = this.startRequestSummary();
      this.broadcast({
        type: "start_request",
        userId: att.userId,
        displayName: att.displayName,
        ...summary,
      });
      ws.send(JSON.stringify({ type: "start_request_ack", askedToStart: true, ...summary }));
      for (const socket of this.ctx.getWebSockets()) this.sendProjection(socket);
      return;
    }

    if (data.type === "start_hand") {
      if (att.userId !== this.hostUserId) {
        ws.send(JSON.stringify({ type: "error", error: "Only the host can deal." }));
        return;
      }
      this.startRequests = [];
      const events = startHand(this.game, Date.now());
      this.persist();
      await this.ctx.storage.setAlarm(this.game.turnDeadlineMs ?? Date.now() + 1000);
      writeAnalytics(this.env, "hand_started", this.roomId ?? "unknown", [this.game.handNumber]);
      for (const socket of this.ctx.getWebSockets()) this.sendProjection(socket);
      this.broadcast({ type: "events", events });
      return;
    }

    if (data.type === "action" && data.action) {
      const seat = this.game.seats.find((s) => s.playerId === att.userId);
      if (!seat) {
        ws.send(JSON.stringify({ type: "error", error: "No seat." }));
        return;
      }
      if (
        data.expectedVersion !== undefined &&
        data.expectedVersion !== this.game.sequence
      ) {
        ws.send(
          JSON.stringify({
            type: "error",
            error: "Stale version. Rejoining your seat…",
            sequence: this.game.sequence,
          }),
        );
        this.sendProjection(ws);
        return;
      }
      const idem = data.idempotencyKey ?? crypto.randomUUID();
      if (this.actionIdempotency.has(idem)) {
        this.sendProjection(ws);
        return;
      }
      const result = applyAction(
        this.game,
        seat.seatIndex,
        data.action,
        data.amount,
        Date.now(),
        idem,
      );
      if (!result.ok) {
        ws.send(JSON.stringify({ type: "error", error: result.error }));
        return;
      }
      this.actionIdempotency.set(idem, "ok");
      this.persist();
      if (this.game.turnDeadlineMs) {
        await this.ctx.storage.setAlarm(this.game.turnDeadlineMs);
      } else {
        await this.ctx.storage.deleteAlarm();
      }
      this.flushLeavesIfWaiting();
      for (const socket of this.ctx.getWebSockets()) this.sendProjection(socket);
      this.broadcast({ type: "events", events: result.events });

      if (result.events.some((e) => e.type === "hand_complete") && this.roomId) {
        try {
          await this.env.ARCHIVE_QUEUE.send({
            type: "hand_complete",
            roomId: this.roomId,
            handNumber: this.game.handNumber,
            summary: this.game.lastHandResult,
            idempotencyKey: `hand:${this.roomId}:${this.game.handNumber}`,
          });
        } catch {
          /* queue optional in some local setups */
        }
        try {
          writeAnalytics(this.env, "hand_complete", this.roomId, [this.game.handNumber]);
        } catch {
          /* analytics best-effort */
        }
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    void ws;
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    void ws;
  }

  async alarm(): Promise<void> {
    if (!this.game || this.game.actionSeat === null) return;
    const seat = this.game.seats[this.game.actionSeat];
    if (!seat || seat.status !== "active") return;
    const legal =
      seat.betThisStreet < this.game.currentBet
        ? ("fold" as const)
        : ("check" as const);
    const result = applyAction(
      this.game,
      seat.seatIndex,
      legal,
      undefined,
      Date.now(),
      `timeout:${this.game.sequence}`,
    );
    if (!result.ok) return;
    this.flushLeavesIfWaiting();
    this.persist();
    if (this.game.turnDeadlineMs) {
      await this.ctx.storage.setAlarm(this.game.turnDeadlineMs);
    }
    for (const socket of this.ctx.getWebSockets()) this.sendProjection(socket);
    this.broadcast({ type: "events", events: result.events, reason: "timeout" });
  }
}
