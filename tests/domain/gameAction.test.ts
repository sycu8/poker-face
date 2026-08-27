import { describe, expect, it } from "vitest";
import { buildGameAction } from "../../src/features/table/gameAction";

describe("buildGameAction", () => {
  it("returns null when sequence is undefined", () => {
    expect(buildGameAction(undefined, "fold")).toBeNull();
  });

  it("returns null when sequence is negative or non-integer", () => {
    expect(buildGameAction(-1, "fold")).toBeNull();
    expect(buildGameAction(1.5, "fold")).toBeNull();
  });

  it("builds a valid action payload with expectedVersion", () => {
    const payload = buildGameAction(7, "raise", 120);
    expect(payload).toMatchObject({
      type: "action",
      action: "raise",
      amount: 120,
      expectedVersion: 7,
    });
    expect(payload?.idempotencyKey.length).toBeGreaterThanOrEqual(8);
  });
});
