import React, { useState, useEffect, useRef } from "react";
import { useChat } from "@ai-sdk/react";

type ToolEntry = { slug: string; description: string };

export default function App() {
  const { messages, input, handleInputChange, handleSubmit, isLoading, error } =
    useChat({ api: "/api/chat" });

  const [activeTool, setActiveTool] = useState("loading...");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [allTools, setAllTools] = useState<ToolEntry[]>([]);
  const [search, setSearch] = useState("");
  const [connections, setConnections] = useState<Record<string, boolean>>({});
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages]);

  useEffect(() => {
    fetch("/api/tool").then((r) => r.json()).then((d) => setActiveTool(d.slug));
  }, []);

  async function openPicker() {
    setPickerOpen(true);
    setSearch("");
    if (allTools.length === 0) {
      const res = await fetch("/api/tools");
      const data = await res.json();
      setAllTools(data.tools || []);
    }
  }

  async function selectTool(slug: string) {
    setPickerOpen(false);
    setActiveTool("loading...");
    const res = await fetch("/api/tool/set", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    const data = await res.json();
    setActiveTool(data.error ? "error" : data.slug);
  }

  async function connect(toolkit: string) {
    const res = await fetch(`/api/connect/${toolkit}`, { method: "POST" });
    const data = await res.json();
    if (data.redirectUrl) {
      window.open(data.redirectUrl, "_blank", "width=600,height=700");
      // wait for OAuth to complete server-side
      const waitRes = await fetch(`/api/connect/${toolkit}/wait`, { method: "POST" });
      const waitData = await waitRes.json();
      if (waitData.connected) {
        setConnections((c) => ({ ...c, [toolkit]: true }));
      }
    }
  }

  const filtered = search
    ? allTools.filter(
        (t) =>
          t.slug.toLowerCase().includes(search.toLowerCase()) ||
          t.description.toLowerCase().includes(search.toLowerCase())
      )
    : allTools;

  return (
    <>
      <header>
        <h1>mini rube</h1>
        <div className="header-right">
          {["googlesuper", "github"].map((tk) => (
            <button
              key={tk}
              className={`connect-btn${connections[tk] ? " connected" : ""}`}
              onClick={() => connect(tk)}
            >
              {connections[tk] ? `${tk} connected` : `Connect ${tk}`}
            </button>
          ))}
        </div>
      </header>

      <div className="tool-bar">
        <label>Active tool:</label>
        <span className="active-tool">{activeTool}</span>
        <button onClick={openPicker}>Change</button>
      </div>

      <div className="chat" ref={chatRef}>
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.content}
          </div>
        ))}
        {error && <div className="msg error">{error.message}</div>}
      </div>

      <form className="input-bar" onSubmit={handleSubmit}>
        <input
          value={input}
          onChange={handleInputChange}
          placeholder="Ask me anything..."
          autoComplete="off"
          disabled={isLoading}
        />
        <button type="submit" disabled={isLoading || !input.trim()}>
          Send
        </button>
      </form>

      {pickerOpen && (
        <div className="tool-picker-overlay" onClick={() => setPickerOpen(false)}>
          <div className="tool-picker" onClick={(e) => e.stopPropagation()}>
            <div className="tool-picker-header">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search tools..."
                autoFocus
              />
              <button className="close-btn" onClick={() => setPickerOpen(false)}>
                &times;
              </button>
            </div>
            <div className="tool-list">
              {allTools.length === 0 ? (
                <div className="tool-list-loading">Loading tools...</div>
              ) : filtered.length === 0 ? (
                <div className="tool-list-loading">No tools found</div>
              ) : (
                filtered.slice(0, 100).map((t) => (
                  <div
                    key={t.slug}
                    className={`tool-item${t.slug === activeTool ? " active" : ""}`}
                    onClick={() => selectTool(t.slug)}
                  >
                    <div className="slug">{t.slug}</div>
                    <div className="desc">{t.description.slice(0, 100)}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
