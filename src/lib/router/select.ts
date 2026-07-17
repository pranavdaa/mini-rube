import { getRouter, DEFAULT_LIMIT } from "./router";
import { loadToolSchemas, type FullTool } from "./schemas";
import { confirmSelection, type ConfirmSource } from "./confirm";
import type { ParsedQuery, RouterCandidate } from "./types";

/**
 * How many tools the model is allowed to see per turn. Compact metadata is
 * cheap to rank; schemas are not. ~8 keeps the prompt a few thousand tokens
 * while leaving room for a chain's hidden prerequisite alongside its headline
 * tool (search contacts *and* create event).
 */
export const SELECTION_LIMIT = 8;

/** Hard ceiling asserted before every turn — the context guarantee, enforced. */
export const MAX_SCHEMAS_PER_TURN = 10;

export interface AttachmentMeta {
  name?: string;
  contentType?: string;
}

export interface AgentRequest {
  text: string;
  attachments: AttachmentMeta[];
  /**
   * Earlier user turns, most recent first. Used only when the latest message
   * cannot be routed on its own — see routeWithContext.
   */
  context: string[];
}

/** How many earlier user turns are available to fall back on. */
const CONTEXT_TURNS = 3;

/**
 * Below this, the best candidate is noise rather than a match.
 *
 * Measured against the live catalog: real standalone requests score 23.6–108
 * ("Schedule a meeting with Karan tomorrow" is the weakest at 23.6, because
 * "karan" is unknown vocabulary), while continuations and chit-chat score
 * 0–10.8 ("make it 45 minutes" is the strongest at 10.8). 15 sits in that gap
 * with margin on both sides.
 */
const MIN_STANDALONE_SCORE = 15;

/** A message shape loose enough for AI SDK v4 UI/Core messages alike. */
interface LooseMessage {
  role?: string;
  content?: unknown;
  experimental_attachments?: { name?: string; contentType?: string }[];
}

/**
 * Pull the latest user turn's text and attachment metadata out of the message
 * list. Content may be a plain string or an array of typed parts.
 */
export function extractRequest(messages: LooseMessage[]): AgentRequest {
  const userTurns = messages.filter((m) => m.role === "user");
  const last = userTurns.at(-1);
  if (!last) return { text: "", attachments: [], context: [] };

  // Look back a few turns for an attachment — the agent may ask for clarification
  // ("who should this go to?") and the user replies without re-attaching. The file
  // is still in the conversation history; we just need to find it.
  const ATTACHMENT_LOOKBACK_TURNS = 3;
  const recentTurns = userTurns.slice(-ATTACHMENT_LOOKBACK_TURNS);
  let attachments: AttachmentMeta[] = [];
  for (const msg of [...recentTurns].reverse()) {
    const attachs = (msg.experimental_attachments ?? []).map((a) => ({
      name: a?.name,
      contentType: a?.contentType,
    }));
    if (attachs.length) {
      attachments = attachs;
      break;
    }
  }

  return {
    text: messageText(last),
    attachments,
    // Most recent first: the nearest turn is the likeliest source of the task.
    context: userTurns
      .slice(0, -1)
      .map(messageText)
      .filter(Boolean)
      .reverse()
      .slice(0, CONTEXT_TURNS),
  };
}

function messageText(message: LooseMessage): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part: any) => (typeof part === "string" ? part : part?.type === "text" ? (part.text ?? "") : ""))
      .join(" ")
      .trim();
  }
  return "";
}

/**
 * The text the router actually ranks against.
 *
 * Attachment *metadata* is folded in — never bytes — so "send this to Ana"
 * with a PDF attached still routes to a tool that can carry an attachment.
 * Filenames can be noisy, so only the type contributes vocabulary.
 */
export function buildRoutingQuery(request: AgentRequest): string {
  if (!request.attachments.length) return request.text;

  const kinds = new Set<string>();
  for (const a of request.attachments) {
    if (a.contentType?.includes("pdf")) kinds.add("pdf");
    else if (a.contentType?.startsWith("image/")) kinds.add("image");
    else if (a.contentType) kinds.add("file");
  }
  kinds.add("attachment");

  return `${request.text} ${[...kinds].join(" ")}`.trim();
}

/** Stage 2 runs unless explicitly disabled. */
const CONFIRM_ENABLED = process.env.ROUTER_CONFIRM !== "0";

/**
 * Route the latest message, falling back to the conversation when it cannot
 * stand alone.
 *
 * A conversation is one task spread over several messages, but the router only
 * ever saw the newest one. So the agent would ask "what time?" — exactly what
 * we tell it to do when a required value is missing — and then be unable to
 * route the answer: "10 am and 30 mins" carries no calendar vocabulary at all.
 * It scored 2.4 against junk tools and never saw CREATE_EVENT; "10am" and "yes"
 * matched nothing whatsoever. The agent asked a question it could not
 * understand the answer to.
 *
 * The fallback is deliberately conditional rather than always-on. Merging every
 * turn into the query would let a finished task pollute the next one ("show my
 * emails" still steering the query three requests later). A message that routes
 * well on its own is left exactly as it was — so this can only help a request
 * that was already failing.
 */
export function routeWithContext(
  router: Awaited<ReturnType<typeof getRouter>>,
  request: AgentRequest
): {
  /** The text the router actually ranked (may span turns). */
  query: string;
  /** The effective request text, for stage 2's own reasoning. */
  text: string;
  routed: ReturnType<typeof router.search>;
  usedContext: boolean;
} {
  const query = buildRoutingQuery(request);
  const routed = router.search(query, { limit: DEFAULT_LIMIT });

  const best = routed.candidates[0]?.score ?? 0;
  if (best >= MIN_STANDALONE_SCORE || !request.context.length) {
    return { query, text: request.text, routed, usedContext: false };
  }

  // Oldest-first, so the query reads like the conversation did.
  const text = [...request.context].reverse().concat(request.text).join(" ");
  const contextual = buildRoutingQuery({ ...request, text });
  const withContext = router.search(contextual, { limit: DEFAULT_LIMIT });

  // Only take the context-aware result if it genuinely found more; otherwise
  // keep the honest empty answer rather than inventing relevance.
  //
  // Note a pure "thanks" also picks up the previous task's tools here. That is
  // deliberate: a short reply is far more often a continuation that needs those
  // tools ("yes", "ok go ahead", "10am") than a sign-off, and merely *offering*
  // a tool costs nothing — the model still decides whether to call it.
  const contextBest = withContext.candidates[0]?.score ?? 0;
  if (contextBest <= best) return { query, text: request.text, routed, usedContext: false };

  return { query: contextual, text, routed: withContext, usedContext: true };
}

export interface Selection {
  /** What the router ranked. */
  query: string;
  /**
   * True when the latest message alone was unroutable and earlier turns were
   * folded in. Diagnostic only — absent means it routed standalone.
   */
  usedContext?: boolean;
  /** How the query was interpreted. */
  parsed: ParsedQuery;
  /** Top candidates from stage 1, for logging and UI. */
  candidates: RouterCandidate[];
  /** The bounded set handed to the model. */
  selected: RouterCandidate[];
  /** Full schemas, loaded only for `selected`. */
  schemas: Map<string, FullTool>;
  /** Size of the index searched — proves the catalog wasn't truncated. */
  searched: number;
  /** How `selected` was decided, and why each tool is in it. */
  confirm: { source: ConfirmSource; cached: boolean; reasons: Map<string, string> };
}

/**
 * Route a request to a bounded, schema-loaded tool set.
 *
 * Stage 1 (lexical, deterministic) ranks the whole catalog. Stage 2 (a bounded
 * confirm by a cheap model) then picks the minimum complete set from those
 * candidates — or is skipped when stage 1 is already decisive, and falls back
 * to stage 1's ranking on any failure.
 *
 * Schemas are fetched *after* the set is final, so the expensive load only ever
 * covers tools that made the cut.
 */
export async function selectTools(
  request: AgentRequest,
  opts: { limit?: number; confirm?: boolean } = {}
): Promise<Selection> {
  const limit = opts.limit ?? SELECTION_LIMIT;
  const useConfirm = opts.confirm ?? CONFIRM_ENABLED;
  const router = await getRouter();

  const { query, text, routed, usedContext } = routeWithContext(router, request);

  let selected = routed.candidates.slice(0, limit);
  let confirm: Selection["confirm"] = {
    source: "disabled",
    cached: false,
    reasons: new Map<string, string>(),
  };

  if (useConfirm) {
    const outcome = await confirmSelection({
      // The effective text, so a continuation ("10 am and 30 mins") is
      // confirmed against the task it belongs to, not against itself.
      text,
      attachments: request.attachments,
      candidates: routed.candidates,
      parsed: routed.parsed,
      catalogVersion: router.version,
      limit,
    });
    selected = outcome.selected;
    confirm = { source: outcome.source, cached: outcome.cached, reasons: outcome.reasons };
  }

  if (selected.length > MAX_SCHEMAS_PER_TURN) {
    throw new Error(
      `Refusing to expose ${selected.length} schemas to the model (max ${MAX_SCHEMAS_PER_TURN}).`
    );
  }

  const schemas = await loadToolSchemas(selected.map((c) => c.slug));

  return {
    query,
    usedContext,
    parsed: routed.parsed,
    candidates: routed.candidates,
    selected,
    schemas,
    searched: routed.searched,
    confirm,
  };
}
