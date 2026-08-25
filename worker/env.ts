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
  TURNSTILE_SITE_KEY: string;
  SESSION_SECRET: string;
  TURNSTILE_SECRET_KEY?: string;
  REALTIMEKIT_APP_ID?: string;
  REALTIMEKIT_API_TOKEN?: string;
  REALTIMEKIT_PRESET_NAME?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
}
