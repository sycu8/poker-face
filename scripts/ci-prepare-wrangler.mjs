#!/usr/bin/env node
/**
 * CI helper: ensure Cloudflare resources exist and patch wrangler.jsonc IDs.
 * Requires CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID.
 * Optional overrides: D1_DATABASE_ID, KV_NAMESPACE_ID, TURNSTILE_SITE_KEY, APP_ORIGIN, WEBAUTHN_RP_ID
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const envName = process.argv[2];
if (envName !== "staging" && envName !== "production") {
  console.error("Usage: node scripts/ci-prepare-wrangler.mjs <staging|production>");
  process.exit(1);
}

if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
  console.error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required.");
  process.exit(1);
}

const root = path.resolve(import.meta.dirname, "..");
const wranglerPath = path.join(root, "wrangler.jsonc");

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

function wrangler(args) {
  try {
    return run("npx", ["wrangler", ...args]);
  } catch (err) {
    const out = `${err.stdout ?? ""}\n${err.stderr ?? ""}\n${err.message ?? ""}`;
    throw new Error(`wrangler ${args.join(" ")} failed:\n${out}`);
  }
}

function parseJsonFromOutput(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function ensureD1(databaseName) {
  if (process.env.D1_DATABASE_ID && !process.env.D1_DATABASE_ID.includes("REPLACE")) {
    return process.env.D1_DATABASE_ID;
  }
  const listOut = wrangler(["d1", "list", "--json"]);
  let list;
  try {
    list = JSON.parse(listOut);
  } catch {
    list = [];
  }
  const existing = (Array.isArray(list) ? list : list?.result ?? []).find(
    (db) => db.name === databaseName || db.uuid === process.env.D1_DATABASE_ID,
  );
  if (existing?.uuid) return existing.uuid;

  const created = wrangler(["d1", "create", databaseName]);
  console.log(created);
  const uuidMatch = created.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (!uuidMatch) throw new Error(`Could not parse D1 id for ${databaseName}`);
  return uuidMatch[1];
}

function ensureKv(title) {
  if (process.env.KV_NAMESPACE_ID && !process.env.KV_NAMESPACE_ID.includes("REPLACE")) {
    return process.env.KV_NAMESPACE_ID;
  }
  const listOut = wrangler(["kv", "namespace", "list", "--json"]);
  let list;
  try {
    list = JSON.parse(listOut);
  } catch {
    list = [];
  }
  const existing = (Array.isArray(list) ? list : []).find((ns) => ns.title === title);
  if (existing?.id) return existing.id;

  const created = wrangler(["kv", "namespace", "create", title]);
  console.log(created);
  const idMatch = created.match(/id\s*=\s*"([^"]+)"/i) || created.match(/"id"\s*:\s*"([^"]+)"/);
  if (!idMatch) throw new Error(`Could not parse KV id for ${title}`);
  return idMatch[1];
}

function ensureR2(bucket) {
  try {
    wrangler(["r2", "bucket", "info", bucket]);
  } catch {
    console.log(wrangler(["r2", "bucket", "create", bucket]));
  }
}

function ensureQueue(name) {
  try {
    wrangler(["queues", "create", name]);
  } catch (err) {
    const msg = String(err.message ?? err);
    if (!/already exists|409|code: 409/i.test(msg)) {
      // list and continue if present
      try {
        const listed = wrangler(["queues", "list"]);
        if (!listed.includes(name)) throw err;
      } catch {
        if (!/already exists|409/i.test(msg)) throw err;
      }
    }
  }
}

const names =
  envName === "staging"
    ? {
        d1: "poker-faces-staging",
        kv: "poker-faces-config-staging",
        r2: "poker-faces-replays-staging",
        queue: "poker-faces-archive-staging",
        dlq: "poker-faces-archive-dlq-staging",
        placeholderD1: "REPLACE_STAGING_D1_ID",
        placeholderKv: "REPLACE_STAGING_KV_ID",
      }
    : {
        d1: "poker-faces-production",
        kv: "poker-faces-config-production",
        r2: "poker-faces-replays-production",
        queue: "poker-faces-archive-production",
        dlq: "poker-faces-archive-dlq-production",
        placeholderD1: "REPLACE_PRODUCTION_D1_ID",
        placeholderKv: "REPLACE_PRODUCTION_KV_ID",
      };

console.log(`Preparing Cloudflare resources for ${envName}…`);
const d1Id = ensureD1(names.d1);
const kvId = ensureKv(names.kv);
ensureR2(names.r2);
ensureQueue(names.queue);
ensureQueue(names.dlq);

let configText = readFileSync(wranglerPath, "utf8");
configText = configText.replaceAll(names.placeholderD1, d1Id).replaceAll(names.placeholderKv, kvId);

const turnstileSiteKey = process.env.TURNSTILE_SITE_KEY ?? "";
const appOrigin = process.env.APP_ORIGIN;
const rpId = process.env.WEBAUTHN_RP_ID;

if (appOrigin) {
  configText = configText.replace(
    new RegExp(
      `("ENVIRONMENT": "${envName === "staging" ? "staging" : "production"}"[\\s\\S]*?"APP_ORIGIN": ")([^"]*)(")`,
    ),
    `$1${appOrigin}$3`,
  );
}
if (rpId) {
  configText = configText.replace(
    new RegExp(
      `("ENVIRONMENT": "${envName === "staging" ? "staging" : "production"}"[\\s\\S]*?"WEBAUTHN_RP_ID": ")([^"]*)(")`,
    ),
    `$1${rpId}$3`,
  );
}
if (turnstileSiteKey) {
  // Replace TURNSTILE_SITE_KEY inside the matching env block only — simple global for empty string in that env is brittle;
  // write after JSONC strip comments via string replace of known empty values when preparing.
  configText = configText.replace(
    `"TURNSTILE_SITE_KEY": ""`,
    `"TURNSTILE_SITE_KEY": ${JSON.stringify(turnstileSiteKey)}`,
  );
}

writeFileSync(wranglerPath, configText);
console.log(
  JSON.stringify(
    {
      environment: envName,
      d1Id,
      kvId,
      r2: names.r2,
      queue: names.queue,
    },
    null,
    2,
  ),
);
void parseJsonFromOutput;
