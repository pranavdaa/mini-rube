/**
 * The turn's activity, as the UI sees it.
 *
 * A turn does a lot the chat bubble can't show: it searches 1,360 tools, picks
 * ~8, may sit inside a two-minute export. Without this the user watches a blank
 * pane and assumes it broke — and an evaluator has to read the server log to
 * see that any routing happened at all.
 *
 * These events are a *display* channel, not the model's context. Nothing here
 * is fed back to the model, so a value being safe to emit is purely a question
 * of whether it is safe for a human to see on screen.
 *
 * The redaction rule for this file: assume every value is hostile. Tool results
 * arrive already compacted (bodies/resume text dropped) and contact-tokenized,
 * but that is the *model's* protection and it is not a display guarantee — the
 * Drive download result, for one, still carries a local filesystem path and a
 * signed S3 URL. `sanitizeForUi` is what makes a value displayable.
 */

import { scrubEmails } from "./redact";

export type UiEvent =
  /** Routing started — emitted before the catalog search so the UI can show it immediately. */
  | { kind: "route"; turn: number; phase: "searching" }
  /** Routing finished: how many tools were searched, how many shortlisted, what was chosen. */
  | {
      kind: "route";
      turn: number;
      phase: "selected";
      searched: number;
      candidates: number;
      selected: { slug: string; toolkit: string; reason?: string }[];
      confirmSource: string;
    }
  /** A toolkit a selected tool needs is not connected. Emitted before the model runs. */
  | { kind: "auth"; turn: number; toolkit: string; connected: false }
  /**
   * An attachment the user sent, named so they can see it was picked up and
   * which tool it was attached to. The filename is the user's own, so it is
   * shown as-is; the bytes never reach this channel.
   */
  | { kind: "attachment"; turn: number; name: string; slug: string; field: string }
  /** One tool execution's lifecycle. */
  | { kind: "exec"; turn: number; slug: string; status: "running" }
  | {
      kind: "exec";
      turn: number;
      slug: string;
      status: "ok" | "failed";
      ms: number;
      error?: string;
      /** Sanitized, truncated result for the collapsible raw view. */
      raw?: unknown;
      /** Set when the result was shrunk before the model saw it — worth surfacing. */
      compacted?: { from: number; to: number; dropped: string[] };
    }
  /** Bulk export progress. Counts only — never a row, never item content. */
  | {
      kind: "job";
      turn: number;
      slug: string;
      phase: string;
      discovered: number;
      processed: number;
      succeeded: number;
      failed: number;
      written: number;
      outputUrl?: string;
    };

export interface UiEmitter {
  emit(event: UiEvent): void;
}

/** A no-op emitter, so non-HTTP callers (tests, scripts) need no ceremony. */
export const nullEmitter: UiEmitter = { emit: () => {} };

/**
 * Field names whose *value* is a credential or a local path, regardless of what
 * it looks like. Matched on the key, because these values are opaque strings
 * that no content-based rule would catch.
 */
const SECRET_KEY_RE = /(api[_-]?key|token|secret|password|passwd|authorization|signature|credential|bearer)/i;
const PATH_KEY_RE = /^(uri|path|filepath|file_path|localpath|local_path)$/i;

/**
 * Transport internals: correct to send to the model's compactor, useless on
 * screen. Gmail's `payload` is the full MIME tree — DKIM signatures, ARC seals,
 * Received chains, routing IPs — thousands of characters that bury the three
 * fields a human wants (sender, subject, when). Dropped for display only; the
 * model's own copy is untouched.
 */
const UI_NOISE_KEY_RE = /^(payload|headers|raw_payload|mime_payload)$/i;

/** An absolute local filesystem path. Leaks the server's layout and the user's username. */
const ABS_PATH_RE = /(?:\/(?:Users|home|var|tmp|private|opt|etc)\/)[^\s"']*/g;

/** A pre-signed URL: the query string is the credential. */
const SIGNED_URL_RE = /(https?:\/\/[^\s"']*?)\?[^\s"']*(?:X-Amz-|Signature=|GoogleAccessId=|Expires=)[^\s"']*/gi;

/**
 * Beyond this, a string is a body/blob rather than an identifying value.
 * compactToolResult already drops these for the *model*, but only when the
 * whole result was over its budget — a small result keeps its fields intact,
 * so an email body under that threshold would still reach the screen.
 */
const MAX_STRING_CHARS = 300;

/** Total size cap for a raw blob in the UI. Generous enough to be useful, bounded. */
const MAX_RAW_CHARS = 4_000;

/**
 * Make an arbitrary value safe to render.
 *
 * Order matters: key-based rules run before content rules, because a value like
 * an opaque token is invisible to any regex.
 */
export function sanitizeForUi(value: unknown, allow: ReadonlySet<string> = new Set(), depth = 0): unknown {
  if (depth > 8) return "[…]";

  if (typeof value === "string") return sanitizeString(value, allow);
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value;

  if (Array.isArray(value)) {
    // Long lists are the shape of "every email/issue/file" — cap and say so.
    const capped = value.slice(0, 20).map((v) => sanitizeForUi(v, allow, depth + 1));
    if (value.length > 20) capped.push(`[… ${value.length - 20} more items]`);
    return capped;
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(key)) {
        out[key] = "[redacted]";
        continue;
      }
      if (PATH_KEY_RE.test(key) && typeof v === "string") {
        out[key] = "[local path redacted]";
        continue;
      }
      if (UI_NOISE_KEY_RE.test(key)) {
        out[key] = "[transport metadata hidden]";
        continue;
      }
      out[key] = sanitizeForUi(v, allow, depth + 1);
    }
    return out;
  }

  return String(value);
}

function sanitizeString(value: string, allow: ReadonlySet<string>): string {
  let out = value.replace(SIGNED_URL_RE, "$1?[signed-url-redacted]");
  out = out.replace(ABS_PATH_RE, "[local path redacted]");
  out = scrubEmails(out, allow);
  if (out.length > MAX_STRING_CHARS) out = `${out.slice(0, MAX_STRING_CHARS)}… [${out.length} chars total]`;
  return out;
}

/** Sanitize and hard-cap a tool result for the collapsible raw view. */
export function sanitizeRawForUi(value: unknown, allow: ReadonlySet<string> = new Set()): unknown {
  const safe = sanitizeForUi(value, allow);
  try {
    const json = JSON.stringify(safe);
    if (json && json.length > MAX_RAW_CHARS) {
      return { _truncated: `Result too large to display in full (${json.length} chars).`, preview: json.slice(0, MAX_RAW_CHARS) };
    }
  } catch {
    return { _note: "Result could not be serialized for display." };
  }
  return safe;
}
