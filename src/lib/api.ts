export type User = { id: string; displayName: string; username?: string | null };

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      res.ok
        ? "Server returned a non-JSON response."
        : `Request failed (${res.status}). Try refreshing the page.`,
    );
  }
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export type RoomAccess =
  | {
      access: "member";
      room: {
        id: string;
        name: string;
        inviteCode: string;
        hostUserId: string;
        smallBlind: number;
        bigBlind: number;
        startingStack: number;
        potCapMultiplier: number;
        status: string;
      };
      member: { role: string; seat_index: number | null; display_name: string; status: string };
    }
  | {
      access: "pending";
      room: {
        id: string;
        name: string;
        inviteCode: string;
        hostUserId: string;
        smallBlind: number;
        bigBlind: number;
      };
      requestId: string;
      message: string;
    }
  | {
      access: "rejected";
      room: { id: string; name: string };
      message: string;
    };

export const api = {
  config: () =>
    fetch("/api/config").then((r) =>
      parse<{
        turnstileSiteKey: string;
        environment?: string;
        appOrigin?: string;
        flags?: {
          handHistoryEnabled: boolean;
          themesEnabled: boolean;
          passkeysEnabled: boolean;
        };
        copy: { tagline: string; support: string; chips: string };
      }>(r),
    ),
  me: () =>
    fetch("/api/auth/me", { credentials: "include" }).then(async (r) => {
      if (r.status === 401) return { user: null as User | null };
      return parse<{ user: User }>(r);
    }),
  register: (body: {
    username: string;
    email: string;
    password: string;
    displayName?: string;
    turnstileToken?: string;
  }) =>
    fetch("/api/auth/register", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => parse<{ user: User }>(r)),
  login: (body: { username: string; password: string; turnstileToken?: string }) =>
    fetch("/api/auth/login", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => parse<{ user: User }>(r)),
  resetPassword: (body: {
    username: string;
    email: string;
    newPassword: string;
    turnstileToken?: string;
  }) =>
    fetch("/api/auth/reset-password", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => parse<{ ok: boolean; message?: string }>(r)),
  logout: () =>
    fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
    }).then((r) => parse<{ ok: boolean }>(r)),
  myRooms: () =>
    fetch("/api/rooms/mine", { credentials: "include" }).then((r) =>
      parse<{ rooms: MyRoom[] }>(r),
    ),
  createRoom: (body: {
    name: string;
    smallBlind: number;
    startingStack: number;
  }) =>
    fetch("/api/rooms", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) =>
      parse<{
        room: { id: string; inviteCode: string; name: string; config: unknown };
      }>(r),
    ),
  getRoom: (roomId: string) =>
    fetch(`/api/rooms/${roomId}`, { credentials: "include" }).then((r) => parse<RoomAccess>(r)),
  joinRequest: (body: {
    inviteCode: string;
    idempotencyKey: string;
    displayName?: string;
    turnstileToken?: string;
  }) =>
    fetch("/api/rooms/join-request", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) =>
      parse<{ status: string; roomId?: string; requestId?: string; message?: string }>(r),
    ),
  decideJoin: (body: {
    requestId: string;
    approve: boolean;
    seatIndex?: number;
    idempotencyKey: string;
  }) =>
    fetch("/api/rooms/join-decision", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => parse<{ status: string; message?: string; seatIndex?: number }>(r)),
  openSeats: (roomId: string) =>
    fetch(`/api/rooms/${roomId}/open-seats`, { credentials: "include" }).then((r) =>
      parse<{ openSeats: number[] }>(r),
    ),
  leaveRoom: (roomId: string) =>
    fetch(`/api/rooms/${roomId}/leave`, {
      method: "POST",
      credentials: "include",
    }).then((r) => parse<{ status: string; message?: string }>(r)),
  kickPlayer: (roomId: string, targetUserId: string) =>
    fetch(`/api/rooms/${roomId}/kick`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetUserId }),
    }).then((r) => parse<{ status: string; message?: string }>(r)),
  rebuy: (roomId: string, body: { targetUserId?: string; chips?: number } = {}) =>
    fetch(`/api/rooms/${roomId}/rebuy`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => parse<{ status: string; message?: string }>(r)),
  setAway: (roomId: string, away: boolean) =>
    fetch(`/api/rooms/${roomId}/away`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ away }),
    }).then((r) => parse<{ status: string; message?: string }>(r)),
  listHands: (roomId: string) =>
    fetch(`/api/rooms/${roomId}/hands`, { credentials: "include" }).then((r) =>
      parse<{ hands: HandSummaryListItem[] }>(r),
    ),
  getHand: (roomId: string, handNumber: number) =>
    fetch(`/api/rooms/${roomId}/hands/${handNumber}`, { credentials: "include" }).then((r) =>
      parse<{
        roomId: string;
        handNumber: number;
        createdAt: number | null;
        summary: unknown;
        source: string;
      }>(r),
    ),
  updateRoomConfig: (
    roomId: string,
    body: { smallBlind?: number; startingStack?: number; potCapMultiplier?: number },
  ) =>
    fetch(`/api/rooms/${roomId}/config`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) =>
      parse<{ status: string; pending?: boolean; message?: string; config?: unknown }>(r),
    ),
  voiceToken: (roomId: string) =>
    fetch(`/api/rooms/${roomId}/voice-token`, {
      method: "POST",
      credentials: "include",
    }).then((r) => parse<VoiceTokenResponse>(r)),
};

export type MyRoom = {
  id: string;
  name: string;
  inviteCode: string;
  hostUserId: string;
  isHost: boolean;
  status: string;
  smallBlind: number;
  bigBlind: number;
  startingStack: number;
  role: string;
  seatIndex: number | null;
  memberStatus: string;
  updatedAt: number;
};

export type HandSummaryListItem = {
  id: string;
  handNumber: number;
  createdAt: number;
  summary: unknown;
};

export type VoiceTokenResponse = {
  available: boolean;
  token?: string;
  meetingId?: string;
  reason?:
    | "not_configured"
    | "meeting_create_failed"
    | "participant_failed"
    | "exception"
    | string;
  message?: string;
};
