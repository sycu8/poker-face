import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";

const base = process.argv[2] ?? "http://127.0.0.1:5210";

function jar() {
  let c = "";
  return {
    get cookie() {
      return c;
    },
    store(res) {
      for (const x of res.headers.getSetCookie?.() ?? []) {
        const p = x.split(";")[0];
        const n = p.split("=")[0];
        c = [
          ...c
            .split("; ")
            .filter(Boolean)
            .filter((y) => !y.startsWith(n + "=")),
          p,
        ].join("; ");
      }
    },
  };
}

async function api(j, path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (j.cookie) headers.cookie = j.cookie;
  if (opts.body) headers["content-type"] = "application/json";
  const res = await fetch(base + path, { ...opts, headers });
  j.store(res);
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

const stamp = Date.now().toString(36);
const password = "QaPassw0rd!local";
const host = jar();
await api(host, "/api/auth/register", {
  method: "POST",
  body: JSON.stringify({
    username: `qa_dh_${stamp}`,
    email: `qa_dh_${stamp}@example.test`,
    password,
    displayName: "Deal Host",
  }),
});
const { room } = await api(host, "/api/rooms", {
  method: "POST",
  body: JSON.stringify({ name: "Deal Fix", smallBlind: 1, startingStack: 100 }),
});
const p2 = jar();
await api(p2, "/api/auth/register", {
  method: "POST",
  body: JSON.stringify({
    username: `qa_dp_${stamp}`,
    email: `qa_dp_${stamp}@example.test`,
    password,
    displayName: "Deal P2",
  }),
});
const jr = await api(p2, "/api/rooms/join-request", {
  method: "POST",
  body: JSON.stringify({
    inviteCode: room.inviteCode,
    idempotencyKey: crypto.randomUUID(),
  }),
});
await api(host, "/api/rooms/join-decision", {
  method: "POST",
  body: JSON.stringify({
    requestId: jr.requestId,
    approve: true,
    idempotencyKey: crypto.randomUUID(),
  }),
});

const browser = await puppeteer.launch({
  executablePath: "/opt/google/chrome/chrome",
  headless: "new",
  args: [
    "--no-sandbox",
    "--disable-gpu",
    "--window-size=1280,900",
    "--disable-dev-shm-usage",
  ],
  defaultViewport: { width: 1280, height: 900 },
});
const page = await browser.newPage();
const [name, ...rest] = host.cookie.split("; ")[0].split("=");
await page.setCookie({ name, value: rest.join("="), url: base });
await page.goto(`${base}/table/${room.id}`, { waitUntil: "networkidle0" });
await page.waitForSelector(".table-felt", { timeout: 20000 });
await page.waitForFunction(
  () =>
    [...document.querySelectorAll("button")].some((b) =>
      b.textContent?.includes("Deal everyone in"),
    ),
  { timeout: 15000 },
);
const before = await page.evaluate(() =>
  [...document.querySelectorAll("button")].some((b) =>
    b.textContent?.includes("Deal everyone in"),
  ),
);
await page.evaluate(() =>
  [...document.querySelectorAll("button")]
    .find((b) => b.textContent?.includes("Deal everyone in"))
    ?.click(),
);
await page.waitForFunction(() => /Preflop|Fold|Call/i.test(document.body.innerText), {
  timeout: 15000,
});
await new Promise((r) => setTimeout(r, 600));
const after = await page.evaluate(() =>
  [...document.querySelectorAll("button")].some((b) =>
    b.textContent?.includes("Deal everyone in"),
  ),
);
await page.screenshot({
  path: "/opt/cursor/artifacts/qa_deal_hidden_midhand_after.png",
  fullPage: true,
});
const result = {
  dealVisibleWaiting: before,
  dealVisibleMidHand: after,
  ok: before === true && after === false,
};
writeFileSync("/opt/cursor/artifacts/qa_deal_fix.json", JSON.stringify(result, null, 2));
console.log(result);
await browser.close();
if (!result.ok) process.exit(1);
