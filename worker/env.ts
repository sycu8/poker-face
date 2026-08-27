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
