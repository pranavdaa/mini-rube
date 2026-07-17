/**
 * Generic bulk-job contracts.
 *
 * The runner is deliberately ignorant of GitHub, Drive, issues and resumes. It
 * knows only: a Source yields pages of items, a Transform turns items into
 * cells, and a Sheet takes rows. Adding "export Slack messages to a sheet" is a
 * new Source + Transform, not a change to the engine.
 *
 * This is the "sandbox" the assignment's constraints imply: Composio's own
 * answer to bulk work (SEARCH_TOOLS + MULTI_EXECUTE + remote workbench) is
 * banned, but we own the server and we know the shape of bulk work up front —
 * paginate, transform per item, write in batches — so we implement exactly that
 * and nothing more. No queue, no database, no workers.
 */

/** Identity of one discovered item, used in progress and failure records. */
export interface ItemIdentity {
  /** Stable id from the provider (file id, issue number). */
  id: string;
  /** Human-meaningful label for a sheet cell: filename, issue title. */
  label: string;
}

/** A provider-specific reader. Pages to exhaustion; the runner never guesses. */
export interface Source<T> {
  id: string;
  /** Column header describing this source's items ("Source file", "Issue"). */
  sourceColumn: string;
  /**
   * Yield successive pages until the provider has no more. Implementations must
   * follow the provider's own cursor and stop only when it says stop — never
   * on an estimated total.
   */
  pages(ctx: JobContext, opts: { pageSize: number }): AsyncGenerator<T[]>;
  identify(item: T): ItemIdentity;
  /**
   * Optional bucket for one item ("open"/"closed"). The runner tallies these
   * over the items it actually kept, so the breakdown always reconciles with
   * `processed` — unlike a count taken during discovery, which would include
   * items a `maxItems` cap later discarded.
   */
  classify?(item: T): string | undefined;
}

/** One item's transform outcome. Never silently absent — see runner invariant. */
export type TransformOutcome =
  | { ok: true; cells: string[] }
  | { ok: false; error: string };

/**
 * A provider-agnostic item→row mapper.
 *
 * `run` receives a batch and must return exactly one outcome per input item, in
 * the same order. Batching exists so a transform backed by a model can amortise
 * one call across many items (issues), while an expensive per-item transform
 * (download + parse a PDF) just sets batchSize: 1 and relies on concurrency.
 */
export interface Transform<T> {
  id: string;
  /** Headers for the cells `run` returns, excluding source/status. */
  columns: string[];
  batchSize: number;
  run(items: T[], ctx: JobContext): Promise<TransformOutcome[]>;
}

/**
 * Free-form provider counters, keyed by the source that reports them.
 *
 * Deliberately untyped: what is worth counting is provider-specific, and the
 * runner has no business knowing what a pull request is.
 */
export type JobStats = Record<string, number>;

export interface JobContext {
  userId: string;
  /** Provider reference: "composiohq/composio", a Drive folder id or URL. */
  ref: string;
  signal?: AbortSignal;
  /**
   * Discovery counters, owned by the runner and incremented by the source.
   *
   * Sources filter during pagination — GitHub returns pull requests from its
   * issues endpoint, and they are dropped before the runner ever sees them. So
   * facts like "fetched 100, dropped 70 PRs" exist only inside `pages()`. This
   * is how they get out; without it, exclusions vanish silently and a job that
   * discarded most of its input looks identical to one that discarded none.
   */
  stats?: JobStats;
}

export type JobPhase = "discovering" | "transforming" | "writing" | "done";

/** Compact progress. Safe to stream to a UI; carries no item content. */
export interface JobProgress {
  phase: JobPhase;
  discovered: number;
  processed: number;
  succeeded: number;
  failed: number;
  written: number;
  outputUrl?: string;
}

/**
 * What the agent is allowed to see. Counts and a URL — never rows, never bodies,
 * never resume text.
 */
export interface JobResult {
  processed: number;
  succeeded: number;
  failed: number;
  rowsWritten: number;
  outputUrl: string;
  /** Short human summary, including partial failures if any. */
  note: string;
  /** Provider discovery counters — what was fetched, what was filtered out. */
  stats: JobStats;
  /** Processed items bucketed by `source.classify`, e.g. {open: 12, closed: 88}. */
  breakdown: Record<string, number>;
}

export interface JobConfig<T> {
  source: Source<T>;
  transform: Transform<T>;
  sheetTitle: string;
  ctx: JobContext;
  /** Items requested per source page. */
  pageSize?: number;
  /** Items per transform call. Defaults to the transform's own batchSize. */
  transformBatchSize?: number;
  /** Rows per sheet append call. */
  appendBatchSize?: number;
  /** Concurrent in-flight transform batches. */
  concurrency?: number;
  /** Stop after this many discovered items. For the test ladder (10→100→all). */
  maxItems?: number;
  onProgress?: (progress: JobProgress) => void;
}
