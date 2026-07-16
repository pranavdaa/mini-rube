import { getRouter, DEFAULT_LIMIT } from "./router";
import { loadToolSchemas, type FullTool } from "./schemas";
import type { RouterCandidate } from "./types";

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
}

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
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (!last) return { text: "", attachments: [] };

  let text = "";
  if (typeof last.content === "string") {
    text = last.content;
  } else if (Array.isArray(last.content)) {
    text = last.content
      .map((part: any) => (typeof part === "string" ? part : part?.type === "text" ? (part.text ?? "") : ""))
      .join(" ")
      .trim();
  }

  const attachments: AttachmentMeta[] = (last.experimental_attachments ?? []).map((a) => ({
    name: a?.name,
    contentType: a?.contentType,
  }));

  return { text, attachments };
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

export interface Selection {
  /** What the router ranked. */
  query: string;
  /** Top candidates from stage 1, for logging and UI. */
  candidates: RouterCandidate[];
  /** The bounded set handed to the model. */
  selected: RouterCandidate[];
  /** Full schemas, loaded only for `selected`. */
  schemas: Map<string, FullTool>;
  /** Size of the index searched — proves the catalog wasn't truncated. */
  searched: number;
}

/**
 * Stage 1 selection: rank the live catalog, take a bounded set, and load
 * schemas for only that set.
 *
 * Deterministic — no model in this path. Stage 2 (a bounded LLM confirm over
 * these candidates) is deliberately not wired yet.
 */
export async function selectTools(
  request: AgentRequest,
  opts: { limit?: number } = {}
): Promise<Selection> {
  const limit = opts.limit ?? SELECTION_LIMIT;
  const query = buildRoutingQuery(request);
  const router = await getRouter();

  const routed = router.search(query, { limit: DEFAULT_LIMIT });
  const selected = routed.candidates.slice(0, limit);

  if (selected.length > MAX_SCHEMAS_PER_TURN) {
    throw new Error(
      `Refusing to expose ${selected.length} schemas to the model (max ${MAX_SCHEMAS_PER_TURN}).`
    );
  }

  const schemas = await loadToolSchemas(selected.map((c) => c.slug));

  return {
    query,
    candidates: routed.candidates,
    selected,
    schemas,
    searched: routed.searched,
  };
}
