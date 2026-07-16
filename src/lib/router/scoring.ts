import { FACETS, READ_VERBS, WRITE_VERBS, READ_SLUG_VERBS, type Facet } from "./aliases";
import { tokenize } from "./lexical";
import type { CompactTool, QueryAspect, ScoredTool, ToolAspect } from "./types";

/** Query vocabulary clearly implies this toolkit. */
const TOOLKIT_HINT_BOOST = 1.5;
/** ...so tools from other toolkits are demoted, or vocabulary collisions win. */
const TOOLKIT_MISS_PENALTY = 0.6;

/** Query implies a sub-app ("inbox" -> gmail, not calendar). */
const FACET_HINT_BOOST = 1.4;
/** Applied only within a toolkit that has a hinted facet. */
const FACET_MISS_PENALTY = 0.7;

/** Provider-flagged commonly-used tool. */
const IMPORTANT_BOOST = 1.2;

/** Query intent agrees with the tool's read-write nature. */
const ASPECT_MATCH = 1.3;

/**
 * Aspect mismatch is deliberately **asymmetric**, because the two directions
 * are not symmetric mistakes:
 *
 *  - read query + write tool: almost always wrong, and unsafe. "find urgent
 *    messages in my inbox" must not rank BATCH_MODIFY_MESSAGES, which shares
 *    the word "messages" in its *slug* (weight 3) while FETCH_EMAILS only earns
 *    it from its description (weight 1). Nothing but the provider's readOnlyHint
 *    separates them, so the penalty has to be strong enough to overturn a
 *    slug-versus-description gap.
 *
 *  - write query + read tool: frequently *correct*, because read tools are the
 *    hidden prerequisites of write chains — search contacts before creating an
 *    event, list issues before filling a sheet. Penalise this the same way and
 *    the router hides the doorway to the task it just accepted.
 */
const READ_QUERY_WRITE_TOOL = 0.4;
const WRITE_QUERY_READ_TOOL = 0.85;

/** Deprecated tools still rank, but must never outrank a live equivalent. */
const DEPRECATED_PENALTY = 0.5;

/**
 * Read vs write intent.
 *
 * Returns 'mixed' when the query implies both, and callers then apply no aspect
 * pressure at all. This is a deliberate departure from the pre-work, where
 * write intent simply dominated.
 *
 * The reason is hidden prerequisites. "read all the issues and make a sheet" is
 * a write request whose *first* required tool is a read (list issues), same for
 * "schedule a meeting with karan" (search contacts first). Letting write
 * dominate would demote precisely the prerequisite the chain cannot start
 * without — the router would rank the destination and hide the doorway.
 */
export function queryAspect(tokens: string[], raw?: string): QueryAspect {
  const read = tokens.some((t) => READ_VERBS.has(t));
  const write = tokens.some((t) => WRITE_VERBS.has(t));
  if (read && write) return "mixed";
  if (write) return "write";
  if (read) return "read";
  // No verb at all: a question is a request to read. "What events do I have
  // tomorrow?" carries no action verb — "what" is a stopword and "have" is not
  // a verb we track — so without this it scores as intentless and ranks
  // SEND_EVENTS alongside EVENTS_GET. Checked last, so an explicit write verb
  // always wins ("Can you send an email?" stays 'write').
  if (raw && isQuestion(raw)) return "read";
  return null;
}

const INTERROGATIVES = /^\s*(what|which|who|whose|when|where|why|how|do|does|did|is|are|was|were|am|can|could|any)\b/i;

function isQuestion(raw: string): boolean {
  return raw.trimEnd().endsWith("?") || INTERROGATIVES.test(raw);
}

/** Tool aspect from the provider's hint, falling back to the slug's verb. */
export function toolAspect(tool: CompactTool): ToolAspect {
  if (tool.readonly !== undefined) return tool.readonly ? "read" : "write";
  return READ_SLUG_VERBS.some((v) => tool.slug.includes(`_${v}`)) ? "read" : "write";
}

/** Facets whose hint vocabulary appears in the query. */
export function hintedFacets(tokens: Set<string>): Facet[] {
  return FACETS.filter((f) => f.hints.some((h) => tokens.has(h)));
}

/**
 * Toolkits the query implies: those named outright ("github"), plus those
 * owning a hinted facet ("inbox" -> googlesuper).
 */
export function hintedToolkits(tokens: Set<string>, facets: Facet[], toolkits: string[]): Set<string> {
  const hinted = new Set<string>(facets.map((f) => f.toolkit));
  for (const toolkit of toolkits) {
    if (tokens.has(toolkit)) hinted.add(toolkit);
  }
  return hinted;
}

/**
 * True when any of the facet's markers appear in the tool's slug, tags, or
 * description.
 *
 * The description is included because inside googlesuper the slug and tags are
 * often not enough to tell one product from another — GOOGLESUPER_FIND_EVENT
 * and GOOGLESUPER_LIST_CONVERSION_EVENTS have equally "eventful" slugs, and
 * only the prose says "Google Calendar" versus "on a property".
 */
const facetTextCache = new WeakMap<CompactTool, Set<string>>();

function facetText(tool: CompactTool): Set<string> {
  let tokens = facetTextCache.get(tool);
  if (!tokens) {
    tokens = new Set([
      ...tokenize(tool.slug),
      ...tool.tags.flatMap(tokenize),
      ...tokenize(tool.description),
    ]);
    facetTextCache.set(tool, tokens);
  }
  return tokens;
}

function facetMatches(facet: Facet, tool: CompactTool): boolean {
  const tokens = facetText(tool);
  return facet.markers.some((m) => tokens.has(m));
}

export interface BoostContext {
  aspect: QueryAspect;
  facets: Facet[];
  toolkits: Set<string>;
}

/**
 * Apply metadata boosts on top of the lexical score.
 *
 * Every adjustment appends a signal, so a ranking can always be explained
 * rather than taken on faith.
 */
export function applyBoosts(hits: ScoredTool[], ctx: BoostContext): ScoredTool[] {
  const facetToolkits = new Set(ctx.facets.map((f) => f.toolkit));

  const boosted = hits.map((hit) => {
    let score = hit.score;
    const signals = [...hit.signals];
    const tool = hit.tool;

    // Toolkit affinity: "inbox" means googlesuper — lift it, demote the rest.
    if (ctx.toolkits.size) {
      if (ctx.toolkits.has(tool.toolkit)) {
        score *= TOOLKIT_HINT_BOOST;
        signals.push(`toolkit:${tool.toolkit} ×${TOOLKIT_HINT_BOOST}`);
      } else {
        score *= TOOLKIT_MISS_PENALTY;
        signals.push(`toolkit:miss ×${TOOLKIT_MISS_PENALTY}`);
      }
    }

    // Facet affinity, only among toolkits the query actually pointed at. Without
    // this, googlesuper's 467 tools are one undifferentiated pool and "check my
    // inbox" competes against every Drive and Sheets tool on equal footing.
    if (facetToolkits.has(tool.toolkit)) {
      const own = ctx.facets.filter((f) => f.toolkit === tool.toolkit);
      const matched = own.filter((f) => facetMatches(f, tool));
      if (matched.length) {
        score *= FACET_HINT_BOOST;
        signals.push(`facet:${matched.map((f) => f.id).join("+")} ×${FACET_HINT_BOOST}`);
      } else {
        score *= FACET_MISS_PENALTY;
        signals.push(`facet:miss ×${FACET_MISS_PENALTY}`);
      }
    }

    if (tool.important) {
      score *= IMPORTANT_BOOST;
      signals.push(`important ×${IMPORTANT_BOOST}`);
    }

    // 'mixed' intentionally applies no pressure — see queryAspect.
    if (ctx.aspect === "read" || ctx.aspect === "write") {
      const ta = toolAspect(tool);
      const factor =
        ta === ctx.aspect
          ? ASPECT_MATCH
          : ctx.aspect === "read"
            ? READ_QUERY_WRITE_TOOL
            : WRITE_QUERY_READ_TOOL;
      score *= factor;
      signals.push(`aspect:${ctx.aspect}/${ta} ×${factor}`);
    }

    if (tool.deprecated) {
      score *= DEPRECATED_PENALTY;
      signals.push(`deprecated ×${DEPRECATED_PENALTY}`);
    }

    return { tool, score, signals };
  });

  boosted.sort((a, b) => b.score - a.score);
  return boosted;
}
