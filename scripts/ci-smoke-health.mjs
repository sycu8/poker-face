#!/usr/bin/env node
/**
 * Production smoke for canonical /api/health.
 *
 * GitHub Actions egress is often challenged by Cloudflare Bot Fight Mode
 * ("Just a moment..." → HTTP 403). Free Bot Fight Mode cannot be skipped with
 * WAF path rules. A temporary IP Access *Allow* for this runner's egress IP
 * is evaluated before Bot Fight Mode and is the smallest Free-plan exception.
 *
 * Never treats Wrangler deployment metadata as health success.
 *
 * Env:
 *   CLOUDFLARE_API_TOKEN (required)
 *   CLOUDFLARE_ACCOUNT_ID (optional; used only for diagnostics)
 *   APP_ORIGIN / BASE (default https://poker.orangecloud.vn)
 *   HEALTH_PATH (default /api/health)
 *   SMOKE_USER_AGENT (optional)
 */
import { randomUUID } from "node:crypto";

const BASE = (
  process.env.APP_ORIGIN ||
  process.env.BASE ||
  "https://poker.orangecloud.vn"
).replace(/\/$/, "");
const HEALTH_PATH = process.env.HEALTH_PATH || "/api/health";
const HEALTH_URL = `${BASE}${HEALTH_PATH.startsWith("/") ? HEALTH_PATH : `/${HEALTH_PATH}`}`;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN || "";
const UA =
  process.env.SMOKE_USER_AGENT ||
  "PokerFaces-DeploySmoke/1.0 (+https://github.com/sycu8/poker-face)";
const NOTE_PREFIX = "poker-faces-deploy-smoke";

function die(msg, code = 1) {
  console.error(`::error::${msg}`);
  process.exit(code);
}

async function cfApi(path, { method = "GET", body } = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

async function resolveZoneId(hostname) {
  // Walk up labels: poker.orangecloud.vn → orangecloud.vn
  const parts = hostname.split(".");
  const candidates = [];
  for (let i = 0; i < parts.length - 1; i++) {
    candidates.push(parts.slice(i).join("."));
  }
  for (const name of candidates) {
    const { res, json } = await cfApi(
      `/zones?name=${encodeURIComponent(name)}&status=active`,
    );
    if (!res.ok || !json.success) continue;
    const zone = json.result?.[0];
    if (zone?.id) return { zoneId: zone.id, zoneName: zone.name };
  }
  return null;
}

async function getEgressIp() {
  const res = await fetch("https://api.ipify.org?format=json", {
    headers: { "user-agent": UA },
  });
  if (!res.ok) throw new Error(`ipify HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.ip || typeof data.ip !== "string") throw new Error("ipify missing ip");
  return data.ip;
}

async function findExistingAllow(zoneId, ip) {
  const { res, json } = await cfApi(
    `/zones/${zoneId}/firewall/access_rules/rules?mode=whitelist&configuration.target=ip&configuration.value=${encodeURIComponent(ip)}&per_page=50`,
  );
  if (!res.ok || !json.success) return null;
  const rows = json.result || [];
  return (
    rows.find((r) => r?.configuration?.value === ip && r?.mode === "whitelist") || null
  );
}

/**
 * @returns {{ ruleId: string, created: boolean }}
 */
async function ensureAllowRule(zoneId, ip, note) {
  const existing = await findExistingAllow(zoneId, ip);
  if (existing?.id) {
    console.log(
      `Reusing existing IP Access Allow rule ${existing.id} for ${ip}` +
        (existing.notes ? ` (notes: ${String(existing.notes).slice(0, 80)})` : ""),
    );
    return { ruleId: existing.id, created: false };
  }

  const { res, json } = await cfApi(`/zones/${zoneId}/firewall/access_rules/rules`, {
    method: "POST",
    body: {
      mode: "whitelist",
      configuration: { target: "ip", value: ip },
      notes: note,
    },
  });
  if (!res.ok || !json.success) {
    const err = JSON.stringify(json.errors || json);
    // Race: another job may have created the same IP allow.
    if (res.status === 400 || res.status === 409) {
      const again = await findExistingAllow(zoneId, ip);
      if (again?.id) {
        console.log(`Allow rule appeared after create conflict; reusing ${again.id}`);
        return { ruleId: again.id, created: false };
      }
    }
    throw new Error(
      `Failed to create IP Access Allow rule: HTTP ${res.status} ${err}. ` +
        `Token needs Zone.Firewall Services:Edit (IP Access Rules) on this zone.`,
    );
  }
  return { ruleId: json.result.id, created: true };
}

async function deleteAllowRule(zoneId, ruleId) {
  const { res, json } = await cfApi(
    `/zones/${zoneId}/firewall/access_rules/rules/${ruleId}`,
    {
      method: "DELETE",
    },
  );
  if (!res.ok || !json.success) {
    console.warn(
      `::warning::Failed to delete temporary IP Access rule ${ruleId}: HTTP ${res.status}`,
    );
  } else {
    console.log(`Removed temporary IP Access Allow rule ${ruleId}`);
  }
}

async function probeHealth() {
  const res = await fetch(HEALTH_URL, {
    headers: { "user-agent": UA, accept: "application/json" },
    redirect: "manual",
  });
  const text = await res.text();
  return { status: res.status, text };
}

function assertHealthBody(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    die(
      `Health body is not JSON (got challenge HTML or garbage). First 200 chars: ${text.slice(0, 200)}`,
    );
  }
  if (data.ok !== true) die(`Health JSON missing ok:true — ${text.slice(0, 200)}`);
  if (data.environment !== "production") {
    die(`Health JSON missing environment:production — ${text.slice(0, 200)}`);
  }
}

async function main() {
  console.log(`Probing canonical ${HEALTH_URL}`);
  if (!TOKEN) {
    die(
      "CLOUDFLARE_API_TOKEN is required for temporary IP Access Allow (Bot Fight Mode bypass). See docs/GITHUB_ACTIONS_DEPLOY.md",
    );
  }

  let hostname;
  try {
    hostname = new URL(BASE).hostname;
  } catch {
    die(`Invalid APP_ORIGIN/BASE: ${BASE}`);
  }

  const zone = await resolveZoneId(hostname);
  if (!zone) {
    die(
      `Could not resolve Cloudflare zone for ${hostname}. Token needs Zone.Firewall Services:Edit (or Account equivalent) and Zone.Zone:Read.`,
    );
  }
  console.log(`Zone ${zone.zoneName} (${zone.zoneId})`);

  const ip = await getEgressIp();
  console.log(`Runner egress IP ${ip}`);

  const note = `${NOTE_PREFIX} ${randomUUID().slice(0, 8)}`;
  let ruleId = null;
  let created = false;
  try {
    const ensured = await ensureAllowRule(zone.zoneId, ip, note);
    ruleId = ensured.ruleId;
    created = ensured.created;
    if (created) {
      console.log(`Created temporary IP Access Allow rule ${ruleId} for ${ip}`);
    }

    // Propagation can take a few seconds after create.
    let last = { status: 0, text: "" };
    for (let attempt = 1; attempt <= 12; attempt++) {
      await new Promise((r) => setTimeout(r, attempt === 1 ? 2000 : 3000));
      last = await probeHealth();
      console.log(`Attempt ${attempt}: HTTP ${last.status}`);
      if (last.status === 200) {
        assertHealthBody(last.text);
        console.log(last.text);
        console.log("Canonical origin smoke passed.");
        return;
      }
      // Keep going while challenge/403; other codes fail fast after a few tries.
      if (
        last.status !== 403 &&
        last.status !== 429 &&
        last.status !== 0 &&
        attempt >= 3
      ) {
        break;
      }
    }

    const hint =
      last.status === 403
        ? " Still challenged after IP Access Allow — confirm Free Bot Fight Mode is the product in use, or upgrade to Super Bot Fight Mode + path Skip (see docs/GITHUB_ACTIONS_DEPLOY.md)."
        : "";
    die(
      `Canonical production health must return HTTP 200. Got ${last.status}.${hint} Wrangler deployment metadata is NOT a health substitute.`,
    );
  } finally {
    // Only delete rules we created this run — never remove a pre-existing Allow.
    if (ruleId && created) {
      try {
        await deleteAllowRule(zone.zoneId, ruleId);
      } catch (err) {
        console.warn("::warning::Cleanup of IP Access rule failed:", err);
      }
    }
  }
}

main().catch((err) => {
  die(err instanceof Error ? err.message : String(err));
});
