import { SERVER_NAME, SERVER_VERSION } from "./documents";

const PROTOCOL_VERSION = "2025-03-26";

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
};

const TOOLS = [
  {
    name: "poker_faces_health",
    description: "Read the public Poker Faces liveness summary. No account required.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "poker_faces_public_pages",
    description: "List public Poker Faces pages and discovery documents.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "poker_faces_rules",
    description:
      "Summarize play-money Texas Hold'em rules an agent may repeat. Virtual chips only.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
] as const;

function toolResult(text: string, isError = false): unknown {
  return {
    content: [{ type: "text", text }],
    isError,
  };
}

function callTool(name: string, origin: string): unknown {
  if (name === "poker_faces_health") {
    return toolResult(
      JSON.stringify({
        ok: true,
        service: "poker-faces",
        tagline: "Your table. Your people.",
        health: `${origin}/api/health`,
      }),
    );
  }
  if (name === "poker_faces_public_pages") {
    return toolResult(
      [
        `${origin}/`,
        `${origin}/auth`,
        `${origin}/robots.txt`,
        `${origin}/sitemap.xml`,
        `${origin}/auth.md`,
        `${origin}/openapi.json`,
        `${origin}/.well-known/api-catalog`,
        `${origin}/.well-known/ai-catalog.json`,
      ].join("\n"),
    );
  }
  if (name === "poker_faces_rules") {
    return toolResult(
      [
        "Private play-money Texas Hold'em. Virtual chips only.",
        "Two hole cards stay private to that player.",
        "Big blind is twice the small blind.",
        "Starting stacks are 10 to 1000 chips.",
        "The host approves who sits down.",
      ].join(" "),
    );
  }
  return toolResult(`Unknown tool: ${name}`, true);
}

function rpc(id: string | number | null, result: unknown): unknown {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export async function mcpJsonRpc(request: Request, origin: string): Promise<unknown> {
  let message: JsonRpcRequest;
  try {
    message = (await request.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, "Parse error");
  }
  const id = message.id ?? null;
  const method = message.method ?? "";
  if (!method) return rpcError(id, -32600, "Invalid request");

  if (method === "initialize") {
    return rpc(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === "ping") return rpc(id, {});
  if (method === "tools/list") return rpc(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = message.params?.name ?? "";
    return rpc(id, callTool(name, origin));
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

export function isMcpNotification(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const message = body as JsonRpcRequest;
  return typeof message.method === "string" && !Object.hasOwn(message, "id");
}
