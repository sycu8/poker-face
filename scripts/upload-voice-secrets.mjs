#!/usr/bin/env node
/**
 * Upload RealtimeKit (+ optional TURN) Worker secrets for staging or production.
 * Reads values from the environment only — never logs secret values.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
 *   REALTIMEKIT_APP_ID=… REALTIMEKIT_API_TOKEN=… \
 *   node scripts/upload-voice-secrets.mjs staging|production
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";

const envName = process.argv[2];
if (envName !== "staging" && envName !== "production") {
  console.error("Usage: node scripts/upload-voice-secrets.mjs staging|production");
  process.exit(1);
}

if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
  console.error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required in the environment.");
  process.exit(1);
}

const keys = [
  "REALTIMEKIT_APP_ID",
  "REALTIMEKIT_API_TOKEN",
  "REALTIMEKIT_PRESET_NAME",
  "CLOUDFLARE_ACCOUNT_ID",
  "TURN_KEY_ID",
  "TURN_KEY_API_TOKEN",
];

/** @type {Record<string, string>} */
const payload = {};
for (const key of keys) {
  const value = process.env[key];
  if (value) payload[key] = value;
}

if (!payload.REALTIMEKIT_APP_ID || !payload.REALTIMEKIT_API_TOKEN) {
  console.error(
    "REALTIMEKIT_APP_ID and REALTIMEKIT_API_TOKEN are required. " +
      "REALTIMEKIT_API_TOKEN must be a Cloudflare API token with Realtime Admin " +
      "(the Calls TURN key API token will not work here).",
  );
  process.exit(1);
}

const out = path.resolve(`.voice-secrets-${envName}.json`);
writeFileSync(out, JSON.stringify(payload, null, 2));
console.log(
  `Uploading ${Object.keys(payload).length} secret keys to Worker env=${envName} (values redacted).`,
);

const result = spawnSync(
  "npx",
  ["wrangler", "secret", "bulk", out, "--env", envName, "--config", "wrangler.jsonc"],
  { stdio: "inherit", env: process.env },
);

try {
  unlinkSync(out);
} catch {
  /* ignore */
}

process.exit(result.status ?? 1);
