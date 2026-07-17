import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import type { AttachmentMeta } from "./select";
import type { ParsedQuery, RouterCandidate } from "./types";

/**
 * Stage 2: bounded semantic confirmation.
 *
 * Stage 1 (lexical) is fast and explainable but literal — it ranks by
 * vocabulary overlap, so it cannot tell that "let Karan know" needs a contacts
 * lookup, or that filling a sheet needs the sheet created first. This stage
 * hands a *small, closed* candidate list to a cheap model and asks for the
 * minimum complete set, prerequisites included.
 *
 * It is bounded in every direction: at most 15 candidates in, at most 8 slugs
 * out, chosen only from the candidates, cached, skipped when stage 1 is
 * decisive, and it falls back to the deterministic ranking on any failure. The
 * router never depends on it being right — only on it being no worse.
 *
 * This is our own prompt and our own {selected:[{slug,reason}]} shape. It
 * deliberately shares no field names or response contract with any COMPOSIO_*
 * meta-tool.
 */

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

/** A small, cheap model: this is a shortlist filter, not the agent. */
const CONFIRM_MODEL = process.env.ROUTER_CONFIRM_MODEL ?? "openai/gpt-4o-mini";

/** Hard ceilings on what crosses the boundary. */
export const MAX_CANDIDATES_IN = 15;
export const MAX_SELECTED_OUT = 8;

/** Stage 1 is decisive when its top score beats the runner-up by this much. */
const DOMINANCE_RATIO = 2.0;

const REQUEST_TIMEOUT_MS = 20_000;

export type ConfirmSource =
  | "lexical-decisive" // skipped: stage 1 was unambiguous
  | "model" // the model chose
  | "fallback-parse" // model replied, output unusable
  | "fallback-error" // model errored/timed out
  | "disabled";

export interface ConfirmOutcome {
  selected: RouterCandidate[];
  /** slug -> one short reason. Only populated when the model chose. */
  reasons: Map<string, string>;
  source: ConfirmSource;
  cached: boolean;
}

/**
 * Skip when stage 1 already answers the question on its own.
 *
 * Deliberately conservative, because the two errors are not symmetric: an
 * unnecessary confirm costs ~1s, while wrongly skipping drops a prerequisite
 * and breaks the chain. So we only skip a request that looks single-step —
 * one sub-app, no mixed read+write intent — *and* whose top candidate clearly
 * dominates. "schedule a meeting with a saved contact" hints two facets
 * (calendar + contacts) and is never skipped, even though GET_CONTACTS leads
 * by 2×.
 */
export function isDecisive(candidates: RouterCandidate[], parsed: ParsedQuery): boolean {
  if (candidates.length < 2) return candidates.length === 1;
  if (parsed.aspect === "mixed") return false; // read+write ⇒ a chain
  if (parsed.hintedFacets.length > 1) return false; // spans sub-apps ⇒ a chain

  const [top, second] = candidates as [RouterCandidate, RouterCandidate];
  if (second.score <= 0) return true;
  return top.score / second.score >= DOMINANCE_RATIO;
}

/** Normalized cache key: same request + same catalog ⇒ same decision. */
export function cacheKey(
  text: string,
  attachments: AttachmentMeta[],
  catalogVersion: string
): string {
  const request = text.toLowerCase().replace(/\s+/g, " ").trim();
  const kinds = attachments
    .map((a) => a.contentType ?? "file")
    .sort()
    .join(",");
  return `${catalogVersion}|${request}|${kinds}`;
}

const cache = new Map<string, { slugs: string[]; reasons: [string, string][] }>();

export function clearConfirmCache(): void {
  cache.clear();
}

export interface ConfirmArgs {
  text: string;
  attachments: AttachmentMeta[];
  candidates: RouterCandidate[];
  parsed: ParsedQuery;
  catalogVersion: string;
  limit?: number;
}

export async function confirmSelection(args: ConfirmArgs): Promise<ConfirmOutcome> {
  const limit = Math.min(args.limit ?? MAX_SELECTED_OUT, MAX_SELECTED_OUT);
  const pool = args.candidates.slice(0, MAX_CANDIDATES_IN);
  const fallback = () => pool.slice(0, limit);

  if (!pool.length) {
    return { selected: [], reasons: new Map(), source: "fallback-error", cached: false };
  }

  if (isDecisive(pool, args.parsed)) {
    return { selected: fallback(), reasons: new Map(), source: "lexical-decisive", cached: false };
  }

  if (!OPENROUTER_API_KEY) {
    return { selected: fallback(), reasons: new Map(), source: "disabled", cached: false };
  }

  const key = cacheKey(args.text, args.attachments, args.catalogVersion);
  const hit = cache.get(key);
  if (hit) {
    const byslug = new Map(pool.map((c) => [c.slug, c]));
    const selected = hit.slugs.map((s) => byslug.get(s)).filter((c): c is RouterCandidate => !!c);
    if (selected.length) {
      return { selected, reasons: new Map(hit.reasons), source: "model", cached: true };
    }
  }

  let raw: string;
  try {
    const openrouter = createOpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: OPENROUTER_API_KEY,
    });
    const res = await generateText({
      model: openrouter(CONFIRM_MODEL),
      system: SYSTEM_PROMPT,
      prompt: buildPrompt(args.text, args.attachments, pool, limit),
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    raw = res.text;
  } catch {
    return { selected: fallback(), reasons: new Map(), source: "fallback-error", cached: false };
  }

  const parsed = parseSelection(raw, pool, limit);
  if (!parsed.length) {
    return { selected: fallback(), reasons: new Map(), source: "fallback-parse", cached: false };
  }

  const byslug = new Map(pool.map((c) => [c.slug, c]));
  const selected = parsed.map((p) => byslug.get(p.slug)!).filter(Boolean);
  const reasons = new Map(parsed.map((p) => [p.slug, p.reason]));

  cache.set(key, { slugs: selected.map((c) => c.slug), reasons: [...reasons] });

  return { selected, reasons, source: "model", cached: false };
}

const SYSTEM_PROMPT = [
  "You choose which tools an assistant needs to carry out a user's request.",
  "",
  "Choose the smallest set of tools that together complete the WHOLE request.",
  "",
  "FIRST, check for a whole-workflow candidate: one whose description says it",
  "performs an entire multi-item job end to end (paginates a whole collection,",
  "processes every item, exports everything — server-side). If one produces the",
  "exact outcome the user asked for, select it ALONE — never alongside the",
  "per-step tools it replaces, and never decomposed into the list/create/insert",
  "steps it already performs internally. 'All the X into a spreadsheet' is one",
  "whole-workflow job, not a list tool plus a sheet tool.",
  "",
  "The outcome must match, not just the topic. A tool that triages or filters",
  "items answers 'which matter?' — it is wrong for a plain 'show/list the",
  "latest N', where the simple read tool is correct. For example:",
  "- 'show me the important emails from my inbox' → the triage/digest tool",
  "- 'show my five most recent emails' → the plain fetch tool; recency is not importance",
  "",
  "Only when no single candidate covers the whole request, compose steps.",
  "Include prerequisite tools the request implies but never names. A request is",
  "not complete if a step it depends on has no tool. For example:",
  "- inviting a named person needs a contact lookup first, to resolve their address",
  "- adding rows to a new spreadsheet needs the spreadsheet created first",
  "- downloading files from a folder needs the folder listed first",
  "- analysing issues needs the issues listed first",
  "",
  "Do not include a tool merely because it is related to the same topic. If the",
  "request needs one tool, return one tool.",
  "",
  "If a candidate's description says it triages, digests, or summarizes a large",
  "read (e.g. finding the important items among many), prefer it over a raw",
  "list/fetch tool covering the same data — the raw tool would return everything",
  "at once instead of a bounded, reasoned-over result.",
  "",
  "Choose only from the candidates given. Never invent a tool name.",
  "",
  'Reply with JSON only, no prose, in exactly this shape:',
  '{"selected":[{"slug":"TOOL_SLUG","reason":"why this tool is needed"}]}',
  "Keep each reason under 12 words.",
].join("\n");

function buildPrompt(
  text: string,
  attachments: AttachmentMeta[],
  candidates: RouterCandidate[],
  limit: number
): string {
  const lines = [`Request: ${JSON.stringify(text)}`];

  if (attachments.length) {
    const described = attachments
      .map((a) => a.contentType ?? "file")
      .join(", ");
    lines.push(`The user attached: ${described}`);
  }

  lines.push("", "Candidate tools:");
  for (const c of candidates) {
    lines.push(`- ${c.slug} (${c.toolkit}): ${oneSentence(c.description)}`);
  }
  lines.push("", `Select at most ${limit} tools.`);

  return lines.join("\n");
}

/** First sentence, capped — the model needs the gist, not the manual. */
function oneSentence(description: string): string {
  const text = description.replace(/\s+/g, " ").trim();
  if (!text) return "(no description)";
  const end = text.search(/\.\s|\.$/);
  const first = end > 0 ? text.slice(0, end + 1) : text;
  return first.length > 180 ? `${first.slice(0, 177)}...` : first;
}

/**
 * Parse the model's reply defensively.
 *
 * Anything unexpected returns empty, and the caller falls back to the
 * deterministic ranking. A malformed confirm must never be worse than no
 * confirm.
 */
export function parseSelection(
  raw: string,
  candidates: RouterCandidate[],
  limit: number
): { slug: string; reason: string }[] {
  const json = extractJson(raw);
  if (!json) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }

  const list = (parsed as any)?.selected;
  if (!Array.isArray(list)) return [];

  const allowed = new Set(candidates.map((c) => c.slug));
  const out: { slug: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const item of list) {
    const slug = typeof item === "string" ? item : item?.slug;
    if (typeof slug !== "string") continue;
    // Rule: only tools from the candidate list. A hallucinated slug is dropped,
    // not executed.
    if (!allowed.has(slug) || seen.has(slug)) continue;
    seen.add(slug);
    const reason = typeof item?.reason === "string" ? item.reason.trim() : "selected for this request";
    out.push({ slug, reason });
    if (out.length >= limit) break;
  }

  return out;
}

/** Pull a JSON object out of a reply that may be fenced or prose-wrapped. */
function extractJson(raw: string): string | null {
  const text = raw.trim();

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);

  return null;
}
