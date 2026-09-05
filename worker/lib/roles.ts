export const USER_ROLE_USER = "user";
export const USER_ROLE_SUPER_ADMIN = "super_admin";

export type UserRole = typeof USER_ROLE_USER | typeof USER_ROLE_SUPER_ADMIN;

/** Unknown DB values never elevate — treat as normal user. */
export function parseUserRole(role: string | null | undefined): UserRole {
  if (role === USER_ROLE_SUPER_ADMIN) return USER_ROLE_SUPER_ADMIN;
  return USER_ROLE_USER;
}

export function isSuperAdmin(role: string | null | undefined): boolean {
  return parseUserRole(role) === USER_ROLE_SUPER_ADMIN;
}
