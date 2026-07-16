import { STOPWORDS, SYNONYMS, ACTION_VERBS } from "./aliases";
import type { CompactTool, ScoredTool } from "./types";

/**
 * Field weights: a match in the slug is the strongest evidence, then tags, then
 * the prose description. Input field *names* score weakly — "owner"/"repo"/
 * "state" are genuinely discriminative, but they are schema noise at full
 * weight.
 */
const FIELD_WEIGHTS = { slug: 3, tag: 2, desc: 1, field: 0.5 } as const;

/** Weight applied to a term reached via synonym expansion rather than typed. */
const EXPANSION_WEIGHT = 0.55;

/**
 * Ceiling on the IDF an expansion may earn.
 *
 * Expansions are guesses. Without this cap a rare token reached by expansion
 * outweighs the words the user actually typed — the failure that made "urgent
 * inbox" route to Slack in the pre-work. At 1,360 tools the cap binds for any
 * term appearing in fewer than ~170 of them, i.e. exactly the rare tokens that
 * would otherwise dominate.
 */
const EXPANSION_IDF_CAP = 2.2;

/** Weight for the singular stem of a plural term ("emails" -> "email"). */
const STEM_WEIGHT = 0.9;
/** Index-side equivalent, so a doc token "EMAILS" still matches query "email". */
const INDEX_STEM_WEIGHT = 0.95;

/** Bonus when a query's action verb appears in the tool's slug. */
const INTENT_BONUS = 0.8;

/** Minimum score to be considered a match at all. */
const SCORE_FLOOR = 0.01;

/**
 * Split on non-alphanumerics, and additionally on letter/digit boundaries so
 * GOOGLESUPER_CREATE_GOOGLE_SHEET1 yields "sheet", not the unmatchable
 * "sheet1" — which is otherwise invisible to the query "spreadsheet".
 *
 * Bare numbers are dropped: the "1" in SHEET1 carries no meaning and only adds
 * a high-frequency token to the index.
 */
export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !/^\d+$/.test(w) && !STOPWORDS.has(w));
}

interface Doc {
  tool: CompactTool;
  /** token -> the highest field weight it appears with */
  weights: Map<string, number>;
  slugTokens: Set<string>;
}

interface QueryTerm {
  weight: number;
  /** The user's original term, when this term is an expansion of it. */
  from: string | null;
}

export interface LexicalParse {
  baseTerms: string[];
  expandedTerms: [string, string][];
  intents: string[];
}

/**
 * Field-weighted IDF over compact tool metadata. Deterministic, no network,
 * no model — this is stage 1, narrowing 1,360 tools to a shortlist.
 */
export class LexicalIndex {
  private docs: Doc[] = [];
  private df = new Map<string, number>();
  private n = 0;

  constructor(tools: CompactTool[]) {
    for (const tool of tools) {
      const weights = new Map<string, number>();

      const add = (tokens: string[], weight: number) => {
        for (const t of tokens) {
          weights.set(t, Math.max(weights.get(t) ?? 0, weight));
          if (t.length > 3 && t.endsWith("s")) {
            const stem = t.slice(0, -1);
            weights.set(stem, Math.max(weights.get(stem) ?? 0, weight * INDEX_STEM_WEIGHT));
          }
        }
      };

      add(tokenize(tool.slug), FIELD_WEIGHTS.slug);
      add(tool.tags.flatMap(tokenize), FIELD_WEIGHTS.tag);
      add(tokenize(`${tool.name} ${tool.description}`), FIELD_WEIGHTS.desc);
      add(tool.inputFields.flatMap(tokenize), FIELD_WEIGHTS.field);

      this.docs.push({ tool, weights, slugTokens: new Set(tokenize(tool.slug)) });
    }

    this.n = this.docs.length;
    for (const doc of this.docs) {
      for (const token of doc.weights.keys()) {
        this.df.set(token, (this.df.get(token) ?? 0) + 1);
      }
    }
  }

  get size(): number {
    return this.n;
  }

  private idf(token: string): number {
    return Math.log(1 + this.n / (this.df.get(token) ?? this.n));
  }

  parseQuery(query: string): { terms: Map<string, QueryTerm>; parse: LexicalParse } {
    const baseTerms = tokenize(query);
    const terms = new Map<string, QueryTerm>();
    const expandedTerms: [string, string][] = [];

    for (const term of baseTerms) {
      terms.set(term, { weight: 1, from: null });

      const stem = term.length > 3 && term.endsWith("s") ? term.slice(0, -1) : null;
      if (stem && !terms.has(stem)) {
        terms.set(stem, { weight: STEM_WEIGHT, from: term });
        expandedTerms.push([stem, term]);
      }

      // Expand from the stem as well as the typed word. Synonyms are keyed by
      // singular ("message" -> email/mail/thread), so looking up only the raw
      // term silently drops every expansion for a plural query: "find urgent
      // messages" would never reach FETCH_EMAILS, whose slug says EMAILS.
      for (const source of stem ? [term, stem] : [term]) {
        for (const expansion of SYNONYMS[source] ?? []) {
          if (terms.has(expansion)) continue;
          terms.set(expansion, { weight: EXPANSION_WEIGHT, from: term });
          expandedTerms.push([expansion, term]);
        }
      }
    }

    const intents = baseTerms.filter((t) => ACTION_VERBS.has(t));
    return { terms, parse: { baseTerms, expandedTerms, intents } };
  }

  search(query: string): { hits: ScoredTool[]; parse: LexicalParse } {
    const { terms, parse } = this.parseQuery(query);
    const hits: ScoredTool[] = [];

    for (const doc of this.docs) {
      let score = 0;
      const signals: string[] = [];

      for (const [term, info] of terms) {
        const fieldWeight = doc.weights.get(term);
        if (!fieldWeight) continue;

        const idf = info.from ? Math.min(this.idf(term), EXPANSION_IDF_CAP) : this.idf(term);
        const contribution = info.weight * idf * fieldWeight;
        score += contribution;
        signals.push(`${info.from ? `${info.from}→` : ""}${term} +${contribution.toFixed(2)}`);
      }

      for (const verb of parse.intents) {
        if (doc.slugTokens.has(verb)) {
          score += INTENT_BONUS;
          signals.push(`intent:${verb.toUpperCase()} +${INTENT_BONUS}`);
        }
      }

      if (score > SCORE_FLOOR) hits.push({ tool: doc.tool, score, signals });
    }

    hits.sort((a, b) => b.score - a.score);
    return { hits, parse };
  }
}
