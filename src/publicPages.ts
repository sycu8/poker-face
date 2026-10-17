export const PUBLIC_PAGE_PATHS = [
  "/",
  "/auth",
  "/auth?mode=register",
  "/auth?mode=guest",
] as const;

export function publicPageOrNull(
  path: string,
): (typeof PUBLIC_PAGE_PATHS)[number] | null {
  return (PUBLIC_PAGE_PATHS as readonly string[]).includes(path)
    ? (path as (typeof PUBLIC_PAGE_PATHS)[number])
    : null;
}
