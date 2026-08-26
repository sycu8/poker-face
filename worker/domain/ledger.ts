/** Per-player session chip ledger (play-money). Poker Now–style totals. */

export interface LedgerPlayer {
  userId: string;
  displayName: string;
  /** Total chips bought in (seat + rebuys). */
  buyIn: number;
  /** Chips cashed out on leave/kick (stack at exit). */
  buyOut: number;
  /** Still seated at the table. */
  active: boolean;
}

export interface LedgerSnapshot {
  players: Array<
    LedgerPlayer & {
      /** Current stack while seated; 0 if left. */
      currentStack: number;
      /** buyOut + currentStack - buyIn */
      net: number;
    }
  >;
  totals: {
    buyIn: number;
    buyOut: number;
    currentStack: number;
    net: number;
  };
}

export function emptyLedger(): Record<string, LedgerPlayer> {
  return {};
}

export function recordBuyIn(
  ledger: Record<string, LedgerPlayer>,
  userId: string,
  displayName: string,
  chips: number,
): void {
  const row = ledger[userId];
  if (row) {
    row.buyIn += chips;
    row.displayName = displayName;
    row.active = true;
  } else {
    ledger[userId] = {
      userId,
      displayName,
      buyIn: chips,
      buyOut: 0,
      active: true,
    };
  }
}

export function recordBuyOut(
  ledger: Record<string, LedgerPlayer>,
  userId: string,
  chips: number,
): void {
  const row = ledger[userId];
  if (!row) return;
  row.buyOut += Math.max(0, chips);
  row.active = false;
}

export function buildLedgerSnapshot(
  ledger: Record<string, LedgerPlayer>,
  stacks: Map<string, number>,
): LedgerSnapshot {
  const players = Object.values(ledger).map((p) => {
    const currentStack = p.active ? (stacks.get(p.userId) ?? 0) : 0;
    return {
      ...p,
      currentStack,
      net: p.buyOut + currentStack - p.buyIn,
    };
  });
  players.sort((a, b) => a.displayName.localeCompare(b.displayName));
  const totals = players.reduce(
    (acc, p) => {
      acc.buyIn += p.buyIn;
      acc.buyOut += p.buyOut;
      acc.currentStack += p.currentStack;
      acc.net += p.net;
      return acc;
    },
    { buyIn: 0, buyOut: 0, currentStack: 0, net: 0 },
  );
  return { players, totals };
}

export function ledgerToCsv(snapshot: LedgerSnapshot): string {
  const lines = [
    "displayName,userId,buyIn,buyOut,currentStack,net,active",
    ...snapshot.players.map(
      (p) =>
        `${csvEscape(p.displayName)},${p.userId},${p.buyIn},${p.buyOut},${p.currentStack},${p.net},${p.active}`,
    ),
    `TOTALS,,${snapshot.totals.buyIn},${snapshot.totals.buyOut},${snapshot.totals.currentStack},${snapshot.totals.net},`,
  ];
  return lines.join("\n");
}

function csvEscape(value: string): string {
  // Neutralize spreadsheet formula injection (=, +, -, @, tab/CR).
  const safe =
    /^[=+\-@\t\r]/.test(value) || value.includes("\t") ? `'${value}` : value;
  if (/[",\n]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}
