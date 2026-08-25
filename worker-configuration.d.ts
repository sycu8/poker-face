// Minimal binding types for local typecheck before `wrangler types`.
interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface AnalyticsEngineDataset {
  writeDataPoint(event: {
    blobs?: string[];
    doubles?: number[];
    indexes?: string[];
  }): void;
}
