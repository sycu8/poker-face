import {
  agentSkillsIndex,
  aiCatalog,
  API_CATALOG_TYPE,
  apiCatalog,
  authMarkdown,
  authorizationServerMetadata,
  isHomepagePath,
  jsonText,
  jwks,
  mcpServerCard,
  openApiDocument,
  openIdConfiguration,
  protectedResourceMetadata,
  robotsTxt,
  siteOrigin,
  sitemapXml,
  skillMarkdown,
} from "./documents";
import { isMcpNotification, mcpJsonRpc } from "./mcp";

const EXACT_PATHS = new Set([
  "/robots.txt",
  "/sitemap.xml",
  "/auth.md",
  "/openapi.json",
  "/oauth/token",
  "/mcp",
  "/mcp/server-card",
  "/.well-known/api-catalog",
  "/.well-known/openid-configuration",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  "/.well-known/jwks.json",
  "/.well-known/mcp/server-card.json",
  "/.well-known/ai-catalog.json",
  "/.well-known/agent-skills/index.json",
]);

const SKILL_PATH = /^\/\.well-known\/agent-skills\/([a-z0-9-]+)\/SKILL\.md$/;

export function normalizeDiscoveryPath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

export function isPublicDiscoveryPath(pathname: string): boolean {
  const path = normalizeDiscoveryPath(pathname);
  return EXACT_PATHS.has(path) || SKILL_PATH.test(path);
}

export { isHomepagePath };

function discoveryHeaders(contentType: string, extra?: Record<string, string>): Headers {
  const headers = new Headers(extra);
  headers.set("content-type", contentType);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, HEAD, POST, OPTIONS");
  headers.set("cache-control", "public, max-age=300");
  return headers;
}

function textResponse(
  body: string,
  contentType: string,
  status = 200,
  extra?: Record<string, string>,
): Response {
  return new Response(body, {
    status,
    headers: discoveryHeaders(contentType, extra),
  });
}

function jsonResponse(
  data: unknown,
  contentType = "application/json; charset=utf-8",
  status = 200,
  extra?: Record<string, string>,
): Response {
  return textResponse(jsonText(data), contentType, status, extra);
}

function methodNotAllowed(allow: string): Response {
  return textResponse("Method not allowed.\n", "text/plain; charset=utf-8", 405, {
    allow,
  });
}

function asHead(request: Request, response: Response): Response {
  if (request.method !== "HEAD") return response;
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function discoveryPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
      "access-control-allow-headers":
        "content-type, accept, authorization, mcp-protocol-version",
      "access-control-max-age": "86400",
    },
  });
}

export async function handleDiscovery(
  request: Request,
  appOrigin: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = normalizeDiscoveryPath(url.pathname);
  if (!isPublicDiscoveryPath(path)) return null;

  const origin = siteOrigin(appOrigin, url);
  const method = request.method;

  if (path === "/mcp") {
    if (method === "POST") {
      let parsed: unknown;
      try {
        parsed = await request.clone().json();
      } catch {
        parsed = null;
      }
      if (isMcpNotification(parsed)) {
        return new Response(null, {
          status: 202,
          headers: discoveryHeaders("application/json"),
        });
      }
      const result = await mcpJsonRpc(request, origin);
      const failed = result && typeof result === "object" && "error" in result;
      const code =
        failed && result && typeof result === "object"
          ? (result as { error?: { code?: number } }).error?.code
          : undefined;
      const status = code === -32700 || code === -32600 ? 400 : 200;
      return jsonResponse(result, "application/json; charset=utf-8", status);
    }
    if (method === "GET" || method === "HEAD") {
      return asHead(
        request,
        jsonResponse(
          {
            error: "method_not_allowed",
            error_description:
              "POST JSON-RPC to this endpoint. The server card is at /.well-known/mcp/server-card.json.",
          },
          "application/json; charset=utf-8",
          405,
          { allow: "POST" },
        ),
      );
    }
    return methodNotAllowed("POST");
  }

  if (path === "/oauth/token") {
    if (method !== "POST") return methodNotAllowed("POST");
    return jsonResponse(
      {
        error: "unsupported_grant_type",
        error_description: `Poker Faces does not issue bearer tokens. A person signs in at ${origin}/auth and the API session is the HttpOnly cookie pf_session. See ${origin}/auth.md.`,
      },
      "application/json; charset=utf-8",
      400,
    );
  }

  if (method !== "GET" && method !== "HEAD") return methodNotAllowed("GET, HEAD");

  if (path === "/robots.txt") {
    return asHead(request, textResponse(robotsTxt(origin), "text/plain; charset=utf-8"));
  }
  if (path === "/sitemap.xml") {
    return asHead(
      request,
      textResponse(sitemapXml(origin), "application/xml; charset=utf-8"),
    );
  }
  if (path === "/auth.md") {
    return asHead(
      request,
      textResponse(authMarkdown(origin), "text/markdown; charset=utf-8"),
    );
  }
  if (path === "/openapi.json") {
    return asHead(request, jsonResponse(openApiDocument(origin)));
  }
  if (path === "/.well-known/api-catalog") {
    return asHead(
      request,
      jsonResponse(apiCatalog(origin), API_CATALOG_TYPE, 200, {
        link: `</openapi.json>; rel="service-desc", </auth.md>; rel="service-doc", </api/health>; rel="status"`,
      }),
    );
  }
  if (path === "/.well-known/openid-configuration") {
    return asHead(request, jsonResponse(openIdConfiguration(origin)));
  }
  if (path === "/.well-known/oauth-authorization-server") {
    return asHead(request, jsonResponse(authorizationServerMetadata(origin)));
  }
  if (path === "/.well-known/oauth-protected-resource") {
    return asHead(request, jsonResponse(protectedResourceMetadata(origin)));
  }
  if (path === "/.well-known/jwks.json") {
    return asHead(request, jsonResponse(jwks()));
  }
  if (path === "/.well-known/mcp/server-card.json" || path === "/mcp/server-card") {
    return asHead(
      request,
      jsonResponse(mcpServerCard(origin), "application/mcp-server-card+json"),
    );
  }
  if (path === "/.well-known/ai-catalog.json") {
    return asHead(request, jsonResponse(aiCatalog(origin), "application/json"));
  }
  if (path === "/.well-known/agent-skills/index.json") {
    return asHead(request, jsonResponse(await agentSkillsIndex(origin)));
  }

  const skillMatch = SKILL_PATH.exec(path);
  if (skillMatch) {
    const body = skillMarkdown(skillMatch[1] ?? "");
    if (!body) {
      return asHead(
        request,
        textResponse("Skill not found.\n", "text/plain; charset=utf-8", 404),
      );
    }
    return asHead(request, textResponse(body, "text/markdown; charset=utf-8"));
  }

  return null;
}
