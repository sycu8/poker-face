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
        copy: { tagline: string; support: string; chips: string };
      }>(r),
    ),
  me: () =>
    fetch("/api/auth/me", { credentials: "include" }).then(async (r) => {
      if (r.status === 401) return { user: null as User | null };
      return parse<{ user: User }>(r);
    }),
  register: (body: { username: string; password: string; displayName?: string }) =>
    fetch("/api/auth/register", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => parse<{ user: User }>(r)),
  login: (body: { username: string; password: string }) =>
    fetch("/api/auth/login", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => parse<{ user: User }>(r)),
  logout: () =>
    fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
    }).then((r) => parse<{ ok: boolean }>(r)),
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
    }).then((r) => parse<{ status: string; message?: string }>(r)),
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
    }).then((r) =>
      parse<{ available: boolean; token?: string; message?: string }>(r),
    ),
};
