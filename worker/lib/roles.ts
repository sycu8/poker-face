export const USER_ROLE_USER = "user";
export const USER_ROLE_SUPER_ADMIN = "super_admin";

export type UserRole = typeof USER_ROLE_USER | typeof USER_ROLE_SUPER_ADMIN;

export function isSuperAdmin(role: string | null | undefined): boolean {
  return role === USER_ROLE_SUPER_ADMIN;
}
