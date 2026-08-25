import { describe, expect, it } from "vitest";
import {
  buildLedgerSnapshot,
  emptyLedger,
  ledgerToCsv,
  recordBuyIn,
  recordBuyOut,
} from "../../worker/domain/ledger";

describe("session ledger", () => {
  it("tracks buy-in, buy-out, stack, and net", () => {
    const ledger = emptyLedger();
    recordBuyIn(ledger, "a", "Ada", 100);
    recordBuyIn(ledger, "b", "Bea", 100);
    recordBuyIn(ledger, "a", "Ada", 50); // rebuy
    const stacks = new Map([
      ["a", 120],
      ["b", 80],
    ]);
    const snap = buildLedgerSnapshot(ledger, stacks);
    const ada = snap.players.find((p) => p.userId === "a")!;
    expect(ada.buyIn).toBe(150);
    expect(ada.currentStack).toBe(120);
    expect(ada.net).toBe(-30);
    expect(snap.totals.buyIn).toBe(250);
  });

  it("zeros current stack after buy-out", () => {
    const ledger = emptyLedger();
    recordBuyIn(ledger, "a", "Ada", 100);
    recordBuyOut(ledger, "a", 40);
    const snap = buildLedgerSnapshot(ledger, new Map([["a", 40]]));
    const ada = snap.players[0]!;
    expect(ada.active).toBe(false);
    expect(ada.currentStack).toBe(0);
    expect(ada.buyOut).toBe(40);
    expect(ada.net).toBe(-60);
  });

  it("exports CSV with totals row", () => {
    const ledger = emptyLedger();
    recordBuyIn(ledger, "a", "Ada", 100);
    const csv = ledgerToCsv(buildLedgerSnapshot(ledger, new Map([["a", 100]])));
    expect(csv).toContain("displayName,userId,buyIn");
    expect(csv).toContain("TOTALS");
    expect(csv.split("\n").length).toBeGreaterThanOrEqual(3);
  });
});
