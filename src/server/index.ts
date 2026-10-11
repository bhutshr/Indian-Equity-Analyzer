import {Agent, routeAgentRequest, type Connection,type ConnectionContext,type WSMessage } from "agents";


type Role = "user" | "assistant";

interface StoredMessage{
    id:string;
    role: Role;
    content:string;
    created_at:number;
}

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
      SELECT id, role, content, created_at
      FROM messages
      ORDER BY created_at ASC
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

async onConnect(connection: Connection, _ctx: ConnectionContext) {
    // Replay this session's memory to a (re)connecting client
    connection.send(
      JSON.stringify({ type: "history", messages: this.history() })
    );
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
    connection.send(JSON.stringify({ type: "message", message: userMsg }));

    await this.mcp.waitForConnections({ timeout: 10_000 });
    const tools = this.mcp.listTools();
    const reply = this.save(
      "assistant",
      `I have ${tools.length} NSE tools available. (Reasoning loop lands in Step 6.)`
    );
    connection.send(JSON.stringify({ type: "message", message: reply }));
  }

  async onRequest(request: Request) {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/tools")) {
      await this.mcp.waitForConnections({ timeout: 10_000 });
      const state = this.getMcpServers();
      return Response.json({
        servers: Object.fromEntries(
          Object.entries(state.servers).map(([id, s]) => [
            id,
            { name: s.name, state: s.state, error: s.error },
          ])
        ),
        toolCount: state.tools.length,
        tools: state.tools.map((t) => `${t.serverId}/${t.name}`),
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