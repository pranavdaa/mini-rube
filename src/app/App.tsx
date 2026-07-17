import React, { useState, useEffect, useRef, useMemo } from "react";
import { useChat } from "@ai-sdk/react";
import { ALLOWED_ATTACHMENT_CONTENT_TYPE, MAX_ATTACHMENT_BYTES } from "../lib/attachment-limits";
import StepRows from "./StepRows";
import type { UiEvent } from "../lib/ui-events";

type ToolEntry = { slug: string; description: string };

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)}MB` : `${Math.ceil(bytes / 1024)}KB`;
}

/**
 * The five prompts the assignment names, offered verbatim.
 *
 * An empty chat gives no clue what this can do, and these are exactly what an
 * evaluator arrives wanting to try. They fill the composer rather than sending,
 * so the wording can be edited first — testing a *variation* is the point.
 */
const SUGGESTIONS = [
  { label: "Read my last 100 emails and show the important ones", emoji: "📥" },
  { label: "Schedule a calendar event tomorrow with karan", emoji: "📅" },
  { label: "Read all issues on composiohq/composio and make a Google Sheet of the problems", emoji: "🐙" },
  {
    label:
      "Take all the resumes in this drive and make a Google Sheet with candidate names, uni and last job https://drive.google.com/drive/folders/1bOEE3JXX-iFqbY99VTRq1ak-UOQULc5r",
    emoji: "📄",
  },
  { label: "Send an email with the attached pdf", emoji: "📎" },
];

export default function App() {
  // The browser's own IANA timezone — a stronger signal than the server's,
  // which is never the user's. Sent with every turn so the agent resolves
  // "tomorrow"/"3pm" against where the user actually is.
  const { messages, input, setInput, handleInputChange, handleSubmit, isLoading, error, data } = useChat({
    api: "/api/chat",
    body: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
  });

  const [catalogOpen, setCatalogOpen] = useState(false);
  const [allTools, setAllTools] = useState<ToolEntry[]>([]);
  const [catalogTotal, setCatalogTotal] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [connections, setConnections] = useState<Record<string, boolean>>({});
  const [toolkits, setToolkits] = useState<string[]>([]);
  const [connecting, setConnecting] = useState<string | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);

  // PDF attachment: the file input is the source of truth (its FileList goes
  // straight to useChat's experimental_attachments); this state is only for
  // rendering the filename chip and errors.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachment, setAttachment] = useState<{ name: string; size: number } | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);

  // Activity events arrive on useChat's `data` side channel, tagged with the
  // turn that produced them, so each block renders under its own message
  // instead of piling up at the bottom.
  const eventsByTurn = useMemo(() => {
    const byTurn = new Map<number, UiEvent[]>();
    for (const d of (data ?? []) as unknown as UiEvent[]) {
      if (!d || typeof d !== "object" || typeof (d as any).turn !== "number") continue;
      const list = byTurn.get(d.turn) ?? [];
      list.push(d);
      byTurn.set(d.turn, list);
    }
    return byTurn;
  }, [data]);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, data]);

  /**
   * Connection state belongs to the server, not this component. Asking on mount
   * is what makes an existing connection survive a page reload — without it the
   * button reports "not connected" for an account that works fine.
   */
  async function refreshConnections() {
    const res = await fetch("/api/connections");
    const data = await res.json();
    if (data.error) return;
    setToolkits(data.toolkits ?? []);
    setConnections(data.connections ?? {});
  }

  useEffect(() => {
    refreshConnections();
  }, []);

  // The catalog size is the system's headline fact — 1,362 tools is why a
  // router has to exist — so it's fetched up front to label the pill.
  useEffect(() => {
    fetch("/api/tools")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) return;
        setAllTools(d.tools ?? []);
        setCatalogTotal(d.total ?? d.tools?.length ?? null);
      })
      .catch(() => {});
  }, []);

  async function connect(toolkit: string) {
    setConnecting(toolkit);
    try {
      const res = await fetch(`/api/connect/${toolkit}`, { method: "POST" });
      const data = await res.json();
      if (!data.redirectUrl) return;

      window.open(data.redirectUrl, "_blank", "width=600,height=700");
      // wait for OAuth to complete server-side
      const waitRes = await fetch(`/api/connect/${toolkit}/wait`, { method: "POST" });
      const waitData = await waitRes.json();
      // Re-read from the server rather than assuming success: it is the only
      // thing that actually knows, and it keeps one source of truth.
      if (waitData.connected) await refreshConnections();
    } finally {
      setConnecting(null);
    }
  }

  function clearAttachment() {
    if (fileInputRef.current) fileInputRef.current.value = "";
    setAttachment(null);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setAttachError(null);
    if (!file) {
      setAttachment(null);
      return;
    }
    if (file.type !== ALLOWED_ATTACHMENT_CONTENT_TYPE) {
      setAttachError("Only PDF files can be attached.");
      clearAttachment();
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setAttachError(`"${file.name}" is over the ${formatBytes(MAX_ATTACHMENT_BYTES)} limit.`);
      clearAttachment();
      return;
    }
    setAttachment({ name: file.name, size: file.size });
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    const files = fileInputRef.current?.files;
    handleSubmit(e, files && files.length > 0 ? { experimental_attachments: files } : undefined);
    clearAttachment();
  }

  const filtered = search
    ? allTools.filter(
        (t) =>
          t.slug.toLowerCase().includes(search.toLowerCase()) ||
          t.description.toLowerCase().includes(search.toLowerCase())
      )
    : allTools;

  const empty = messages.length === 0;

  return (
    <>
      <header>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">mini rube</span>
        </div>

        <div className="header-right">
          <button
            type="button"
            className="catalog-pill"
            onClick={() => setCatalogOpen(true)}
            title="Browse the tool catalog the router searches"
          >
            composio · {catalogTotal ? catalogTotal.toLocaleString() : "…"} tools
          </button>
          {toolkits.map((tk) => (
            <button
              key={tk}
              className={`connect-btn${connections[tk] ? " connected" : ""}`}
              onClick={() => connect(tk)}
              disabled={connecting === tk}
            >
              {connecting === tk ? `Connecting ${tk}…` : connections[tk] ? `${tk} connected` : `Connect ${tk}`}
            </button>
          ))}
        </div>
      </header>

      <div className={`chat${empty ? " is-empty" : ""}`} ref={chatRef}>
        {empty ? (
          <div className="empty-state">
            <h2 className="empty-title">
              Get <em>something</em> done today, agent!
            </h2>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s.label} type="button" className="suggestion" onClick={() => setInput(s.label)}>
                  <span className="suggestion-text">{s.label}</span>
                  <span className="suggestion-emoji">{s.emoji}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          (() => {
            // Turns are numbered by user message (the server counts the same
            // way), so a block can be placed directly after the message it
            // belongs to.
            let turn = 0;
            return messages.map((m) => {
              if (m.role === "user") turn++;
              const steps = m.role === "user" ? eventsByTurn.get(turn) : undefined;
              return (
                <React.Fragment key={m.id}>
                  <div className={`msg ${m.role}`}>
                    {m.experimental_attachments?.map((a, i) => (
                      <div key={i} className="attachment-chip in-message">
                        {a.name ?? "attachment"}
                      </div>
                    ))}
                    {m.content}
                  </div>
                  {steps && <StepRows events={steps} onConnect={connect} />}
                </React.Fragment>
              );
            });
          })()
        )}
        {error && <div className="msg error">{error.message}</div>}
      </div>

      <div className="composer-wrap">
        <form className="composer" onSubmit={onSubmit}>
          <input
            type="file"
            accept={ALLOWED_ATTACHMENT_CONTENT_TYPE}
            ref={fileInputRef}
            onChange={handleFileChange}
            className="file-input-hidden"
          />

          {attachment && (
            <div className="attachment-chip">
              <span className="attachment-name">{attachment.name}</span>
              <span className="attachment-size">{formatBytes(attachment.size)}</span>
              <button
                type="button"
                className="attachment-remove"
                onClick={clearAttachment}
                aria-label="Remove attachment"
              >
                &times;
              </button>
            </div>
          )}
          {attachError && <div className="attach-error">{attachError}</div>}

          <input
            className="composer-input"
            value={input}
            onChange={handleInputChange}
            placeholder="Hey mini-rube, can you…"
            autoComplete="off"
            disabled={isLoading}
          />

          <div className="composer-footer">
            <div className="composer-hint">
              <button
                type="button"
                className="attach-btn"
                title="Attach a PDF"
                onClick={() => fileInputRef.current?.click()}
                disabled={isLoading}
              >
                Attach PDF
              </button>
              <span className="hint-sep">·</span>
              <span>search {catalogTotal ? catalogTotal.toLocaleString() : ""} tools → select → execute</span>
              <span className="hint-sep">·</span>
              <span>every ranking explainable</span>
            </div>
            <button
              type="submit"
              className="send-btn"
              // Disabled while a turn is in flight: an export runs for minutes,
              // and a second send would start a whole duplicate job.
              disabled={isLoading || !input.trim()}
              aria-label="Send"
            >
              {isLoading ? <span className="send-spinner" /> : "↑"}
            </button>
          </div>
        </form>
      </div>

      {catalogOpen && (
        <div className="catalog-overlay" onClick={() => setCatalogOpen(false)}>
          <div className="catalog" onClick={(e) => e.stopPropagation()}>
            <div className="catalog-header">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search the catalog…"
                autoFocus
              />
              <button className="close-btn" onClick={() => setCatalogOpen(false)} aria-label="Close">
                &times;
              </button>
            </div>
            <div className="catalog-note">
              Every tool the router searches on each turn. Browsing only — the agent picks its own tools per request.
            </div>
            <div className="catalog-list">
              {allTools.length === 0 ? (
                <div className="catalog-loading">Loading catalog…</div>
              ) : filtered.length === 0 ? (
                <div className="catalog-loading">No tools match “{search}”.</div>
              ) : (
                <>
                  {filtered.slice(0, 100).map((t) => (
                    <div key={t.slug} className="catalog-item">
                      <div className="slug">{t.slug}</div>
                      <div className="desc">{t.description.slice(0, 120)}</div>
                    </div>
                  ))}
                  {filtered.length > 100 && (
                    <div className="catalog-loading">
                      Showing 100 of {filtered.length.toLocaleString()} matches — refine your search to see more.
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
