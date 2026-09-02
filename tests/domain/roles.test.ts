import { describe, expect, it } from "vitest";
import {
  isSuperAdmin,
  USER_ROLE_SUPER_ADMIN,
  USER_ROLE_USER,
} from "../../worker/lib/roles";

describe("roles", () => {
  it("recognizes super admin role", () => {
    expect(isSuperAdmin(USER_ROLE_SUPER_ADMIN)).toBe(true);
    expect(isSuperAdmin(USER_ROLE_USER)).toBe(false);
    expect(isSuperAdmin(null)).toBe(false);
    expect(isSuperAdmin(undefined)).toBe(false);
  });
});
