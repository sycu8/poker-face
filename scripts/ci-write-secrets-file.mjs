#!/usr/bin/env node
/**
 * Write a temporary secrets file for `wrangler secret bulk` from CI env vars.
 * Never logs secret values.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

const out = process.argv[2] || ".ci-secrets.json";
const required = ["SESSION_SECRET"];
const optional = [
  "TURNSTILE_SECRET_KEY",
  "REALTIMEKIT_API_TOKEN",
  "REALTIMEKIT_APP_ID",
  "REALTIMEKIT_PRESET_NAME",
  "CLOUDFLARE_ACCOUNT_ID",
  // Optional Calls TURN key (ops / custom WebRTC). RealtimeKit voice does not require these.
  "TURN_KEY_ID",
  "TURN_KEY_API_TOKEN",
];

const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required secrets: ${missing.join(", ")}`);
  process.exit(1);
}

/** @type {Record<string, string>} */
const payload = {};
for (const key of [...required, ...optional]) {
  const value = process.env[key];
  if (value) payload[key] = value;
}

const target = path.resolve(out);
writeFileSync(target, JSON.stringify(payload, null, 2));
console.log(`Wrote ${Object.keys(payload).length} secret keys to ${out} (values redacted).`);
