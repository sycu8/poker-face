import { sha256Hex } from "../lib/http";

/** Public pages included in the sitemap. Update the date when this list changes. */
export const SITEMAP_LASTMOD = "2026-10-17";

export const SERVER_NAME = "Poker Faces";
export const SERVER_VERSION = "0.1.0";

export const HOMEPAGE_LINK_HEADER = [
  '</.well-known/api-catalog>; rel="api-catalog"',
  '</openapi.json>; rel="service-desc"; type="application/json"',
  '</auth.md>; rel="service-doc"; type="text/markdown"',
  '</.well-known/ai-catalog.json>; rel="describedby"; type="application/json"',
  '</api/health>; rel="status"',
].join(", ");

const SEARCH_AGENTS = ["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot"] as const;

const TRAINING_AGENTS = [
  "GPTBot",
  "ClaudeBot",
  "Google-Extended",
  "Applebot-Extended",
  "CCBot",
  "Bytespider",
  "Amazonbot",
] as const;

const USER_FETCHERS = ["ChatGPT-User", "Claude-User", "Perplexity-User"] as const;

const SEARCH_SIGNAL = "Content-Signal: ai-train=no, search=yes, ai-input=no";
const TRAIN_SIGNAL = "Content-Signal: ai-train=no, search=no, ai-input=no";

const PRIVATE_RULES = [
  "Allow: /",
  "Disallow: /api/",
  "Disallow: /ws/",
  "Disallow: /admin",
  "Disallow: /table/",
  "Disallow: /mcp",
  "Disallow: /oauth/",
];

export function siteOrigin(appOrigin: string, requestUrl: URL): string {
  try {
    return new URL(appOrigin).origin;
  } catch {
    return requestUrl.origin;
  }
}

export function isHomepagePath(pathname: string): boolean {
  return pathname === "/" || pathname === "/index.html";
}

function didWeb(origin: string): string {
  const url = new URL(origin);
  const host = url.port ? `${url.hostname}%3A${url.port}` : url.hostname;
  return `did:web:${host}`;
}

function airHost(origin: string): string {
  return new URL(origin).hostname;
}

function group(agent: string, lines: string[]): string {
  return [`User-agent: ${agent}`, ...lines].join("\n");
}

export function robotsTxt(origin: string): string {
  const search = [...SEARCH_AGENTS, ...USER_FETCHERS].map((agent) =>
    group(agent, [SEARCH_SIGNAL, ...PRIVATE_RULES]),
  );
  const training = TRAINING_AGENTS.map((agent) =>
    group(agent, [TRAIN_SIGNAL, "Disallow: /"]),
  );
  const everyone = group("*", [SEARCH_SIGNAL, ...PRIVATE_RULES]);
  return (
    [
      [
        "# Poker Faces crawl policy",
        "# Search crawlers may index public pages. Training crawlers may not.",
        "# Private tables, account APIs, admin, and websockets stay closed.",
      ].join("\n"),
      ...search,
      ...training,
      everyone,
      [
        `Sitemap: ${origin}/sitemap.xml`,
        `Agentmap: ${origin}/.well-known/ai-catalog.json`,
      ].join("\n"),
    ].join("\n\n") + "\n"
  );
}

export function sitemapXml(origin: string): string {
  const pages = [
    { loc: `${origin}/`, priority: "1.0" },
    { loc: `${origin}/auth`, priority: "0.6" },
  ];
  const urls = pages
    .map(
      (page) => `  <url>
    <loc>${page.loc}</loc>
    <lastmod>${SITEMAP_LASTMOD}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${page.priority}</priority>
  </url>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

export function apiCatalog(origin: string): unknown {
  return {
    linkset: [
      {
        anchor: `${origin}/api/health`,
        "service-desc": [
          {
            href: `${origin}/openapi.json`,
            type: "application/json",
          },
        ],
        "service-doc": [
          {
            href: `${origin}/auth.md`,
            type: "text/markdown",
          },
        ],
        status: [
          {
            href: `${origin}/api/health`,
            type: "application/json",
          },
        ],
      },
    ],
  };
}

export const API_CATALOG_TYPE =
  'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';

const SCOPES = ["profile:read", "tables:host", "tables:join"];

export function authorizationServerMetadata(origin: string): unknown {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/auth`,
    token_endpoint: `${origin}/oauth/token`,
    jwks_uri: `${origin}/.well-known/jwks.json`,
    scopes_supported: SCOPES,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    service_documentation: `${origin}/auth.md`,
    agent_auth: {
      skill: `${origin}/auth.md`,
      register_uri: `${origin}/auth?mode=register`,
      identity_types_supported: ["anonymous"],
      anonymous: {
        credential_types_supported: ["session"],
        claim_uri: `${origin}/auth`,
      },
    },
    poker_faces_session: {
      cookie: "pf_session",
      login_uri: `${origin}/auth`,
      documentation: `${origin}/auth.md`,
    },
  };
}

export function openIdConfiguration(origin: string): unknown {
  return {
    ...(authorizationServerMetadata(origin) as Record<string, unknown>),
    subject_types_supported: ["public"],
  };
}

export function protectedResourceMetadata(origin: string): unknown {
  return {
    resource: `${origin}/`,
    authorization_servers: [origin],
    scopes_supported: SCOPES,
    bearer_methods_supported: ["header"],
  };
}

export function jwks(): unknown {
  return { keys: [] };
}

export function authMarkdown(origin: string): string {
  return `# auth.md

Poker Faces authenticates people with an HttpOnly session cookie. It does not issue bearer tokens or agent API keys.

## Who this is for

A person hosting or joining a private play-money table. An agent may help that person in the browser. Unattended agents do not get their own credentials.

## Register

Open [${origin}/auth?mode=register](${origin}/auth?mode=register). The form asks for a username, email, and password, then runs Cloudflare Turnstile.

The same action is \`POST ${origin}/api/auth/register\` with JSON \`{ "username", "email", "password", "displayName"?, "turnstileToken"? }\`.

## Sign in

Open [${origin}/auth](${origin}/auth) or \`POST ${origin}/api/auth/login\` with \`{ "username", "password", "turnstileToken"? }\`.

A successful sign-in sets the HttpOnly cookie \`pf_session\` (\`SameSite=Lax\`). Send that cookie on later calls. There is no access token.

## Anonymous guest

Open [${origin}/auth?mode=guest](${origin}/auth?mode=guest). A person enters a display name, passes Turnstile, and receives a 24-hour guest session. Guests can ask to join a table. They cannot host. This is not an unattended machine credential.

## Claim

A person claims the account by signing in at [${origin}/auth](${origin}/auth). Poker Faces does not accept ID-JAG assertions and has no separate agent claim API.

## Using the session

- \`GET ${origin}/api/auth/me\` returns the signed-in profile.
- \`POST ${origin}/api/auth/logout\` ends the session.
- \`POST ${origin}/api/rooms\` hosts a table (registered accounts only).
- \`POST ${origin}/api/rooms/join-request\` asks the host to approve an invite code.
- Table state under \`/table/\` and \`/ws/\` is private to members of that table.

## Discovery metadata

- Protected resource: [${origin}/.well-known/oauth-protected-resource](${origin}/.well-known/oauth-protected-resource)
- Authorization server: [${origin}/.well-known/oauth-authorization-server](${origin}/.well-known/oauth-authorization-server)
- OpenID configuration: [${origin}/.well-known/openid-configuration](${origin}/.well-known/openid-configuration)

\`issuer\` is \`${origin}\`. \`authorization_endpoint\` is the human sign-in page. \`token_endpoint\` is \`${origin}/oauth/token\`, which returns \`unsupported_grant_type\` and points back to this document. \`jwks_uri\` publishes an empty JWK set because sessions are opaque cookies, not signed JWTs.

A missing session on a protected API returns \`401\` with:

\`WWW-Authenticate: Bearer realm="poker-faces", resource_metadata="${origin}/.well-known/oauth-protected-resource"\`

The challenge names this metadata. The credential the API accepts is the \`pf_session\` cookie.

Optional GitHub or Google buttons on \`/auth\` are login methods for people. They appear only when that provider is configured.
`;
}

export function openApiDocument(origin: string): unknown {
  return {
    openapi: "3.1.0",
    info: {
      title: "Poker Faces",
      version: SERVER_VERSION,
      description:
        "Private play-money Texas Hold'em. Virtual chips only. Session cookie pf_session authenticates protected routes. See /auth.md.",
    },
    servers: [{ url: origin }],
    paths: {
      "/api/health": {
        get: {
          operationId: "health",
          summary: "Liveness",
          responses: { "200": { description: "Service is up." } },
        },
      },
      "/api/config": {
        get: {
          operationId: "publicConfig",
          summary: "Public copy, feature flags, and which social logins are enabled.",
          responses: { "200": { description: "Public configuration." } },
        },
      },
      "/api/auth/register": {
        post: {
          operationId: "register",
          summary: "Create an account. Requires Turnstile when configured.",
          responses: {
            "200": { description: "Account created and session cookie set." },
          },
        },
      },
      "/api/auth/login": {
        post: {
          operationId: "login",
          summary: "Sign in with username and password.",
          responses: { "200": { description: "Session cookie set." } },
        },
      },
      "/api/auth/guest": {
        post: {
          operationId: "guest",
          summary: "Start a 24-hour guest session for a display name.",
          responses: { "200": { description: "Guest session cookie set." } },
        },
      },
      "/api/auth/me": {
        get: {
          operationId: "me",
          summary: "Signed-in profile.",
          responses: {
            "200": { description: "Current user." },
            "401": { description: "No session." },
          },
        },
      },
      "/api/auth/logout": {
        post: {
          operationId: "logout",
          summary: "End the session.",
          responses: { "200": { description: "Signed out." } },
        },
      },
      "/api/rooms": {
        post: {
          operationId: "createRoom",
          summary: "Host a private table. Registered accounts only.",
          responses: {
            "200": { description: "Room created." },
            "401": { description: "No session." },
            "403": { description: "Guests cannot host." },
          },
        },
      },
      "/api/rooms/mine": {
        get: {
          operationId: "myRooms",
          summary: "Tables the signed-in person belongs to.",
          responses: { "200": { description: "Room list." } },
        },
      },
      "/api/rooms/join-request": {
        post: {
          operationId: "joinRequest",
          summary: "Ask the host to approve an invite code.",
          responses: { "200": { description: "Join request stored." } },
        },
      },
      "/oauth/token": {
        post: {
          operationId: "oauthToken",
          summary: "OAuth token endpoint. Does not issue bearer tokens.",
          responses: {
            "400": { description: "unsupported_grant_type. Use the session cookie." },
          },
        },
      },
    },
  };
}

export function mcpServerCard(origin: string): unknown {
  const endpoint = `${origin}/mcp`;
  return {
    name: "poker-faces",
    title: SERVER_NAME,
    version: SERVER_VERSION,
    description:
      "Public read-only discovery tools for Poker Faces. Private tables are not exposed.",
    serverInfo: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    endpoint,
    transport: {
      type: "streamable-http",
      endpoint,
    },
    remotes: [
      {
        type: "streamable-http",
        url: endpoint,
      },
    ],
    capabilities: {
      tools: { listChanged: false },
    },
    supportedProtocolVersions: ["2025-03-26"],
  };
}

export const PLAY_SKILL_DESCRIPTION =
  "Explain Poker Faces play-money Texas Hold'em: blinds, private tables, and virtual chips only.";

export const DISCOVERY_SKILL_DESCRIPTION =
  "Find Poker Faces discovery documents, the public HTTP API, and how a person signs in.";

export function skillMarkdown(name: string): string | null {
  if (name === "poker-faces-play") {
    return `---
name: poker-faces-play
description: ${PLAY_SKILL_DESCRIPTION}
---

# Play-money Texas Hold'em

Poker Faces is private play-money Texas Hold'em for friends. Virtual chips only. No purchases, cash-out, or wallets.

## When to use

Use this skill when a person asks how a table works, what the blinds mean, or what an agent is allowed to see.

## Rules to repeat accurately

- Each player gets two private hole cards. Never describe or request another player's hole cards.
- The board is five community cards: flop, turn, then river.
- The big blind is exactly twice the small blind.
- Starting stacks are 10 to 1000 virtual chips.
- A person who joins mid-hand waits for the next hand.
- Tables are private. The host approves joins. Invite codes are secrets.

## What an agent can do

- Open the public pages \`/\` and \`/auth\`.
- Read \`/api/health\` and \`/api/config\`.
- Help a person sign in through \`/auth\`.

Do not collect \`/table/\` or room APIs for training or for someone who is not at that table.
`;
  }
  if (name === "poker-faces-discovery") {
    return `---
name: poker-faces-discovery
description: ${DISCOVERY_SKILL_DESCRIPTION}
---

# Discover Poker Faces

Use this skill to find machine-readable documents before calling the API.

## Documents

- \`/robots.txt\` — crawl rules, AI bot groups, and content signals.
- \`/sitemap.xml\` — canonical public pages.
- \`/.well-known/api-catalog\` — linkset for the HTTP API.
- \`/openapi.json\` — OpenAPI description.
- \`/auth.md\` — how a person registers and how the session cookie works.
- \`/.well-known/oauth-protected-resource\` — resource metadata.
- \`/.well-known/oauth-authorization-server\` — authorization server metadata, including \`agent_auth\`.
- \`/.well-known/mcp/server-card.json\` — MCP server card.
- \`/.well-known/ai-catalog.json\` — capability manifest.
- \`/api/health\` — liveness.

## Authentication

Protected routes expect the \`pf_session\` cookie set by \`/auth\`. \`POST /oauth/token\` does not issue a bearer token.
`;
  }
  return null;
}

const SKILL_INDEX: { name: string; description: string }[] = [
  { name: "poker-faces-play", description: PLAY_SKILL_DESCRIPTION },
  { name: "poker-faces-discovery", description: DISCOVERY_SKILL_DESCRIPTION },
];

export async function agentSkillsIndex(origin: string): Promise<unknown> {
  const skills = await Promise.all(
    SKILL_INDEX.map(async (skill) => {
      const body = skillMarkdown(skill.name);
      if (!body) throw new Error(`Missing skill ${skill.name}`);
      const digest = await sha256Hex(body);
      return {
        name: skill.name,
        type: "skill-md",
        description: skill.description,
        url: `${origin}/.well-known/agent-skills/${skill.name}/SKILL.md`,
        digest: `sha256:${digest}`,
      };
    }),
  );
  return {
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    skills,
  };
}

function entry(
  origin: string,
  namespace: string,
  name: string,
  displayName: string,
  type: string,
  path: string,
  representativeQueries: string[],
): unknown {
  return {
    identifier: `urn:air:${airHost(origin)}:${namespace}:${name}`,
    displayName,
    type,
    url: `${origin}${path}`,
    representativeQueries,
  };
}

export function aiCatalog(origin: string): unknown {
  return {
    specVersion: "1.0",
    host: {
      displayName: SERVER_NAME,
      identifier: didWeb(origin),
    },
    entries: [
      entry(
        origin,
        "server",
        "mcp",
        "Poker Faces MCP server",
        "application/mcp-server-card+json",
        "/.well-known/mcp/server-card.json",
        [
          "where is the Poker Faces MCP server",
          "what public tools can an agent call",
          "how do I read the Poker Faces health check",
        ],
      ),
      entry(
        origin,
        "api",
        "http",
        "Poker Faces HTTP API",
        "application/json",
        "/openapi.json",
        [
          "show the Poker Faces OpenAPI description",
          "how does a person create a private table",
          "which Poker Faces routes are public",
        ],
      ),
      entry(
        origin,
        "skill",
        "index",
        "Poker Faces agent skills",
        "application/json",
        "/.well-known/agent-skills/index.json",
        [
          "which agent skills does Poker Faces publish",
          "how should an agent explain the house rules",
          "where is the skill discovery index",
        ],
      ),
      entry(
        origin,
        "auth",
        "registration",
        "Poker Faces account registration",
        "text/markdown",
        "/auth.md",
        [
          "how does an agent sign a person in to Poker Faces",
          "what credential does the Poker Faces API accept",
          "where is auth.md for Poker Faces",
        ],
      ),
      entry(
        origin,
        "api",
        "catalog",
        "Poker Faces API catalog",
        "application/linkset+json",
        "/.well-known/api-catalog",
        [
          "where is the API catalog",
          "link to the Poker Faces OpenAPI and health endpoint",
          "what documentation describes the HTTP API",
        ],
      ),
    ],
  };
}

export function jsonText(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}
