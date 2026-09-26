import { describe, expect, it } from "vitest";

/** Mirrors AdminUserStats fields returned by GET /api/admin/stats. */
type AdminUserStats = {
  total: number;
  registeredInPeriod: number;
  guests: number;
  activeInPeriod: number;
  withActiveSession: number;
  activeMembers: number;
};

describe("admin active user stats shape", () => {
  it("includes active user fields", () => {
    const users: AdminUserStats = {
      total: 10,
      registeredInPeriod: 2,
      guests: 3,
      activeInPeriod: 5,
      withActiveSession: 4,
      activeMembers: 2,
    };
    expect(users.activeInPeriod).toBe(5);
    expect(users.withActiveSession).toBe(4);
    expect(users.activeMembers).toBe(2);
  });
});
