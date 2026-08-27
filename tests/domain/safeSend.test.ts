import { describe, expect, it, vi } from "vitest";
import { safeSend } from "../../worker/lib/safeSend";

describe("safeSend", () => {
  it("returns true when send succeeds", () => {
    const ws = { send: vi.fn() };
    expect(safeSend(ws, "hello")).toBe(true);
    expect(ws.send).toHaveBeenCalledWith("hello");
  });

  it("catches throw, closes socket, continues", () => {
    const close = vi.fn();
    const ws = {
      send: () => {
        throw new Error("broken");
      },
      close,
    };
    expect(safeSend(ws, "x")).toBe(false);
    expect(close).toHaveBeenCalledWith(1011, "send_failed");
  });

  it("one broken send does not prevent subsequent sends", () => {
    const results: boolean[] = [];
    const sockets = [
      {
        send: () => {
          throw new Error("dead");
        },
        close: vi.fn(),
      },
      { send: vi.fn(), close: vi.fn() },
      { send: vi.fn(), close: vi.fn() },
    ];
    for (const s of sockets) {
      results.push(safeSend(s, JSON.stringify({ type: "events" })));
    }
    expect(results).toEqual([false, true, true]);
    expect(sockets[1]!.send).toHaveBeenCalled();
    expect(sockets[2]!.send).toHaveBeenCalled();
  });
});
