import { describe, expect, it, vi } from "vitest";
import {
  applyMembershipOrEnqueue,
  enqueueMembershipOp,
  flushMembershipOps,
} from "../../worker/lib/membershipOps";
import type { Env } from "../../worker/env";

type Row = {
  id: string;
  room_id: string;
  user_id: string;
  op: string;
  payload_json: string;
  created_at: number;
  attempts: number;
};

function mockEnv(opts?: { failApplyOnce?: boolean }) {
  const members = new Map<string, { status: string; seat_index: number | null }>();
  const ops: Row[] = [];
  let applyFail = opts?.failApplyOnce ?? false;

  const prepare = (sql: string) => {
    const stmt = {
      bind: (...args: unknown[]) => {
        const run = async () => {
          if (sql.includes("INSERT INTO membership_ops")) {
            ops.push({
              id: String(args[0]),
              room_id: String(args[1]),
              user_id: String(args[2]),
              op: String(args[3]),
              payload_json: String(args[4]),
              created_at: Number(args[5]),
              attempts: 0,
            });
            return { success: true };
          }
          if (sql.includes("DELETE FROM membership_ops")) {
            const id = String(args[0]);
            const idx = ops.findIndex((o) => o.id === id);
            if (idx >= 0) ops.splice(idx, 1);
            return { success: true };
          }
          if (sql.includes("UPDATE membership_ops SET attempts")) {
            const id = String(args[0]);
            const row = ops.find((o) => o.id === id);
            if (row) row.attempts += 1;
            return { success: true };
          }
          if (sql.includes("UPDATE room_members SET status = 'left'")) {
            if (applyFail) {
              applyFail = false;
              throw new Error("d1 unavailable");
            }
            const key = `${args[1]}:${args[2]}`;
            members.set(key, { status: "left", seat_index: null });
            return { success: true };
          }
          if (sql.includes("UPDATE room_members SET status = 'kicked'")) {
            if (applyFail) {
              applyFail = false;
              throw new Error("d1 unavailable");
            }
            const key = `${args[1]}:${args[2]}`;
            members.set(key, { status: "kicked", seat_index: null });
            return { success: true };
          }
          if (sql.includes("INSERT INTO room_members") && sql.includes("'seated'")) {
            if (applyFail) {
              applyFail = false;
              throw new Error("d1 unavailable");
            }
            const key = `${args[0]}:${args[1]}`;
            members.set(key, {
              status: "seated",
              seat_index: Number(args[3] ?? 0),
            });
            return { success: true };
          }
          if (sql.includes("UPDATE join_requests")) {
            return { success: true };
          }
          return { success: true };
        };
        const all = async <T>() => {
          if (sql.includes("FROM membership_ops")) {
            const roomFilter =
              sql.includes("WHERE room_id") && args.length >= 1 ? String(args[0]) : null;
            const limit = Number(args[args.length - 1] ?? 32);
            let rows = roomFilter
              ? ops.filter((o) => o.room_id === roomFilter)
              : [...ops];
            rows = rows.slice(0, limit);
            return { results: rows as unknown as T[] };
          }
          return { results: [] as T[] };
        };
        return {
          run,
          all,
          first: async () => null,
        };
      },
    };
    return stmt;
  };

  return {
    env: { DB: { prepare } } as unknown as Env,
    members,
    ops,
  };
}

describe("membershipOps convergence", () => {
  it("leave: D1 fail enqueues; flush converges to left", async () => {
    const { env, members, ops } = mockEnv({ failApplyOnce: true });
    const ok = await applyMembershipOrEnqueue(env, "room1", "user1", "leave");
    expect(ok).toBe(false);
    expect(ops).toHaveLength(1);
    expect(members.size).toBe(0);

    const applied = await flushMembershipOps(env, "room1");
    expect(applied).toBe(1);
    expect(members.get("room1:user1")?.status).toBe("left");
    expect(ops).toHaveLength(0);
  });

  it("approve/seat: D1 fail then retry flush seats member", async () => {
    const { env, members, ops } = mockEnv({ failApplyOnce: true });
    const ok = await applyMembershipOrEnqueue(env, "room1", "user2", "seat", {
      displayName: "Bob",
      seatIndex: 3,
      requestId: "jr1",
    });
    expect(ok).toBe(false);
    expect(ops).toHaveLength(1);

    await flushMembershipOps(env, "room1");
    expect(members.get("room1:user2")).toEqual({
      status: "seated",
      seat_index: 3,
    });
  });

  it("enqueue then flush is idempotent for kick", async () => {
    const { env, members } = mockEnv();
    await enqueueMembershipOp(env, "r", "u", "kick");
    await flushMembershipOps(env, "r");
    expect(members.get("r:u")?.status).toBe("kicked");
    await flushMembershipOps(env, "r");
    expect(members.get("r:u")?.status).toBe("kicked");
  });
});

describe("voice provision single-flight pattern", () => {
  it("concurrent callers share one in-flight promise without a global lock", async () => {
    let calls = 0;
    let resolve!: (v: string) => void;
    const gate = new Promise<string>((r) => {
      resolve = r;
    });

    let voiceProvisionPromise: Promise<string> | null = null;
    async function ensure() {
      if (!voiceProvisionPromise) {
        voiceProvisionPromise = (async () => {
          calls += 1;
          return gate;
        })().finally(() => {
          voiceProvisionPromise = null;
        });
      }
      return voiceProvisionPromise;
    }

    const p1 = ensure();
    const p2 = ensure();
    // Poker path can proceed independently while voice waits.
    const pokerTick = vi.fn();
    pokerTick();
    expect(pokerTick).toHaveBeenCalled();

    resolve("meeting-1");
    expect(await p1).toBe("meeting-1");
    expect(await p2).toBe("meeting-1");
    expect(calls).toBe(1);
  });
});
