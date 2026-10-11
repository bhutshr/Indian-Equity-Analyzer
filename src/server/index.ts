import {
  Agent,
  routeAgentRequest,
  type Connection,
  type ConnectionContext,
  type WSMessage,
} from "agents";
import { streamText, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import { createWorkersAI } from "workers-ai-provider";

type Role = "user" | "assistant";

interface StoredMessage {
  id: string;
  role: Role;
  content: string;
  created_at: number;
}

const MODEL = "@cf/zai-org/glm-4.7-flash";
const MAX_STEPS = 6;

const MCP_SERVERS = [
  {
    id: "bhavcopy",
    name: "NSE Bhavcopy (historical OHLCV)",
    url: "https://mcp.nseindia.in/bhavcopy/cm/mcp",
  },
  {
    id: "cmmkt",
    name: "NSE Live Capital Market",
    url: "https://mcp.nseindia.in/cmmkt/mcp",
  },
] as const;

// 13 of 36. Tool-selection accuracy collapses when you hand a small model
// everything. Expand this deliberately, not by default.
const ALLOWED_TOOLS = new Set([
  "nse_lookup_symbol",
  "get_stock_history",
  "get_52_week_high_low",
  "moving_average",
  "get_volume_analysis",
  "compare_stocks",
  "get_top_movers",
  "get_market_breadth",
  "get_stock_vs_index",
  "cm_get_stock_quote",
  "cm_get_live_gainers",
  "cm_get_live_losers",
  "cm_get_index_quote",
]);

/** Keys arrive namespaced as `tool_<serverId>_<name>`; match either form. */
function pickTools(all: ToolSet, allow: Set<string>): ToolSet {
  const out: ToolSet = {};
  for (const [key, value] of Object.entries(all)) {
    for (const name of allow) {
      if (key === name || key.endsWith(`_${name}`)) {
        out[key] = value;
        break;
      }
    }
  }
  return out;
}

/** NSE trades in IST. Shift then slice the UTC date portion. */
function todayIST(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function systemPrompt(): string {
  return `You are an NSE (India) equity research analyst agent.

TODAY'S DATE (IST): ${todayIST()}
Always use this date for "today", "latest", or "current". Never guess a date.

TOOL RULES
- Every parameter is REQUIRED by schema, even ones the description calls optional.
  Pass the documented sentinel rather than omitting: endDate "today", months 0 for default.
- Resolve tickers with nse_lookup_symbol before any symbol-based call.
  Users say "Tata Motors"; the tools need "TATAMOTORS".
- Use cm_* tools for live/intraday data, bhavcopy tools for history.
- If a tool errors, read the message, correct the arguments, retry ONCE. Never loop.

METHOD
1. Resolve symbols.
2. Gather data — combine live and historical where it helps.
3. Analyse: trend, volume, 52-week position, performance vs index.
4. Answer with concrete numbers and the dates they came from.

OUTPUT
- Lead with the direct answer, then the supporting data.
- Always state the as-of date of your data.
- Prices are unadjusted: flag that splits/bonuses can distort % changes.
- Educational information only. Not investment advice.`;
}

export class ResearchAgent extends Agent<Env> {
  async onStart() {
    this.sql`
      CREATE TABLE IF NOT EXISTS messages (
        id         TEXT    PRIMARY KEY,
        role       TEXT    NOT NULL,
        content    TEXT    NOT NULL,
        created_at INTEGER NOT NULL
      )
    `;

    for (const s of MCP_SERVERS) {
      try {
        await this.addMcpServer(s.name, s.url, {
          id: s.id,
          transport: { type: "streamable-http" },
        });
      } catch (err) {
        console.error(`[mcp] ${s.id} connect failed:`, err);
      }
    }
  }

  private history(): StoredMessage[] {
    return this.sql<StoredMessage>`
      SELECT id, role, content, created_at FROM messages ORDER BY created_at ASC
    `;
  }

  private save(role: Role, content: string): StoredMessage {
    const msg: StoredMessage = {
      id: crypto.randomUUID(),
      role,
      content,
      created_at: Date.now(),
    };
    this.sql`
      INSERT INTO messages (id, role, content, created_at)
      VALUES (${msg.id}, ${msg.role}, ${msg.content}, ${msg.created_at})
    `;
    return msg;
  }

  private emit(connection: Connection, event: unknown) {
    connection.send(JSON.stringify(event));
  }

  async onConnect(connection: Connection, _ctx: ConnectionContext) {
    this.emit(connection, { type: "history", messages: this.history() });
  }

  async onMessage(connection: Connection, message: WSMessage) {
    if (typeof message !== "string") return;
    let parsed: { type?: string; content?: string };
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (parsed.type !== "chat" || !parsed.content) return;

    const userMsg = this.save("user", parsed.content);
    this.emit(connection, { type: "message", message: userMsg });

    try {
      await this.research(connection);
    } catch (err) {
      console.error("[agent] research failed:", err);
      this.emit(connection, { type: "error", error: String(err) });
    }
  }

  private async research(connection: Connection) {
    await this.mcp.waitForConnections({ timeout: 15_000 });

    const tools = pickTools(
      this.mcp.getAITools({ state: "ready" }) as ToolSet,
      ALLOWED_TOOLS
    );
    this.emit(connection, {
      type: "status",
      stage: "thinking",
      toolCount: Object.keys(tools).length,
    });

    const workersai = createWorkersAI({ binding: this.env.AI });
    const messages: ModelMessage[] = this.history().map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const result = streamText({
      model: workersai(MODEL),
      system: systemPrompt(),
      messages,
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
    });

    let answer = "";

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          answer += part.text;
          this.emit(connection, { type: "delta", text: part.text });
          break;
        case "reasoning-delta":
          this.emit(connection, { type: "reasoning", text: part.text });
          break;
        case "tool-call":
          console.log(`[tool] → ${part.toolName}`, JSON.stringify(part.input));
          this.emit(connection, {
            type: "tool-call",
            toolCallId: part.toolCallId,
            name: part.toolName,
            input: part.input,
          });
          break;
        case "tool-result":
          console.log(`[tool] ← ${part.toolName} ok`);
          this.emit(connection, {
            type: "tool-result",
            toolCallId: part.toolCallId,
            name: part.toolName,
            output: part.output,
          });
          break;
        case "tool-error":
          console.error(`[tool] ✗ ${part.toolName}:`, part.error);
          this.emit(connection, {
            type: "tool-error",
            name: part.toolName,
            error: String(part.error),
          });
          break;
        case "error":
          console.error("[stream]", part.error);
          this.emit(connection, { type: "error", error: String(part.error) });
          break;
      }
    }

    const saved = this.save("assistant", answer || "(no answer produced)");
    this.emit(connection, { type: "done", message: saved });
  }

  async onRequest(request: Request) {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/aitools")) {
      await this.mcp.waitForConnections({ timeout: 15_000 });
      const all = this.mcp.getAITools({ state: "ready" }) as ToolSet;
      const picked = pickTools(all, ALLOWED_TOOLS);
      return Response.json({
        today: todayIST(),
        model: MODEL,
        discovered: Object.keys(all).length,
        selected: Object.keys(picked).length,
        selectedKeys: Object.keys(picked),
        allKeys: Object.keys(all),
      });
    }

    if (url.pathname.endsWith("/tools")) {
      await this.mcp.waitForConnections({ timeout: 15_000 });
      const state = this.getMcpServers();
      return Response.json({
        servers: Object.fromEntries(
          Object.entries(state.servers).map(([id, s]) => [
            id,
            { name: s.name, state: s.state, error: s.error },
          ])
        ),
        toolCount: state.tools.length,
      });
    }

    return Response.json({
      instance: this.name,
      count: this.history().length,
      history: this.history(),
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;