/**
 * Router data model.
 *
 * The search index holds *compact* metadata only. Full input schemas are
 * deliberately excluded: 1,360 live tools is ~800k tokens of schema against a
 * 500k context ceiling, so schemas are loaded lazily for the handful of tools
 * the router actually selects.
 */

/** One tool, reduced to what the router needs to rank it. */
export interface CompactTool {
  /** Canonical slug, e.g. GOOGLESUPER_FETCH_EMAILS */
  slug: string;
  /** Toolkit slug from the live catalog, e.g. googlesuper | github */
  toolkit: string;
  name: string;
  description: string;
  /** Semantic tags only — provider hint tags are stripped into the flags below. */
  tags: string[];
  /** Input field *names* only. Never the schema itself. */
  inputFields: string[];
  /** Tool version pin, required to execute without dangerouslySkipVersionCheck. */
  version?: string;
  /** Provider's "commonly used" flag (Composio `important` tag). */
  important: boolean;
  /**
   * true = read-only, false = writes, undefined = provider gave no hint
   * (callers fall back to the slug's verb).
   */
  readonly?: boolean;
  /** Provider marked this tool deprecated. */
  deprecated: boolean;
}

/** A scored candidate plus the human-readable reasons it scored that way. */
export interface ScoredTool {
  tool: CompactTool;
  score: number;
  /** Why this ranked — one entry per contributing signal. */
  signals: string[];
}

/**
 * What the router hands back. Compact by construction: no input schema, so a
 * caller can show or reason over candidates without touching the context budget.
 */
export interface RouterCandidate {
  slug: string;
  toolkit: string;
  name: string;
  description: string;
  version?: string;
  important: boolean;
  readonly?: boolean;
  inputFields: string[];
  score: number;
  signals: string[];
}

/** How the query was interpreted — surfaced for debugging and for the UI. */
export interface ParsedQuery {
  /** The user's own words, minus stopwords. */
  baseTerms: string[];
  /** [derivedTerm, sourceTerm] pairs — stems and synonym expansions alike. */
  expandedTerms: [string, string][];
  /** Action verbs found in the query. */
  intents: string[];
  /** Read vs write intent; 'mixed' when the query implies both. */
  aspect: QueryAspect;
  /** Toolkits the query's vocabulary implies. */
  hintedToolkits: string[];
  /** Sub-app facets the query implies, e.g. gmail, sheets. */
  hintedFacets: string[];
}

export interface RouteResult {
  query: string;
  parsed: ParsedQuery;
  candidates: RouterCandidate[];
  /** Total tools considered — proves the index wasn't silently truncated. */
  searched: number;
}

export type QueryAspect = "read" | "write" | "mixed" | null;
export type ToolAspect = "read" | "write";
