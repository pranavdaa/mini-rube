import { loadCatalog, TOOLKITS, catalogCounts, catalogVersion } from "./catalog";
import { LexicalIndex } from "./lexical";
import { FACETS } from "./aliases";
import {
  applyBoosts,
  bestFacetTool,
  facetMatchesStrict,
  hintedFacets,
  hintedToolkits,
  impliesUnresolvedPerson,
  queryAspect,
} from "./scoring";
import type { CompactTool, RouteResult, RouterCandidate, ScoredTool } from "./types";

const CONTACTS_FACET = FACETS.find((f) => f.id === "contacts")!;

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

  /** Content fingerprint of the indexed catalog; keys caches. Computed once. */
  get version(): string {
    this.cachedVersion ??= catalogVersion(this.tools);
    return this.cachedVersion;
  }
  private cachedVersion?: string;

  /** Compact metadata for one slug. Full schemas are loaded elsewhere, lazily. */
  getTool(slug: string): CompactTool | undefined {
    return this.bySlug.get(slug);
  }

  search(query: string, opts: { limit?: number } = {}): RouteResult {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const { hits, parse } = this.index.search(query);

    const tokens = new Set(parse.baseTerms);
    let facets = hintedFacets(tokens);

    // "schedule ... with karan": no catalog vocabulary names a person, so
    // lexical retrieval alone never nominates a contacts tool (verified against
    // the live catalog — see WORKLOG). Detect the position instead of the word.
    const personImplied = impliesUnresolvedPerson(query, (t) => this.index.hasTerm(t));
    if (personImplied && !facets.includes(CONTACTS_FACET)) {
      facets = [...facets, CONTACTS_FACET];
    }

    const toolkits = hintedToolkits(tokens, facets, this.toolkits);
    const aspect = queryAspect(parse.baseTerms, query);

    const ranked = applyBoosts(hits, { aspect, facets, toolkits });
    let candidates = ranked.slice(0, limit).map(toCandidate);

    // The contacts tool may still be entirely absent from `ranked`: it shares
    // zero vocabulary with the query, so the lexical stage never scored it
    // above zero and it was filtered out before boosts ever ran. Seed it by
    // position, not lexical overlap — a hidden prerequisite must survive the
    // cut even when nothing points at it lexically.
    if (personImplied) {
      // Strict: by slug/tags, never prose. A description-level match here
      // (e.g. a conference-room tool citing the "Directory API") reads as "we
      // already have a contacts tool" and silently disables the seeding below.
      const present = candidates.some((c) => {
        const tool = this.bySlug.get(c.slug);
        return tool && facetMatchesStrict(CONTACTS_FACET, tool);
      });
      if (!present) {
        const seed = bestFacetTool(this.tools, CONTACTS_FACET);
        if (seed) {
          candidates = [
            ...candidates.slice(0, Math.max(0, limit - 1)),
            toCandidate({
              tool: seed,
              score: 0,
              signals: ["seeded:contacts — unresolved name implies a contact lookup"],
            }),
          ];
        }
      }
    }

    return {
      query,
      parsed: {
        baseTerms: parse.baseTerms,
        expandedTerms: parse.expandedTerms,
        intents: parse.intents,
        aspect,
        hintedToolkits: [...toolkits],
        hintedFacets: facets.map((f) => f.id),
        impliesPerson: personImplied,
      },
      candidates,
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
