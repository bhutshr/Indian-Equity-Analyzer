import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Msg = { id: string; role: "user" | "assistant"; content: string };
type ToolEvent = {
  id: string;
  name: string;
  input?: unknown;
  status: "running" | "done" | "error";
  error?: string;
};

const prettyTool = (raw: string) => raw.replace(/^tool_[a-z0-9-]+_/i, "");

const SAMPLES = [
  "What is the live quote for RELIANCE?",
  "How has TCS performed over 3 months vs NIFTY 50?",
  "Top 5 gainers on NSE today",
  "Is HDFCBANK near its 52-week high?",
];

export default function App() {
  const [sessionId] = useState(() => {
    const key = "iea-session";
    let v = localStorage.getItem(key);
    if (!v) {
      v = crypto.randomUUID().slice(0, 8);
      localStorage.setItem(key, v);
    }
    return v;
  });

  const [messages, setMessages] = useState<Msg[]>([]);
  const [streaming, setStreaming] = useState("");
  const [tools, setTools] = useState<ToolEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [mcp, setMcp] = useState<{ name: string; state: string }[]>([]);
  const [input, setInput] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  const agent = useAgent({
    agent: "research-agent",
    name: sessionId,
    onMcpUpdate: (s) =>
      setMcp(
        Object.values(s.servers).map((x: any) => ({
          name: x.name,
          state: x.state,
        }))
      ),
    onMessage: (event: MessageEvent) => {
      let m: any;
      try {
        m = JSON.parse(event.data);
      } catch {
        return;
      }
      switch (m.type) {
        case "history":
          setMessages(m.messages ?? []);
          break;
        case "message":
          setMessages((p) => [...p, m.message]);
          break;
        case "status":
          setBusy(true);
          setTools([]);
          break;
        case "delta":
          setStreaming((p) => p + m.text);
          break;
        case "tool-call":
          setTools((p) => [
            ...p,
            {
              id: m.toolCallId,
              name: prettyTool(m.name),
              input: m.input,
              status: "running",
            },
          ]);
          break;
        case "tool-result":
          setTools((p) =>
            p.map((t) => (t.id === m.toolCallId ? { ...t, status: "done" } : t))
          );
          break;
        case "tool-error":
          setTools((p) =>
            p.map((t) =>
              t.name === prettyTool(m.name)
                ? { ...t, status: "error", error: m.error }
                : t
            )
          );
          break;
        case "done":
          setMessages((p) => [...p, m.message]);
          setStreaming("");
          setBusy(false);
          break;
        case "error":
          setStreaming("");
          setBusy(false);
          setMessages((p) => [
            ...p,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content: `⚠️ ${m.error}`,
            },
          ]);
          break;
      }
    },
  });

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming, tools]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || busy) return;
    agent.send(JSON.stringify({ type: "chat", content: text }));
    setInput("");
  }, [input, busy, agent]);

  return (
    <div className="app">
      <header>
        <div>
          <h1>Indian Equity Analyzer</h1>
          <span className="sub">NSE research agent · session {sessionId}</span>
        </div>
        <div className="mcp">
          {mcp.map((s) => (
            <span key={s.name} className={`pill ${s.state}`}>
              <i /> {s.name}
            </span>
          ))}
        </div>
      </header>

      <main>
        {messages.length === 0 && !streaming && (
          <div className="empty">
            <p>Ask about any NSE-listed stock.</p>
            <div className="samples">
              {SAMPLES.map((s) => (
                <button key={s} onClick={() => setInput(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <div className="bubble">
              {m.role === "assistant" ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {m.content}
                </ReactMarkdown>
              ) : (
                m.content
              )}
            </div>
          </div>
        ))}

        {tools.length > 0 && (
          <div className="timeline">
            {tools.map((t) => (
              <div key={t.id} className={`step ${t.status}`}>
                <span className="dot" />
                <code>{t.name}</code>
                {t.input ? (
                  <small>{JSON.stringify(t.input)}</small>
                ) : null}
                {t.error ? <small className="err">{t.error}</small> : null}
              </div>
            ))}
          </div>
        )}

        {streaming && (
          <div className="msg assistant">
            <div className="bubble">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {streaming}
              </ReactMarkdown>
            </div>
          </div>
        )}

        {busy && !streaming && <div className="thinking">Researching…</div>}
        <div ref={bottom} />
      </main>

      <footer>
        <input
          value={input}
          placeholder="e.g. Compare INFY and TCS over 6 months"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          disabled={busy}
        />
        <button onClick={send} disabled={busy || !input.trim()}>
          {busy ? "…" : "Ask"}
        </button>
      </footer>
    </div>
  );
}