export function isBotUserId(userId: string | null | undefined): boolean {
  return Boolean(userId && userId.startsWith("bot_"));
}
