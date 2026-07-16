import { loadCatalog, TOOLKITS, catalogCounts } from "./catalog";
import { LexicalIndex } from "./lexical";
import { applyBoosts, hintedFacets, hintedToolkits, queryAspect } from "./scoring";
import type { CompactTool, RouteResult, RouterCandidate, ScoredTool } from "./types";

/**
 * Candidates returned per query. Stage 1 is deliberately generous: it is a
 * shortlist for a later bounded LLM confirm (stage 2), not the final tool set.
 * A chain like "list issues -> create sheet -> insert rows" needs room for the
 * prerequisites to survive alongside the headline tool.
 */
export const DEFAULT_LIMIT = 15;

/**
 * Stage 1 of the tool router: deterministic lexical retrieval over compact
 * metadata for every tool in the configured toolkits.
 *
 * 1,360 live tools is ~800k tokens of schema against a 500k ceiling, so the
 * catalog cannot be handed to a model. This narrows it to ~15 candidates using
 * no model at all, and explains every ranking it produces.
 */
export class Router {
  private index: LexicalIndex;
  private bySlug: Map<string, CompactTool>;

  constructor(private tools: CompactTool[], private toolkits: string[] = TOOLKITS) {
    this.index = new LexicalIndex(tools);
    this.bySlug = new Map(tools.map((t) => [t.slug, t]));
  }

  get toolCount(): number {
    return this.tools.length;
  }

  get counts(): Record<string, number> {
    return catalogCounts(this.tools);
  }

  /** The full compact catalog. Metadata only — never input schemas. */
  get all(): readonly CompactTool[] {
    return this.tools;
  }

  /** Compact metadata for one slug. Full schemas are loaded elsewhere, lazily. */
  getTool(slug: string): CompactTool | undefined {
    return this.bySlug.get(slug);
  }

  search(query: string, opts: { limit?: number } = {}): RouteResult {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const { hits, parse } = this.index.search(query);

    const tokens = new Set(parse.baseTerms);
    const facets = hintedFacets(tokens);
    const toolkits = hintedToolkits(tokens, facets, this.toolkits);
    const aspect = queryAspect(parse.baseTerms, query);

    const ranked = applyBoosts(hits, { aspect, facets, toolkits });

    return {
      query,
      parsed: {
        baseTerms: parse.baseTerms,
        expandedTerms: parse.expandedTerms,
        intents: parse.intents,
        aspect,
        hintedToolkits: [...toolkits],
        hintedFacets: facets.map((f) => f.id),
      },
      candidates: ranked.slice(0, limit).map(toCandidate),
      searched: this.index.size,
    };
  }
}

function toCandidate(hit: ScoredTool): RouterCandidate {
  const { tool } = hit;
  return {
    slug: tool.slug,
    toolkit: tool.toolkit,
    name: tool.name,
    description: tool.description,
    version: tool.version,
    important: tool.important,
    readonly: tool.readonly,
    inputFields: tool.inputFields,
    score: +hit.score.toFixed(4),
    signals: hit.signals,
  };
}

/**
 * Router over the live catalog, built once and reused. The catalog cache lives
 * in catalog.ts, so concurrent callers share a single fetch.
 */
let instance: Promise<Router> | null = null;

export function getRouter(): Promise<Router> {
  if (!instance) {
    instance = loadCatalog()
      .then((tools) => new Router(tools))
      .catch((err) => {
        instance = null;
        throw err;
      });
  }
  return instance;
}

export function clearRouterCache(): void {
  instance = null;
}
