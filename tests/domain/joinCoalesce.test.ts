import { describe, expect, it } from "vitest";
import { coalesceJoinRequest } from "../../worker/lib/joinCoalesce";

describe("join request coalescing", () => {
  it("returns existing pending instead of creating a duplicate", () => {
    const first = coalesceJoinRequest({
      memberStatus: null,
      pendingRequestId: null,
      newRequestId: "jr_a",
    });
    expect(first).toEqual({
      status: "pending",
      requestId: "jr_a",
      message: "Waiting for the host",
    });

    const retry = coalesceJoinRequest({
      memberStatus: null,
      pendingRequestId: "jr_a",
      newRequestId: "jr_b",
    });
    expect(retry.status).toBe("pending");
    if (retry.status === "pending") {
      expect(retry.requestId).toBe("jr_a");
    }
  });

  it("short-circuits when already seated", () => {
    const res = coalesceJoinRequest({
      memberStatus: "seated",
      pendingRequestId: "jr_stale",
      newRequestId: "jr_new",
    });
    expect(res).toEqual({ status: "approved", message: "You have a seat" });
  });
});
