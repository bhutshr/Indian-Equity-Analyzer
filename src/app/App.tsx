import { useState } from "react";

export default function App() {
  const [result, setResult] = useState<string>("");

  async function ping() {
    const res = await fetch("/agents/research-agent/session-42");
    setResult(await res.text());
  }

  return (
    <main style={{ fontFamily: "system-ui", padding: 32 }}>
      <h1>Indian Equity Analyzer</h1>
      <button onClick={ping}>Ping agent</button>
      <pre>{result}</pre>
    </main>
  );
}