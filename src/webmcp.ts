import { PUBLIC_PAGE_PATHS, publicPageOrNull } from "./publicPages";

type JsonSchema = Record<string, unknown>;

type ToolResult = { text: string };

type WebMcpTool = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute: (input: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
};

type ModelContext = {
  registerTool: (
    tool: WebMcpTool,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown>;
};

function modelContext(): ModelContext | undefined {
  const doc = document as Document & { modelContext?: ModelContext };
  const nav = navigator as Navigator & { modelContext?: ModelContext };
  return doc.modelContext ?? nav.modelContext;
}

const pageSchema: JsonSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      enum: [...PUBLIC_PAGE_PATHS],
      description: "Public Poker Faces path to open.",
    },
  },
  required: ["path"],
  additionalProperties: false,
};

function tools(): WebMcpTool[] {
  return [
    {
      name: "list_public_pages",
      description:
        "List public Poker Faces pages an agent may open. Private tables are not included.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: () => ({
        text: PUBLIC_PAGE_PATHS.join("\n"),
      }),
    },
    {
      name: "open_public_page",
      description: "Open a public Poker Faces page in this tab.",
      inputSchema: pageSchema,
      execute: (input) => {
        const path = publicPageOrNull(String(input.path ?? ""));
        if (!path) return { text: "That path is not a public Poker Faces page." };
        window.location.assign(path);
        return { text: `Opening ${path}` };
      },
    },
    {
      name: "explain_play_money_rules",
      description:
        "Summarize Poker Faces house rules: private play-money Texas Hold'em, virtual chips only.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: () => ({
        text: "Private play-money Texas Hold'em. Virtual chips only. Two hole cards stay private. The big blind is twice the small blind. The host approves who joins.",
      }),
    },
    {
      name: "read_public_config",
      description: "Fetch public site copy and which social logins are enabled.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async () => {
        const response = await fetch("/api/config");
        const body = await response.text();
        return { text: body };
      },
    },
  ];
}

async function registerAll(ctx: ModelContext, signal: AbortSignal): Promise<void> {
  await Promise.all(tools().map((tool) => ctx.registerTool(tool, { signal })));
}

/** Register WebMCP tools on page load. Retries briefly if the host injects modelContext late. */
export function installWebMcp(): () => void {
  const controller = new AbortController();
  let registered = false;

  const tryRegister = () => {
    if (registered || controller.signal.aborted) return;
    const ctx = modelContext();
    if (!ctx?.registerTool) return;
    registered = true;
    void registerAll(ctx, controller.signal).catch(() => {
      registered = false;
    });
  };

  tryRegister();
  const timer = window.setInterval(() => {
    tryRegister();
    if (registered) window.clearInterval(timer);
  }, 250);
  const stop = window.setTimeout(() => window.clearInterval(timer), 3000);

  return () => {
    controller.abort();
    window.clearInterval(timer);
    window.clearTimeout(stop);
  };
}
