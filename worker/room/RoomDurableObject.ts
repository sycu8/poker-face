import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import {
  applyAction,
  createInitialGameState,
  projectForPlayer,
  seatPlayer,
  startHand,
  type ActionType,
  type GameState,
} from "../domain/engine";
import type { TableConfig } from "../domain/config";

interface ChatMessage {
  id: string;
  userId: string;
  displayName: string;
  text: string;
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
 */
export class RoomDurableObject extends DurableObject<Env> {
  private game: GameState | null = null;
  private roomId: string | null = null;
  private hostUserId: string | null = null;
  private chat: ChatMessage[] = [];
  private pendingJoins: Array<{
    requestId: string;
    userId: string;
    displayName: string;
  }> = [];
  private actionIdempotency = new Map<string, string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS room_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS room_events (
          sequence INTEGER PRIMARY KEY,
          payload TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);
      const row = this.ctx.storage.sql
        .exec<{ value: string }>(`SELECT value FROM room_meta WHERE key = 'snapshot'`)
        .toArray()[0];
      if (row) {
        const snap = JSON.parse(row.value) as {
          roomId: string;
          hostUserId: string;
          game: GameState;
          chat: ChatMessage[];
          pendingJoins: Array<{
            requestId: string;
            userId: string;
            displayName: string;
          }>;
        };
        this.roomId = snap.roomId;
        this.hostUserId = snap.hostUserId;
        this.game = snap.game;
        this.chat = snap.chat ?? [];
        this.pendingJoins = snap.pendingJoins ?? [];
      }
    });
  }

  private persist(): void {
    if (!this.game || !this.roomId || !this.hostUserId) return;
    const value = JSON.stringify({
      roomId: this.roomId,
      hostUserId: this.hostUserId,
      game: this.game,
      chat: this.chat.slice(-100),
      pendingJoins: this.pendingJoins,
    });
    this.ctx.storage.sql.exec(
      `INSERT INTO room_meta (key, value) VALUES ('snapshot', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      value,
    );
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

  private sendProjection(ws: WebSocket): void {
    if (!this.game) return;
    const att = ws.deserializeAttachment() as ClientAttachment | null;
    const view = projectForPlayer(this.game, att?.userId ?? null);
    ws.send(
      JSON.stringify({
        type: "snapshot",
        view,
        chat: this.chat.slice(-50),
        pendingJoins: att?.userId === this.hostUserId ? this.pendingJoins : undefined,
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
        config: TableConfig;
      };
      this.roomId = body.roomId;
      this.hostUserId = body.hostUserId;
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
      return Response.json({ ok: true });
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
      for (const ws of this.ctx.getWebSockets()) this.sendProjection(ws);
      return Response.json({ ok: true, seatIndex });
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

    if (data.type === "start_hand") {
      if (att.userId !== this.hostUserId) {
        ws.send(JSON.stringify({ type: "error", error: "Only the host can deal." }));
        return;
      }
      const events = startHand(this.game, Date.now());
      this.persist();
      await this.ctx.storage.setAlarm(this.game.turnDeadlineMs ?? Date.now() + 1000);
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
          this.env.ANALYTICS.writeDataPoint({
            blobs: ["hand_complete", this.roomId],
            doubles: [this.game.handNumber],
            indexes: [this.roomId],
          });
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
    this.persist();
    if (this.game.turnDeadlineMs) {
      await this.ctx.storage.setAlarm(this.game.turnDeadlineMs);
    }
    for (const socket of this.ctx.getWebSockets()) this.sendProjection(socket);
    this.broadcast({ type: "events", events: result.events, reason: "timeout" });
  }
}
