import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../worker/lib/http";
import {
  HOMEPAGE_LINK_HEADER,
  PLAY_SKILL_DESCRIPTION,
  authMarkdown,
  robotsTxt,
  skillMarkdown,
} from "../../worker/discovery/documents";
import { handleDiscovery } from "../../worker/discovery/handle";
import { publicPageOrNull } from "../../src/publicPages";

const ORIGIN = "https://poker.example";

function get(path: string, method = "GET"): Request {
  return new Request(`${ORIGIN}${path}`, { method });
}

async function body(response: Response): Promise<string> {
  return await response.text();
}

describe("agent discovery documents", () => {
  it("serves robots.txt as plain text with AI rules, signals, and sitemap", async () => {
    const response = await handleDiscovery(get("/robots.txt"), ORIGIN);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toContain("text/plain");
    const text = await body(response!);
    for (const agent of [
      "OAI-SearchBot",
      "Claude-SearchBot",
      "PerplexityBot",
      "GPTBot",
      "ClaudeBot",
      "Google-Extended",
      "Applebot-Extended",
      "CCBot",
      "Bytespider",
      "Amazonbot",
      "ChatGPT-User",
      "Claude-User",
      "Perplexity-User",
      "*",
    ]) {
      expect(text).toContain(`User-agent: ${agent}`);
    }
    expect(text).toContain("Content-Signal: ai-train=no, search=yes, ai-input=no");
    expect(text).toContain("Content-Signal: ai-train=no, search=no, ai-input=no");
    expect(text).toContain("Disallow: /api/");
    expect(text).toContain("Disallow: /table/");
    expect(text).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
    expect(text).toContain(`Agentmap: ${ORIGIN}/.well-known/ai-catalog.json`);
    expect(robotsTxt(ORIGIN).endsWith("\n")).toBe(true);
  });

  it("blocks training crawlers and keeps search crawlers on public pages", () => {
    const text = robotsTxt(ORIGIN);
    const gpt = text.split("User-agent: GPTBot")[1]?.split("User-agent:")[0] ?? "";
    expect(gpt).toContain("Disallow: /");
    expect(gpt).not.toContain("Allow: /");
    const search =
      text.split("User-agent: OAI-SearchBot")[1]?.split("User-agent:")[0] ?? "";
    expect(search).toContain("Allow: /");
    expect(search).toContain("Disallow: /api/");
  });

  it("serves a sitemap of canonical public pages", async () => {
    const response = await handleDiscovery(get("/sitemap.xml"), ORIGIN);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toContain("application/xml");
    const xml = await body(response!);
    expect(xml).toContain("<urlset");
    expect(xml).toContain(`<loc>${ORIGIN}/</loc>`);
    expect(xml).toContain(`<loc>${ORIGIN}/auth</loc>`);
    expect(xml).not.toContain("/table/");
  });

  it("serves an API catalog linkset", async () => {
    const response = await handleDiscovery(get("/.well-known/api-catalog"), ORIGIN);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toContain("application/linkset+json");
    const catalog = (await response!.json()) as {
      linkset: {
        anchor: string;
        "service-desc": { href: string }[];
        "service-doc": { href: string }[];
        status: { href: string }[];
      }[];
    };
    const entry = catalog.linkset[0]!;
    expect(entry.anchor).toBe(`${ORIGIN}/api/health`);
    expect(entry["service-desc"][0]?.href).toBe(`${ORIGIN}/openapi.json`);
    expect(entry["service-doc"][0]?.href).toBe(`${ORIGIN}/auth.md`);
    expect(entry.status[0]?.href).toBe(`${ORIGIN}/api/health`);
  });

  it("publishes OAuth metadata that agrees on the issuer", async () => {
    const as = await handleDiscovery(
      get("/.well-known/oauth-authorization-server"),
      ORIGIN,
    );
    const oidc = await handleDiscovery(get("/.well-known/openid-configuration"), ORIGIN);
    const prm = await handleDiscovery(
      get("/.well-known/oauth-protected-resource"),
      ORIGIN,
    );
    const jwks = await handleDiscovery(get("/.well-known/jwks.json"), ORIGIN);
    expect(as?.status).toBe(200);
    expect(oidc?.status).toBe(200);
    expect(prm?.status).toBe(200);
    const auth = (await as!.json()) as {
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      jwks_uri: string;
      grant_types_supported: string[];
      response_types_supported: string[];
      agent_auth: {
        skill: string;
        register_uri: string;
        identity_types_supported: string[];
        anonymous: { credential_types_supported: string[]; claim_uri: string };
      };
    };
    expect(auth.issuer).toBe(ORIGIN);
    expect(auth.authorization_endpoint).toBe(`${ORIGIN}/auth`);
    expect(auth.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
    expect(auth.jwks_uri).toBe(`${ORIGIN}/.well-known/jwks.json`);
    expect(auth.grant_types_supported.length).toBeGreaterThan(0);
    expect(auth.response_types_supported).toContain("code");
    expect(auth.agent_auth.skill).toBe(`${ORIGIN}/auth.md`);
    expect(auth.agent_auth.register_uri).toContain("/auth");
    expect(auth.agent_auth.identity_types_supported).toContain("anonymous");
    expect(auth.agent_auth.anonymous.credential_types_supported.length).toBeGreaterThan(
      0,
    );
    expect(auth.agent_auth.anonymous.claim_uri).toBe(`${ORIGIN}/auth`);
    const resource = (await prm!.json()) as {
      resource: string;
      authorization_servers: string[];
      scopes_supported: string[];
      bearer_methods_supported: string[];
    };
    expect(resource.resource).toBe(`${ORIGIN}/`);
    expect(resource.authorization_servers).toEqual([auth.issuer]);
    expect(resource.scopes_supported.length).toBeGreaterThan(0);
    expect(resource.bearer_methods_supported).toContain("header");
    const keys = (await jwks!.json()) as { keys: unknown[] };
    expect(Array.isArray(keys.keys)).toBe(true);
    const token = await handleDiscovery(
      new Request(`${ORIGIN}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "authorization_code" }),
      }),
      ORIGIN,
    );
    expect(token?.status).toBe(400);
    const tokenBody = (await token!.json()) as { error: string };
    expect(tokenBody.error).toBe("unsupported_grant_type");
  });

  it("serves auth.md with the required heading", async () => {
    const response = await handleDiscovery(get("/auth.md"), ORIGIN);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toContain("text/markdown");
    const text = await body(response!);
    expect(text.startsWith("# auth.md\n")).toBe(true);
    expect(text).toContain("pf_session");
    expect(authMarkdown(ORIGIN)).toContain("# auth.md");
  });

  it("serves an MCP server card and a JSON-RPC tools call", async () => {
    const card = await handleDiscovery(get("/.well-known/mcp/server-card.json"), ORIGIN);
    expect(card?.status).toBe(200);
    expect(card?.headers.get("content-type")).toContain(
      "application/mcp-server-card+json",
    );
    const doc = (await card!.json()) as {
      serverInfo: { name: string; version: string };
      transport: { endpoint: string };
      capabilities: { tools: unknown };
    };
    expect(doc.serverInfo.name).toBe("Poker Faces");
    expect(doc.serverInfo.version).toBe("0.1.0");
    expect(doc.transport.endpoint).toBe(`${ORIGIN}/mcp`);
    expect(doc.capabilities.tools).toBeTruthy();

    const init = await handleDiscovery(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      }),
      ORIGIN,
    );
    expect(init?.status).toBe(200);
    const initBody = (await init!.json()) as {
      result: { serverInfo: { name: string }; protocolVersion: string };
    };
    expect(initBody.result.protocolVersion).toBe("2025-03-26");
    expect(initBody.result.serverInfo.name).toBe(doc.serverInfo.name);

    const call = await handleDiscovery(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "poker_faces_rules", arguments: {} },
        }),
      }),
      ORIGIN,
    );
    const callBody = (await call!.json()) as {
      result: { content: { text: string }[]; isError: boolean };
    };
    expect(callBody.result.isError).toBe(false);
    expect(callBody.result.content[0]?.text).toContain("Virtual chips only");
  });

  it("serves a skills index whose digests match the skill files", async () => {
    const response = await handleDiscovery(
      get("/.well-known/agent-skills/index.json"),
      ORIGIN,
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toContain("application/json");
    const index = (await response!.json()) as {
      $schema: string;
      skills: {
        name: string;
        type: string;
        description: string;
        url: string;
        digest: string;
      }[];
    };
    expect(index.$schema).toBe(
      "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    );
    expect(index.skills.length).toBeGreaterThan(0);
    for (const skill of index.skills) {
      expect(skill.type).toBe("skill-md");
      expect(skill.description.length).toBeGreaterThan(0);
      expect(skill.url).toContain(`/SKILL.md`);
      const file = await handleDiscovery(get(new URL(skill.url).pathname), ORIGIN);
      expect(file?.status).toBe(200);
      const markdown = await body(file!);
      expect(markdown).toContain(`description: ${skill.description}`);
      const digest = await sha256Hex(markdown);
      expect(skill.digest).toBe(`sha256:${digest}`);
    }
    expect(
      index.skills.some((skill) => skill.description === PLAY_SKILL_DESCRIPTION),
    ).toBe(true);
    const missing = await handleDiscovery(
      get("/.well-known/agent-skills/missing-skill/SKILL.md"),
      ORIGIN,
    );
    expect(missing?.status).toBe(404);
    expect(skillMarkdown("poker-faces-play")).toContain("name: poker-faces-play");
  });

  it("serves an ARD catalog as JSON with CORS", async () => {
    const response = await handleDiscovery(get("/.well-known/ai-catalog.json"), ORIGIN);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toContain("application/json");
    expect(response?.headers.get("access-control-allow-origin")).toBe("*");
    const catalog = (await response!.json()) as {
      specVersion: string;
      host: { displayName: string; identifier: string };
      entries: {
        identifier: string;
        displayName: string;
        type: string;
        url?: string;
        data?: string;
        representativeQueries: string[];
      }[];
    };
    expect(catalog.specVersion).toBe("1.0");
    expect(catalog.host.displayName).toBe("Poker Faces");
    expect(catalog.host.identifier).toBe("did:web:poker.example");
    expect(catalog.entries.length).toBeGreaterThan(0);
    for (const entry of catalog.entries) {
      expect(entry.identifier.startsWith("urn:air:poker.example:")).toBe(true);
      expect(entry.displayName.length).toBeGreaterThan(0);
      expect(entry.type).toContain("/");
      const hasUrl = typeof entry.url === "string";
      const hasData = entry.data !== undefined;
      expect(hasUrl).not.toBe(hasData);
      expect(entry.representativeQueries.length).toBeGreaterThanOrEqual(2);
      expect(entry.representativeQueries.length).toBeLessThanOrEqual(5);
    }
  });

  it("answers HEAD without falling through and rejects the wrong method", async () => {
    const head = await handleDiscovery(get("/robots.txt", "HEAD"), ORIGIN);
    expect(head?.status).toBe(200);
    expect(head?.headers.get("content-type")).toContain("text/plain");
    expect(await head!.text()).toBe("");
    const posted = await handleDiscovery(
      new Request(`${ORIGIN}/robots.txt`, { method: "POST" }),
      ORIGIN,
    );
    expect(posted?.status).toBe(405);
  });

  it("advertises discovery links and only opens public pages", () => {
    expect(HOMEPAGE_LINK_HEADER).toContain('rel="api-catalog"');
    expect(HOMEPAGE_LINK_HEADER).toContain('rel="service-desc"');
    expect(HOMEPAGE_LINK_HEADER).toContain('rel="service-doc"');
    expect(HOMEPAGE_LINK_HEADER).toContain('rel="describedby"');
    expect(publicPageOrNull("/auth")).toBe("/auth");
    expect(publicPageOrNull("/table/secret")).toBeNull();
  });
});
