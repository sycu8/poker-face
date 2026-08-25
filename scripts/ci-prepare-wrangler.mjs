#!/usr/bin/env node
/**
 * CI helper: ensure Cloudflare resources exist and patch wrangler.jsonc IDs.
 * Requires CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID.
 * Optional: D1_DATABASE_ID, KV_NAMESPACE_ID, TURNSTILE_SITE_KEY, APP_ORIGIN, WEBAUTHN_RP_ID
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const envName = process.argv[2];
if (envName !== "staging" && envName !== "production") {
  console.error("Usage: node scripts/ci-prepare-wrangler.mjs <staging|production>");
  process.exit(1);
}

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
if (!apiToken || !accountId) {
  console.error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required.");
  process.exit(1);
}

const root = path.resolve(import.meta.dirname, "..");
const wranglerPath = path.join(root, "wrangler.jsonc");

function run(cmd, args) {
  return execFileSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
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

async function cfApi(pathname, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json();
  if (!res.ok || body.success === false) {
    throw new Error(
      `Cloudflare API ${pathname} failed: ${res.status} ${JSON.stringify(body.errors ?? body)}`,
    );
  }
  return body;
}

function isUuid(value) {
  return Boolean(value && /^[0-9a-f-]{36}$/i.test(value) && !value.includes("REPLACE"));
}

async function ensureD1(databaseName) {
  if (isUuid(process.env.D1_DATABASE_ID)) return process.env.D1_DATABASE_ID;

  const listed = await cfApi(`/accounts/${accountId}/d1/database`);
  const existing = (listed.result ?? []).find((db) => db.name === databaseName);
  if (existing?.uuid) return existing.uuid;

  const created = wrangler(["d1", "create", databaseName]);
  console.log(created);
  const uuidMatch = created.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  if (!uuidMatch) throw new Error(`Could not parse D1 id for ${databaseName}`);
  return uuidMatch[1];
}

async function ensureKv(title) {
  if (isUuid(process.env.KV_NAMESPACE_ID)) return process.env.KV_NAMESPACE_ID;

  const listed = await cfApi(`/accounts/${accountId}/storage/kv/namespaces`);
  const existing = (listed.result ?? []).find((ns) => ns.title === title);
  if (existing?.id) return existing.id;

  const created = await cfApi(`/accounts/${accountId}/storage/kv/namespaces`, {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  if (!created.result?.id) throw new Error(`Could not create KV namespace ${title}`);
  return created.result.id;
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
    if (/already exists|409|Code: 409/i.test(msg)) return;
    // Some accounts return a non-zero exit even when the queue exists.
    try {
      const listed = wrangler(["queues", "list"]);
      if (listed.includes(name)) return;
    } catch {
      /* fall through */
    }
    if (!/already exists|409/i.test(msg)) throw err;
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

const d1Id = await ensureD1(names.d1);
const kvId = await ensureKv(names.kv);
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
      `("ENVIRONMENT": "${envName}"[\\s\\S]*?"APP_ORIGIN": ")([^"]*)(")`,
    ),
    `$1${appOrigin}$3`,
  );
}
if (rpId) {
  configText = configText.replace(
    new RegExp(
      `("ENVIRONMENT": "${envName}"[\\s\\S]*?"WEBAUTHN_RP_ID": ")([^"]*)(")`,
    ),
    `$1${rpId}$3`,
  );
}
if (turnstileSiteKey) {
  // Replace only within the target env block.
  const envMarker = `"ENVIRONMENT": "${envName}"`;
  const idx = configText.indexOf(envMarker);
  if (idx !== -1) {
    const before = configText.slice(0, idx);
    let after = configText.slice(idx);
    after = after.replace(`"TURNSTILE_SITE_KEY": ""`, `"TURNSTILE_SITE_KEY": ${JSON.stringify(turnstileSiteKey)}`);
    configText = before + after;
  }
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
