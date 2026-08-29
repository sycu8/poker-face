export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  ROOM: DurableObjectNamespace;
  CONFIG_KV: KVNamespace;
  REPLAY_R2: R2Bucket;
  ARCHIVE_QUEUE: Queue;
  ANALYTICS: AnalyticsEngineDataset;
  AUTH_RATE_LIMIT: RateLimit;
  JOIN_RATE_LIMIT: RateLimit;
  ENVIRONMENT: string;
  APP_ORIGIN: string;
  SESSION_SECRET: string;
  /** Public Turnstile site key (safe in vars). */
  TURNSTILE_SITE_KEY?: string;
  /** Turnstile widget secret (Worker secret / .dev.vars). */
  TURNSTILE_SECRET?: string;
  /** Comma-separated frontend hostnames allowed by siteverify. */
  TURNSTILE_HOSTNAMES?: string;
  /** GitHub OAuth App client id (optional). Enabled only when secret is also set. */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Google OAuth client id (optional). Enabled only when secret is also set. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  REALTIMEKIT_APP_ID?: string;
  REALTIMEKIT_PRESET_NAME?: string;
  REALTIMEKIT_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  /** Optional Calls TURN key id (dashboard). Not required for RealtimeKit voice. */
  TURN_KEY_ID?: string;
  /** Optional Calls TURN key display name. */
  TURN_KEY_NAME?: string;
  TURN_KEY_API_TOKEN?: string;
}
