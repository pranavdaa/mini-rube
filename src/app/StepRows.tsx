import React, { useState } from "react";
import type { UiEvent } from "../lib/ui-events";

/**
 * The turn's activity, rendered as step rows.
 *
 * This is the window into what the agent actually did: which catalog it
 * searched, how many candidates it weighed, what it chose and why, and how a
 * long export is progressing. Without it the router — the whole point of the
 * system — is invisible, and a two-minute export looks like a hang.
 *
 * Everything here arrives pre-sanitized from the server (see ui-events.ts).
 * This component adds no redaction of its own and must not be trusted to.
 */

function Row({
  status,
  title,
  detail,
  children,
}: {
  status: "running" | "ok" | "failed" | "info" | "warn";
  title: React.ReactNode;
  detail?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className={`step-row step-${status}`}>
      <span className="step-dot" aria-hidden="true" />
      <div className="step-body">
        <div className="step-title">{title}</div>
        {detail && <div className="step-detail">{detail}</div>}
        {children}
      </div>
    </div>
  );
}

/** Collapsible raw payload. Collapsed by default: the plain answer is the point. */
function RawBlock({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="raw-block">
      <button type="button" className="raw-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? "▾" : "▸"} raw
      </button>
      {open && <pre className="raw-json">{JSON.stringify(value, null, 2)}</pre>}
    </div>
  );
}

function Progress({ e }: { e: Extract<UiEvent, { kind: "job" }> }) {
  // `discovered` is only final once discovery ends, so a percentage during
  // discovery would climb and then jump backwards. Show a count until there is
  // a real denominator.
  const total = e.discovered || 0;
  const done = e.processed || 0;
  const pct = e.phase !== "discovering" && total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;

  return (
    <div className="job-progress">
      <div className="job-counts">
        <span className="job-phase">{e.phase}</span>
        <span>discovered {e.discovered}</span>
        <span>processed {e.processed}</span>
        <span className="ok-count">ok {e.succeeded}</span>
        <span className={e.failed ? "fail-count" : ""}>failed {e.failed}</span>
        <span>rows {e.written}</span>
      </div>
      <div className="job-bar">
        <div
          className={`job-bar-fill${pct === null ? " indeterminate" : ""}`}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
      {pct !== null && (
        <div className="job-pct">
          {done} / {total} ({pct}%)
        </div>
      )}
    </div>
  );
}

export default function StepRows({ events, onConnect }: { events: UiEvent[]; onConnect?: (tk: string) => void }) {
  if (!events.length) return null;

  const searching = events.some((e) => e.kind === "route" && e.phase === "searching");
  const selected = events.find((e) => e.kind === "route" && e.phase === "selected") as
    | Extract<UiEvent, { kind: "route"; phase: "selected" }>
    | undefined;

  // Latest progress per tool: a job emits continuously, and only the newest
  // state is meaningful.
  const jobs = new Map<string, Extract<UiEvent, { kind: "job" }>>();
  for (const e of events) if (e.kind === "job") jobs.set(e.slug, e);

  // Collapse each tool's exec lifecycle to its latest state, preserving order.
  const execs = new Map<string, Extract<UiEvent, { kind: "exec" }>>();
  for (const e of events) if (e.kind === "exec") execs.set(e.slug, e);

  const auths = events.filter((e): e is Extract<UiEvent, { kind: "auth" }> => e.kind === "auth");
  const attachments = events.filter((e): e is Extract<UiEvent, { kind: "attachment" }> => e.kind === "attachment");

  return (
    <div className="steps">
      {attachments.map((a, i) => (
        <Row
          key={`att-${i}`}
          status="info"
          title={
            <>
              Attached <span className="chip">{a.name}</span>
            </>
          }
          detail={`will be sent as ${a.slug}.${a.field}`}
        />
      ))}

      {searching && !selected && <Row status="running" title="Searching tools…" detail="ranking the tool catalog" />}

      {selected && (
        <Row
          status="ok"
          title="Searched tools"
          detail={
            <>
              {selected.searched.toLocaleString()} tools in catalog · {selected.candidates} candidates considered ·{" "}
              {selected.selected.length} selected
              <span className="confirm-src"> (stage 2: {selected.confirmSource})</span>
            </>
          }
        >
          <ul className="tool-list">
            {selected.selected.map((t) => (
              <li key={t.slug}>
                <code className="tool-slug">{t.slug}</code>
                <span className="tool-kit">{t.toolkit}</span>
                {t.reason && <div className="tool-reason">{t.reason}</div>}
              </li>
            ))}
          </ul>
        </Row>
      )}

      {auths.map((a) => (
        <Row
          key={`auth-${a.toolkit}`}
          status="warn"
          title={`${a.toolkit} is not connected`}
          detail="This request needs it. Connect the account, then send the message again."
        >
          {onConnect && (
            <button type="button" className="step-connect-btn" onClick={() => onConnect(a.toolkit)}>
              Connect {a.toolkit}
            </button>
          )}
        </Row>
      ))}

      {[...execs.values()].map((e) => {
        const job = jobs.get(e.slug);
        const done = e.status !== "running";
        return (
          <Row
            key={`exec-${e.slug}`}
            status={e.status === "running" ? "running" : e.status}
            title={
              <>
                {e.status === "running" ? "Executing" : e.status === "ok" ? "Executed" : "Failed"}{" "}
                <code className="tool-slug">{e.slug}</code>
                {done && "ms" in e && <span className="step-ms">{formatMs(e.ms)}</span>}
              </>
            }
            detail={e.status === "failed" && "error" in e ? e.error : undefined}
          >
            {job && <Progress e={job} />}
            {job?.outputUrl && (
              <a className="sheet-link" href={job.outputUrl} target="_blank" rel="noreferrer">
                Open Google Sheet ↗
              </a>
            )}
            {done && "compacted" in e && e.compacted && (
              <div className="compact-note">
                Result shrunk {e.compacted.from.toLocaleString()} → {e.compacted.to.toLocaleString()} chars before the
                model saw it (dropped: {e.compacted.dropped.join(", ") || "none"})
              </div>
            )}
            {done && "raw" in e && e.raw !== undefined && <RawBlock value={e.raw} />}
          </Row>
        );
      })}
    </div>
  );
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
