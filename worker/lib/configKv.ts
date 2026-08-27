import type { Env } from "../env";

export type PublicCopy = {
  tagline: string;
  support: string;
  chips: string;
};

const DEFAULT_COPY: PublicCopy = {
  tagline: "Your table. Your people.",
  support: "Private poker nights, wherever everyone is.",
  chips: "Virtual chips only. No purchases or cash-out.",
};

/**
 * Non-authoritative flags/copy from CONFIG_KV.
 * Missing keys fall back to shipped defaults — never blocks the game.
 */
export async function readPublicConfig(env: Env): Promise<{
  turnstileSiteKey: string;
  environment: string;
  appOrigin: string;
  flags: {
    handHistoryEnabled: boolean;
    themesEnabled: boolean;
    passkeysEnabled: boolean;
  };
  copy: PublicCopy;
}> {
  const copy = { ...DEFAULT_COPY };
  let handHistoryEnabled = true;
  let themesEnabled = true;
  let passkeysEnabled = false;

  try {
    const [tagline, support, chips, hist, themes, passkeys] = await Promise.all([
      env.CONFIG_KV.get("copy:tagline"),
      env.CONFIG_KV.get("copy:support"),
      env.CONFIG_KV.get("copy:chips"),
      env.CONFIG_KV.get("flag:hand_history_enabled"),
      env.CONFIG_KV.get("flag:themes_enabled"),
      env.CONFIG_KV.get("flag:passkeys_enabled"),
    ]);
    if (tagline) copy.tagline = tagline;
    if (support) copy.support = support;
    if (chips) copy.chips = chips;
    if (hist === "0" || hist === "false") handHistoryEnabled = false;
    if (themes === "0" || themes === "false") themesEnabled = false;
    if (passkeys === "1" || passkeys === "true") passkeysEnabled = true;
  } catch {
    /* KV optional in some local setups */
  }

  return {
    turnstileSiteKey: env.TURNSTILE_SITE_KEY,
    environment: env.ENVIRONMENT,
    appOrigin: env.APP_ORIGIN,
    flags: { handHistoryEnabled, themesEnabled, passkeysEnabled },
    copy,
  };
}
