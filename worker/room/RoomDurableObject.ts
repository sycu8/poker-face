import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import {
  applyAction,
  createInitialGameState,
  getLegalActions,
  normalizeGameState,
  onTurnTimerExpired,
  projectForPlayer,
  rabbitHunt,
  rebuyPlayer,
  seatPlayer,
  setPaused,
  setPlayerAway,
  startHand,
  flushDeferredLeaves,
  unseatPlayer,
  type ActionType,
  type GameState,
} from "../domain/engine";
import { chooseBotAction, isBotUserId, nextBotDisplayName } from "../domain/bots";
import type { TableConfig } from "../domain/config";
import {
  buildLedgerSnapshot,
  emptyLedger,
  ledgerToCsv,
  recordBuyIn,
  recordBuyOut,
  type LedgerPlayer,
} from "../domain/ledger";
import { writeAnalytics } from "../lib/analytics";
import { createRealtimeKitMeeting } from "../voice/realtimekit";

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
  private closed = false;
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
  /** Session chip ledger keyed by userId. */
  private ledger: Record<string, LedgerPlayer> = emptyLedger();
  /** Unseated members watching the table (true spectators). */
  private spectators = new Map<string, string>();
  /** RealtimeKit meeting id (create-once; synced to D1). */
  private realtimekitMeetingId: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS room_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
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
          closed?: boolean;
          game: GameState;
          chat: ChatMessage[];
          pendingJoins: Array<{
            requestId: string;
            userId: string;
            displayName: string;
          }>;
          startRequests?: StartRequest[];
          pendingLeaves?: string[];
          ledger?: Record<string, LedgerPlayer>;
          spectators?: Array<{ userId: string; displayName: string }>;
          realtimekitMeetingId?: string | null;
        };
        this.roomId = snap.roomId;
        this.hostUserId = snap.hostUserId;
        this.roomName = snap.roomName ?? null;
        this.inviteCode = snap.inviteCode ?? null;
        this.closed = Boolean(snap.closed);
        this.game = snap.game ? normalizeGameState(snap.game) : null;
        this.chat = snap.chat ?? [];
        this.pendingJoins = snap.pendingJoins ?? [];
        this.startRequests = snap.startRequests ?? [];
        this.pendingLeaves = new Set(snap.pendingLeaves ?? []);
        this.ledger = snap.ledger ?? emptyLedger();
        this.spectators = new Map(
          (snap.spectators ?? []).map((s) => [s.userId, s.displayName]),
        );
        this.realtimekitMeetingId = snap.realtimekitMeetingId ?? null;
      }
      if (!this.realtimekitMeetingId) {
        const meetingRow = this.ctx.storage.sql
          .exec<{ value: string }>(
            `SELECT value FROM room_meta WHERE key = 'realtimekit_meeting_id'`,
          )
          .toArray()[0];
        if (meetingRow?.value) this.realtimekitMeetingId = meetingRow.value;
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
      closed: this.closed,
      game: this.game,
      chat: this.chat.slice(-100),
      pendingJoins: this.pendingJoins,
      startRequests: this.startRequests,
      pendingLeaves: [...this.pendingLeaves],
      ledger: this.ledger,
      spectators: [...this.spectators.entries()].map(([userId, displayName]) => ({
        userId,
        displayName,
      })),
      realtimekitMeetingId: this.realtimekitMeetingId,
    });
    this.ctx.storage.sql.exec(
      `INSERT INTO room_meta (key, value) VALUES ('snapshot', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      value,
    );
  }

  /** Persist meeting id even when a full game snapshot is not ready. */
  private persistMeetingId(): void {
    if (this.game && this.roomId && this.hostUserId) {
      this.persist();
      return;
    }
    if (!this.realtimekitMeetingId) return;
    this.ctx.storage.sql.exec(
      `INSERT INTO room_meta (key, value) VALUES ('realtimekit_meeting_id', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      this.realtimekitMeetingId,
    );
  }

  private ledgerSnapshot() {
    const stacks = new Map<string, number>();
    if (this.game) {
      for (const s of this.game.seats) {
        if (s.playerId) stacks.set(s.playerId, s.stack);
      }
    }
    return buildLedgerSnapshot(this.ledger, stacks);
  }

  /**
   * Settle deferred leaves only after hand completion: record final stacks
   * (post-showdown) into the ledger exactly once, then clear seats.
   */
  private flushLeavesIfWaiting(): void {
    if (!this.game || this.game.street !== "waiting" || this.pendingLeaves.size === 0) return;
    const ids = [...this.pendingLeaves];
    const settlements = flushDeferredLeaves(this.game, ids);
    for (const { playerId, stack } of settlements) {
      if (this.ledger[playerId]?.active) {
        recordBuyOut(this.ledger, playerId, stack);
      }
    }
    this.pendingLeaves.clear();
  }

  /** Apply bot actions while the action seat belongs to a bot (instant practice play). */
  private async runBotTurns(): Promise<void> {
    if (!this.game || this.closed || this.game.paused) return;
    let guard = 0;
    while (guard++ < 48) {
      if (!this.game || this.game.street === "waiting" || this.game.actionSeat === null) break;
      const seat = this.game.seats[this.game.actionSeat];
      if (!seat?.playerId || !isBotUserId(seat.playerId) || seat.status !== "active") break;

      const legal = getLegalActions(this.game, seat.seatIndex);
      if (!legal) break;
      const decision = chooseBotAction(legal);
      const idem = `bot:${this.game.handNumber}:${this.game.sequence}:${seat.seatIndex}`;
      if (this.actionIdempotency.has(idem)) break;
      const result = applyAction(
        this.game,
        seat.seatIndex,
        decision.action,
        decision.amount,
        Date.now(),
        idem,
      );
      if (!result.ok) break;
      this.actionIdempotency.set(idem, "ok");
      await this.afterSuccessfulAction(result.events);
    }
  }

  private async afterSuccessfulAction(
    events: Array<{ type: string }>,
    reason?: string,
  ): Promise<void> {
    if (!this.game) return;
    // Flush deferred leaves after showdown so buy-out uses final stacks.
    this.flushLeavesIfWaiting();
    this.persist();
    await this.syncAlarms();
    for (const socket of this.ctx.getWebSockets()) this.sendProjection(socket);
    this.broadcast(
      reason
        ? { type: "events", events, reason }
        : { type: "events", events },
    );

    if (events.some((e) => e.type === "hand_complete") && this.roomId) {
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

  /** Drop live sockets for a user after kick / leave so they cannot keep watching. */
  private closeSocketsForUser(userId: string, reason = "Removed from table"): void {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as ClientAttachment | null;
      if (att?.userId !== userId) continue;
      try {
        ws.close(4000, reason);
      } catch {
        /* ignore */
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
          closed: this.closed,
        },
        chat: this.chat.slice(-50),
        pendingJoins: isHost ? this.pendingJoins : undefined,
        startRequests: isHost ? this.startRequestSummary() : undefined,
        askedToStart:
          !isHost && att?.userId
            ? this.startRequests.some((r) => r.userId === att.userId)
            : undefined,
        ledger: this.ledgerSnapshot(),
        spectators: [...this.spectators.entries()].map(([userId, displayName]) => ({
          userId,
          displayName,
        })),
      }),
    );
  }

  private async syncAlarms(): Promise<void> {
    if (!this.game || this.closed || this.game.paused || !this.game.turnDeadlineMs) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(this.game.turnDeadlineMs);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ensure-voice-meeting" && request.method === "POST") {
      // Serialize create-or-get so concurrent voice-token calls share one meeting.
      return this.ctx.blockConcurrencyWhile(async () => {
        if (this.realtimekitMeetingId) {
          return Response.json({ ok: true, meetingId: this.realtimekitMeetingId });
        }
        if (!this.roomId) {
          return Response.json({ ok: false, error: "Room not ready." }, { status: 400 });
        }

        const d1Row = await this.env.DB.prepare(
          `SELECT realtimekit_meeting_id FROM rooms WHERE id = ?`,
        )
          .bind(this.roomId)
          .first<{ realtimekit_meeting_id: string | null }>();
        if (d1Row?.realtimekit_meeting_id) {
          this.realtimekitMeetingId = d1Row.realtimekit_meeting_id;
          this.persistMeetingId();
          return Response.json({ ok: true, meetingId: this.realtimekitMeetingId });
        }

        const body = (await request.json().catch(() => ({}))) as { roomName?: string };
        const title = body.roomName ?? this.roomName ?? "Friends table";
        const created = await createRealtimeKitMeeting(this.env, title);
        if ("error" in created) {
          return Response.json({ ok: false, error: created.error });
        }

        // Conditional D1 write: only set when still null (race-safe across isolates).
        const now = Date.now();
        await this.env.DB.prepare(
          `UPDATE rooms SET realtimekit_meeting_id = ?, updated_at = ?
           WHERE id = ? AND realtimekit_meeting_id IS NULL`,
        )
          .bind(created.meetingId, now, this.roomId)
          .run();

        const after = await this.env.DB.prepare(
          `SELECT realtimekit_meeting_id FROM rooms WHERE id = ?`,
        )
          .bind(this.roomId)
          .first<{ realtimekit_meeting_id: string | null }>();
        const meetingId = after?.realtimekit_meeting_id ?? created.meetingId;
        this.realtimekitMeetingId = meetingId;
        this.persistMeetingId();
        return Response.json({ ok: true, meetingId });
      });
    }

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
      this.closed = false;
      this.game = createInitialGameState(body.config);
      seatPlayer(this.game, body.hostUserId, body.hostDisplayName, 0);
      recordBuyIn(
        this.ledger,
        body.hostUserId,
        body.hostDisplayName,
        this.game.config.startingStack,
      );
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
        timeBankSeconds?: number;
      };
      const pending = {
        ...(body.smallBlind !== undefined ? { smallBlind: body.smallBlind } : {}),
        ...(body.startingStack !== undefined ? { startingStack: body.startingStack } : {}),
        ...(body.potCapMultiplier !== undefined
          ? { potCapMultiplier: body.potCapMultiplier }
          : {}),
        ...(body.timeBankSeconds !== undefined
          ? { timeBankSeconds: body.timeBankSeconds }
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
          ...(pending.timeBankSeconds !== undefined
            ? { timeBankSeconds: pending.timeBankSeconds }
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
      if (this.closed) return Response.json({ ok: false, error: "This table is closed." });
      const body = (await request.json()) as {
        userId: string;
        displayName: string;
        seatIndex?: number | null;
        asSpectator?: boolean;
        requestId: string;
      };
      this.pendingJoins = this.pendingJoins.filter(
        (j) => j.requestId !== body.requestId && j.userId !== body.userId,
      );

      if (body.asSpectator || body.seatIndex === null) {
        this.spectators.set(body.userId, body.displayName);
        this.persist();
        this.broadcast({
          type: "spectator_joined",
          userId: body.userId,
          displayName: body.displayName,
        });
        for (const ws of this.ctx.getWebSockets()) this.sendProjection(ws);
        return Response.json({ ok: true, spectator: true });
      }

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
      this.pendingJoins = this.pendingJoins.filter(
        (j) => j.requestId !== body.requestId && j.userId !== body.userId,
      );
      this.spectators.delete(body.userId);
      recordBuyIn(
        this.ledger,
        body.userId,
        body.displayName,
        this.game.config.startingStack,
      );
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

    if (url.pathname === "/seat-spectator" && request.method === "POST") {
      if (!this.game) return Response.json({ ok: false, error: "Room not ready." });
      const body = (await request.json()) as {
        userId: string;
        displayName: string;
        seatIndex?: number;
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
      this.spectators.delete(body.userId);
      recordBuyIn(
        this.ledger,
        body.userId,
        body.displayName,
        this.game.config.startingStack,
      );
      this.persist();
      for (const ws of this.ctx.getWebSockets()) this.sendProjection(ws);
      return Response.json({ ok: true, seatIndex });
    }

    if (url.pathname === "/seat-bot" && request.method === "POST") {
      if (!this.game) return Response.json({ ok: false, error: "Room not ready." });
      if (this.closed) return Response.json({ ok: false, error: "This table is closed." });
      const body = (await request.json()) as {
        botUserId: string;
        displayName?: string;
        seatIndex?: number;
      };
      if (!isBotUserId(body.botUserId)) {
        return Response.json({ ok: false, error: "Invalid bot id." });
      }
      let seatIndex = body.seatIndex;
      if (seatIndex === undefined) {
        seatIndex = this.game.seats.findIndex((s) => !s.playerId);
      } else if (this.game.seats[seatIndex]?.playerId) {
        return Response.json({ ok: false, error: "That seat is taken." });
      }
      if (seatIndex === undefined || seatIndex < 0) {
        return Response.json({ ok: false, error: "This table is full." });
      }
      const displayName =
        body.displayName?.trim() ||
        nextBotDisplayName(this.game.seats.map((s) => s.displayName));
      const result = seatPlayer(this.game, body.botUserId, displayName, seatIndex);
      if (!result.ok) return Response.json(result);
      recordBuyIn(
        this.ledger,
        body.botUserId,
        displayName,
        this.game.config.startingStack,
      );
      this.persist();
      this.broadcast({
        type: "player_seated",
        userId: body.botUserId,
        displayName,
        seatIndex,
        bot: true,
        message: `${displayName} joined an open seat.`,
      });
      writeAnalytics(this.env, "bot_seated", this.roomId ?? "unknown", [seatIndex], [
        body.botUserId.slice(0, 8),
      ]);
      for (const ws of this.ctx.getWebSockets()) this.sendProjection(ws);
      return Response.json({ ok: true, seatIndex, displayName, botUserId: body.botUserId });
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
      this.spectators.delete(body.userId);
      const seated = this.game.seats.find((s) => s.playerId === body.userId);
      if (!seated) {
        this.persist();
        this.broadcast({ type: "player_left", userId: body.userId });
        this.closeSocketsForUser(body.userId, "Left table");
        for (const ws of this.ctx.getWebSockets()) this.sendProjection(ws);
        return Response.json({ ok: true });
      }
      const stackAtLeave = seated.stack;
      const result = unseatPlayer(this.game, body.userId, Date.now());
      if (!result.ok) return Response.json(result);
      if (!result.deferred) {
        recordBuyOut(this.ledger, body.userId, stackAtLeave);
      }
      this.startRequests = this.startRequests.filter((r) => r.userId !== body.userId);
      if (result.deferred) this.pendingLeaves.add(body.userId);
      else this.pendingLeaves.delete(body.userId);
      this.flushLeavesIfWaiting();
      this.persist();
      this.broadcast({ type: "player_left", userId: body.userId });
      writeAnalytics(this.env, "player_left", this.roomId ?? "unknown");
      this.closeSocketsForUser(body.userId, "Left table");
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
      this.spectators.delete(body.targetUserId);
      const seated = this.game.seats.find((s) => s.playerId === body.targetUserId);
      const stackAtLeave = seated?.stack ?? 0;
      if (!seated) {
        this.persist();
        this.broadcast({ type: "player_kicked", userId: body.targetUserId });
        this.closeSocketsForUser(body.targetUserId, "Kicked from table");
        for (const ws of this.ctx.getWebSockets()) this.sendProjection(ws);
        return Response.json({ ok: true });
      }
      const result = unseatPlayer(this.game, body.targetUserId, Date.now());
      if (!result.ok) return Response.json(result);
      if (!result.deferred) recordBuyOut(this.ledger, body.targetUserId, stackAtLeave);
      this.startRequests = this.startRequests.filter((r) => r.userId !== body.targetUserId);
      if (result.deferred) this.pendingLeaves.add(body.targetUserId);
      else this.pendingLeaves.delete(body.targetUserId);
      this.flushLeavesIfWaiting();
      this.persist();
      this.broadcast({ type: "player_kicked", userId: body.targetUserId });
      writeAnalytics(this.env, "player_kicked", this.roomId ?? "unknown");
      this.closeSocketsForUser(body.targetUserId, "Kicked from table");
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
      const seat = this.game.seats.find((s) => s.playerId === body.targetUserId);
      const result = rebuyPlayer(this.game, body.targetUserId, body.chips);
      if (!result.ok) return Response.json(result);
      const amount = body.chips ?? this.game.config.startingStack;
      recordBuyIn(
        this.ledger,
        body.targetUserId,
        seat?.displayName ?? "Player",
        amount,
      );
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

    if (url.pathname === "/pause" && request.method === "POST") {
      if (!this.game) return Response.json({ ok: false, error: "Room not ready." });
      const body = (await request.json()) as { hostUserId: string; paused: boolean };
      if (body.hostUserId !== this.hostUserId) {
        return Response.json({ ok: false, error: "Only the host can pause." });
      }
      const result = setPaused(this.game, body.paused, Date.now());
      if (!result.ok) return Response.json(result);
      this.persist();
      await this.syncAlarms();
      this.broadcast({ type: "events", events: result.events });
      for (const ws of this.ctx.getWebSockets()) this.sendProjection(ws);
      return Response.json({ ok: true, paused: this.game.paused });
    }

    if (url.pathname === "/transfer-host" && request.method === "POST") {
      if (!this.game) return Response.json({ ok: false, error: "Room not ready." });
      const body = (await request.json()) as {
        hostUserId: string;
        targetUserId: string;
        targetDisplayName: string;
      };
      if (body.hostUserId !== this.hostUserId) {
        return Response.json({ ok: false, error: "Only the host can transfer." });
      }
      if (body.targetUserId === this.hostUserId) {
        return Response.json({ ok: false, error: "Already the host." });
      }
      const seatedOrSpec =
        this.game.seats.some((s) => s.playerId === body.targetUserId) ||
        this.spectators.has(body.targetUserId);
      if (!seatedOrSpec) {
        return Response.json({ ok: false, error: "Target must be at this table." });
      }
      this.hostUserId = body.targetUserId;
      this.persist();
      this.broadcast({
        type: "host_transferred",
        hostUserId: body.targetUserId,
        displayName: body.targetDisplayName,
      });
      for (const ws of this.ctx.getWebSockets()) this.sendProjection(ws);
      return Response.json({ ok: true, hostUserId: this.hostUserId });
    }

    if (url.pathname === "/close" && request.method === "POST") {
      if (!this.game) return Response.json({ ok: false, error: "Room not ready." });
      const body = (await request.json()) as { hostUserId: string };
      if (body.hostUserId !== this.hostUserId) {
        return Response.json({ ok: false, error: "Only the host can close the table." });
      }
      // Conservative policy: refuse close while a hand is in progress.
      if (this.game.street !== "waiting") {
        return Response.json(
          {
            ok: false,
            error: "Finish the current hand before closing the table.",
            code: "hand_in_progress",
          },
          { status: 409 },
        );
      }
      // Cash out seated stacks into ledger.
      for (const seat of this.game.seats) {
        if (seat.playerId) {
          recordBuyOut(this.ledger, seat.playerId, seat.stack);
          unseatPlayer(this.game, seat.playerId, Date.now());
        }
      }
      this.spectators.clear();
      this.pendingJoins = [];
      this.startRequests = [];
      this.pendingLeaves.clear();
      this.closed = true;
      this.game.paused = true;
      this.game.turnDeadlineMs = null;
      this.persist();
      await this.ctx.storage.deleteAlarm();
      this.broadcast({ type: "table_closed", message: "The host closed this table." });
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(1000, "Table closed");
        } catch {
          /* ignore */
        }
      }
      return Response.json({ ok: true });
    }

    if (url.pathname === "/ledger" && request.method === "GET") {
      if (!this.game) return Response.json({ ok: false, error: "Room not ready." });
      const snap = this.ledgerSnapshot();
      const format = url.searchParams.get("format");
      if (format === "csv") {
        return new Response(ledgerToCsv(snap), {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="ledger-${this.roomId ?? "table"}.csv"`,
          },
        });
      }
      return Response.json({ ok: true, ledger: snap });
    }

    if (url.pathname === "/open-seats" && request.method === "GET") {
      if (!this.game) return Response.json({ ok: false, error: "Room not ready." });
      const open = this.game.seats
        .filter((s) => !s.playerId)
        .map((s) => s.seatIndex);
      return Response.json({ ok: true, openSeats: open });
    }

    if (url.pathname === "/ws") {
      if (this.closed) return new Response("Table closed", { status: 410 });
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
      // Track as spectator if not seated.
      if (this.game && !this.game.seats.some((s) => s.playerId === userId)) {
        this.spectators.set(userId, displayName);
      }
      this.sendProjection(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (!this.game || this.closed) return;
    const att = ws.deserializeAttachment() as ClientAttachment;
    let data: {
      type: string;
      action?: ActionType;
      amount?: number;
      text?: string;
      expectedVersion?: number;
      idempotencyKey?: string;
      paused?: boolean;
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

    if (data.type === "pause") {
      if (att.userId !== this.hostUserId) {
        ws.send(JSON.stringify({ type: "error", error: "Only the host can pause." }));
        return;
      }
      const result = setPaused(this.game, Boolean(data.paused), Date.now());
      if (!result.ok) {
        ws.send(JSON.stringify({ type: "error", error: result.error }));
        return;
      }
      this.persist();
      await this.syncAlarms();
      this.broadcast({ type: "events", events: result.events });
      for (const socket of this.ctx.getWebSockets()) this.sendProjection(socket);
      return;
    }

    if (data.type === "rabbit") {
      const result = rabbitHunt(this.game);
      if (!result.ok) {
        ws.send(JSON.stringify({ type: "error", error: result.error }));
        return;
      }
      this.persist();
      this.broadcast({ type: "events", events: result.events });
      for (const socket of this.ctx.getWebSockets()) this.sendProjection(socket);
      return;
    }

    if (data.type === "request_start") {
      if (att.userId === this.hostUserId) {
        ws.send(JSON.stringify({ type: "error", error: "You can deal whenever you are ready." }));
        return;
      }
      if (this.game.paused) {
        ws.send(JSON.stringify({ type: "error", error: "The table is paused." }));
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
      if (!this.game || this.game.street !== "waiting") {
        ws.send(JSON.stringify({ type: "error", error: "Finish the current hand before dealing again." }));
        this.sendProjection(ws);
        return;
      }
      if (this.game.paused) {
        ws.send(JSON.stringify({ type: "error", error: "Resume the table before dealing." }));
        return;
      }
      this.startRequests = [];
      const events = startHand(this.game, Date.now());
      this.persist();
      await this.syncAlarms();
      writeAnalytics(this.env, "hand_started", this.roomId ?? "unknown", [this.game.handNumber]);
      for (const socket of this.ctx.getWebSockets()) this.sendProjection(socket);
      this.broadcast({ type: "events", events });
      await this.runBotTurns();
      return;
    }

    if (data.type === "action" && data.action) {
      if (this.game.paused) {
        ws.send(JSON.stringify({ type: "error", error: "The table is paused." }));
        return;
      }
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
      await this.afterSuccessfulAction(result.events);
      await this.runBotTurns();
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    void ws;
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    void ws;
  }

  async alarm(): Promise<void> {
    if (!this.game || this.closed || this.game.paused || this.game.actionSeat === null) return;
    const seat = this.game.seats[this.game.actionSeat];
    if (!seat || seat.status !== "active") return;

    const bankOrTimeout = onTurnTimerExpired(this.game, Date.now());
    if (bankOrTimeout.kind === "noop") return;
    if (bankOrTimeout.kind === "bank") {
      this.persist();
      await this.syncAlarms();
      for (const socket of this.ctx.getWebSockets()) this.sendProjection(socket);
      this.broadcast({ type: "events", events: bankOrTimeout.events, reason: "time_bank" });
      return;
    }

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
    await this.afterSuccessfulAction(result.events, "timeout");
    await this.runBotTurns();
  }
}
