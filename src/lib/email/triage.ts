import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { executeTool } from "../tools";
import type { JobProgress } from "../jobs/types";

/**
 * Important-email triage.
 *
 * Fetches up to N recent messages (paginated, metadata only — never full
 * bodies), scores them deterministically, and asks one bounded model call to
 * pick the genuinely important ones from the strongest deterministic
 * candidates. Only a short digest — sender, subject, timestamp, reason —
 * ever leaves this module; the raw pages never reach the main agent's
 * context, however many messages were reviewed.
 */

const PAGE_SIZE = 100;
/** Hard ceiling regardless of what a caller asks for. */
const MAX_RESULTS_CAP = 500;

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
/** A small, cheap model: this is a triage filter, not the agent. */
const TRIAGE_MODEL = process.env.EMAIL_TRIAGE_MODEL ?? "openai/gpt-4o-mini";
const REQUEST_TIMEOUT_MS = 20_000;

/** How many of the strongest deterministic candidates the model reviews. Bounded regardless of how many messages were fetched. */
const CANDIDATE_POOL = 25;

/** Fallback selection (model unavailable/failed): keep candidates at or above this score, capped. */
const FALLBACK_SCORE_THRESHOLD = 2;
const FALLBACK_MAX = 10;

export interface CompactEmail {
  id: string;
  sender: string;
  subject: string;
  timestamp: string;
  snippet: string;
  labels: string[];
}

export interface ImportantEmail {
  sender: string;
  subject: string;
  timestamp: string;
  reason: string;
}

export interface TriageDigest {
  reviewed: number;
  important: ImportantEmail[];
  note: string;
}

export interface TriageOptions {
  maxResults?: number;
  /**
   * Live progress, reusing the bulk jobs' shape so the same UI renders it.
   * A 100-email review runs ~11s — without this the user watches a silent
   * pane and can't tell working from stuck.
   */
  onProgress?: (progress: JobProgress) => void;
}

/**
 * Paginate GOOGLESUPER_FETCH_EMAILS down to compact records only.
 *
 * verbose=false + include_payload=false is the tool's own "metadata only"
 * mode — no MIME payload, no message body — so the per-message size stays
 * small even before any context-guard compaction runs. Loops on
 * `nextPageToken` rather than trusting `resultSizeEstimate` (the tool's own
 * docs say it's approximate), and stops only when enough messages are
 * collected or the provider says there is no next page.
 */
async function fetchCompactEmails(
  userId: string,
  maxResults: number,
  onPage?: (fetched: number) => void
): Promise<CompactEmail[]> {
  const out: CompactEmail[] = [];
  let pageToken: string | undefined;

  while (out.length < maxResults) {
    const remaining = maxResults - out.length;
    const args: Record<string, unknown> = {
      max_results: Math.min(remaining, PAGE_SIZE),
      verbose: false,
      include_payload: false,
    };
    if (pageToken) args.page_token = pageToken;

    const raw: any = await executeTool("GOOGLESUPER_FETCH_EMAILS", userId, args);
    if (raw?.successful === false || raw?.error) {
      throw new Error(`GOOGLESUPER_FETCH_EMAILS failed: ${String(raw?.error ?? "unknown error")}`);
    }

    const messages: any[] = raw?.data?.messages ?? [];
    for (const m of messages) {
      out.push({
        id: String(m?.messageId ?? m?.id ?? ""),
        sender: String(m?.sender ?? ""),
        subject: String(m?.subject ?? "(no subject)"),
        timestamp: String(m?.messageTimestamp ?? ""),
        snippet: String(m?.preview?.body ?? "").slice(0, 160),
        labels: Array.isArray(m?.labelIds) ? m.labelIds.map(String) : [],
      });
      if (out.length >= maxResults) break;
    }

    onPage?.(out.length);
    pageToken = raw?.data?.nextPageToken;
    if (!pageToken || messages.length === 0) break;
  }

  return out;
}

const URGENCY_KEYWORDS = [
  "urgent", "asap", "action required", "action needed", "deadline",
  "please respond", "response needed", "response required", "immediately",
  "final notice", "reminder", "interview", "offer letter", "contract",
  "invoice", "payment due", "overdue", "important", "time sensitive",
];

const BULK_SENDER_MARKERS = [
  "no-reply", "noreply", "notifications", "newsletter", "digest@",
  "marketing", "substack", "mailer", "do-not-reply", "updates@", "news@",
];

const DEMOTED_LABELS = new Set(["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS", "SPAM", "TRASH"]);

export interface EmailScore {
  score: number;
  signals: string[];
}

/**
 * Deterministic importance signals, checked before any model call.
 *
 * Keyed off labels Gmail already assigns (IMPORTANT/STARRED/UNREAD/category),
 * urgency vocabulary in the subject/snippet, and whether the sender looks
 * automated. None of this needs a model — it runs over every fetched message
 * so the (bounded) model call only ever sees the strongest candidates.
 */
export function scoreEmail(email: CompactEmail): EmailScore {
  let score = 0;
  const signals: string[] = [];
  const labels = new Set(email.labels);
  const haystack = `${email.subject} ${email.snippet}`.toLowerCase();
  const senderLower = email.sender.toLowerCase();

  if (labels.has("IMPORTANT")) {
    score += 3;
    signals.push("labeled important");
  }
  if (labels.has("STARRED")) {
    score += 2;
    signals.push("starred");
  }
  if (labels.has("UNREAD")) {
    score += 1;
    signals.push("unread");
  }

  const matchedKeyword = URGENCY_KEYWORDS.find((kw) => haystack.includes(kw));
  if (matchedKeyword) {
    score += 2;
    signals.push(`mentions "${matchedKeyword}"`);
  }

  if (BULK_SENDER_MARKERS.some((m) => senderLower.includes(m))) {
    score -= 3;
    signals.push("bulk/automated sender");
  } else {
    score += 1;
    signals.push("personal sender");
  }

  const demotedLabel = [...labels].find((l) => DEMOTED_LABELS.has(l));
  if (demotedLabel) {
    score -= 3;
    signals.push(`category:${demotedLabel}`);
  }

  return { score, signals };
}

interface ScoredEmail {
  email: CompactEmail;
  score: number;
  signals: string[];
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const CLASSIFY_SYSTEM_PROMPT = [
  "You triage email metadata to find what's genuinely important to the user.",
  "You are given sender, subject, a short snippet, and labels only — never the full body.",
  "Important means: time-sensitive, needs a reply or action, or personally/professionally relevant.",
  "Not important: newsletters, marketing, automated notifications, routine confirmations.",
  "An empty list is a valid, honest answer if nothing qualifies.",
  'Reply with JSON only, no prose: {"important":[{"id":"MESSAGE_ID","reason":"short reason, under 12 words"}]}',
].join("\n");

function buildClassifyPrompt(pool: ScoredEmail[]): string {
  const lines = pool.map(
    (p, i) =>
      `${i + 1}. id=${p.email.id} | from: ${truncate(p.email.sender, 60)} | subject: ${truncate(p.email.subject, 100)} | snippet: ${truncate(p.email.snippet, 120)} | labels: ${p.email.labels.join(",") || "none"}`
  );
  return [`Reviewing ${pool.length} candidate emails, metadata only:`, "", ...lines].join("\n");
}

function extractJson(raw: string): string | null {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return null;
}

/**
 * Parse the model's reply defensively. Anything unusable returns null so the
 * caller falls back to the deterministic ranking — a malformed classify must
 * never be worse than no classify.
 */
export function parseClassifyResponse(
  raw: string,
  allowedIds: Set<string>
): { id: string; reason: string }[] | null {
  const json = extractJson(raw);
  if (!json) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  const list = (parsed as any)?.important;
  if (!Array.isArray(list)) return null;

  const out: { id: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const id = typeof item === "string" ? item : item?.id;
    if (typeof id !== "string" || !allowedIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    const reason = typeof item?.reason === "string" ? item.reason.trim() : "flagged as important";
    out.push({ id, reason });
  }
  return out;
}

async function classifyImportant(pool: ScoredEmail[]): Promise<{ id: string; reason: string }[] | null> {
  if (!OPENROUTER_API_KEY || !pool.length) return null;

  let text: string;
  try {
    const openrouter = createOpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: OPENROUTER_API_KEY,
    });
    const res = await generateText({
      model: openrouter(TRIAGE_MODEL),
      system: CLASSIFY_SYSTEM_PROMPT,
      prompt: buildClassifyPrompt(pool),
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    text = res.text;
  } catch {
    return null;
  }

  return parseClassifyResponse(text, new Set(pool.map((p) => p.email.id)));
}

/** Deterministic fallback when the model is unavailable or its reply is unusable. */
function fallbackImportant(pool: ScoredEmail[]): ImportantEmail[] {
  return pool
    .filter((p) => p.score >= FALLBACK_SCORE_THRESHOLD)
    .slice(0, FALLBACK_MAX)
    .map((p) => ({
      sender: p.email.sender,
      subject: p.email.subject,
      timestamp: p.email.timestamp,
      reason: p.signals.join(", "),
    }));
}

/**
 * The whole workflow: paginate → compact → deterministic score → bounded
 * model classify (one call, ≤ CANDIDATE_POOL items) → digest.
 *
 * Every message fetched counts toward `reviewed`; only the ones judged
 * important, plus a one-line reason each, cross into the returned digest.
 */
export async function triageImportantEmails(
  userId: string,
  opts: TriageOptions = {}
): Promise<TriageDigest> {
  const maxResults = Math.max(1, Math.min(opts.maxResults ?? 100, MAX_RESULTS_CAP));

  // Progress in the bulk jobs' vocabulary: fetching pages is "discovering",
  // the scoring + one classify call is "transforming". Counts only — no
  // subjects, senders or snippets ever ride a progress event.
  const report = (phase: JobProgress["phase"], discovered: number, processed: number) =>
    opts.onProgress?.({ phase, discovered, processed, succeeded: processed, failed: 0, written: 0 });

  report("discovering", 0, 0);
  const emails = await fetchCompactEmails(userId, maxResults, (fetched) =>
    report("discovering", fetched, 0)
  );
  report("transforming", emails.length, emails.length);

  const scored: ScoredEmail[] = emails
    .map((email) => {
      const { score, signals } = scoreEmail(email);
      return { email, score, signals };
    })
    .sort((a, b) => b.score - a.score);

  const pool = scored.slice(0, CANDIDATE_POOL);
  const modelPicks = await classifyImportant(pool);

  let important: ImportantEmail[];
  let source: "model" | "deterministic";

  if (modelPicks !== null) {
    const byId = new Map(pool.map((p) => [p.email.id, p]));
    important = modelPicks
      .map((pick) => {
        const match = byId.get(pick.id);
        return match
          ? { sender: match.email.sender, subject: match.email.subject, timestamp: match.email.timestamp, reason: pick.reason }
          : null;
      })
      .filter((x): x is ImportantEmail => x !== null);
    source = "model";
  } else {
    important = fallbackImportant(pool);
    source = "deterministic";
  }

  const note =
    `Reviewed ${emails.length} of the most recent emails` +
    (emails.length < maxResults ? ` (fewer than ${maxResults} were available)` : "") +
    (source === "deterministic" ? "; triage model unavailable, used deterministic ranking" : "") +
    `. ${important.length} flagged as important.`;

  report("done", emails.length, emails.length);
  return { reviewed: emails.length, important, note };
}
