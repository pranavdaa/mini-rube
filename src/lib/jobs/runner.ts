import { createSheet, SheetWriter } from "./sheets";
import { withRetry } from "./retry";
import type { JobConfig, JobContext, JobProgress, JobResult, JobStats, TransformOutcome } from "./types";

/**
 * The generic bulk job runner.
 *
 * paginate to exhaustion → transform in bounded-concurrency batches → append
 * rows incrementally → report compact counts.
 *
 * The load-bearing guarantee: **every discovered item produces exactly one
 * row.** A transform that fails, times out, or exhausts its retries yields a
 * failure row naming the source item, not a gap. A job that discovers 1,000
 * files and writes 997 rows is a bug, and the runner throws rather than
 * reporting success — silently dropping rows is the one outcome the assignment
 * explicitly forbids.
 */

/** Start conservative: Google rate-limits aggressively on bulk reads. */
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_PAGE_SIZE = 100;

const STATUS_OK = "ok";

/**
 * Status prefix for an item that was discovered and read but could not be
 * turned into cells. Always carries the reason, so a "failed" row says what
 * went wrong rather than only that something did.
 */
const STATUS_FAILED = "Extraction failed";

export async function runJob<T>(config: JobConfig<T>): Promise<JobResult> {
  const {
    source,
    transform,
    sheetTitle,
    ctx: baseCtx,
    pageSize = DEFAULT_PAGE_SIZE,
    transformBatchSize = transform.batchSize,
    appendBatchSize,
    concurrency = DEFAULT_CONCURRENCY,
    maxItems,
    onProgress,
  } = config;

  // Owned here, incremented by the source during pagination. See JobContext.
  const stats: JobStats = baseCtx.stats ?? {};
  const ctx: JobContext = { ...baseCtx, stats };

  const progress: JobProgress = {
    phase: "discovering",
    discovered: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    written: 0,
  };
  const report = () => onProgress?.({ ...progress });

  // ---- 1. Discover: paginate the source to exhaustion --------------------
  //
  // A discovery failure is fatal by design: if we cannot enumerate the source,
  // we cannot honour "every item gets a row", and a half-listed export is worse
  // than none. Fail with a message that says what to do, not a provider stack
  // trace — the most common cause by far is a toolkit that isn't connected.
  const items: T[] = [];
  try {
    for await (const page of source.pages(ctx, { pageSize })) {
      for (const item of page) {
        items.push(item);
        if (maxItems && items.length >= maxItems) break;
      }
      progress.discovered = items.length;
      report();
      if (maxItems && items.length >= maxItems) break;
    }
  } catch (err: any) {
    throw new Error(describeDiscoveryFailure(source.id, ctx.ref, err));
  }

  if (!items.length) {
    return {
      processed: 0,
      succeeded: 0,
      failed: 0,
      rowsWritten: 0,
      outputUrl: "",
      note: `No items found for ${ctx.ref}. Nothing to export, so no sheet was created.`,
      stats,
      breakdown: {},
    };
  }

  // Tallied over the kept items, so the breakdown always sums to `processed`.
  const breakdown: Record<string, number> = {};
  if (source.classify) {
    for (const item of items) {
      const bucket = source.classify(item);
      if (bucket) breakdown[bucket] = (breakdown[bucket] ?? 0) + 1;
    }
  }

  // ---- 2. Prepare the sheet ---------------------------------------------
  progress.phase = "writing";
  report();

  const handle = await createSheet(ctx.userId, sheetTitle);
  const writer = new SheetWriter(ctx.userId, handle, appendBatchSize, ctx.signal);
  progress.outputUrl = handle.url;

  const headers = [...transform.columns, source.sourceColumn, "Status"];
  await writer.add([headers]);

  // ---- 3. Transform with bounded concurrency, writing as results land ----
  progress.phase = "transforming";
  report();

  const batches = chunk(items, Math.max(1, transformBatchSize));
  let cursor = 0;

  // Per-run transform cache, keyed by the source's own item id (a Drive file
  // id, an issue number). If the same item is discovered twice — a shortcut to
  // the same file, or a provider repeating an item across a page boundary — it
  // is downloaded and extracted once, and the duplicate still gets its own row
  // from the cached outcome. Scoped to this call: it dies with the job, so a
  // re-run always re-reads the provider rather than serving a stale answer.
  const cache = new Map<string, TransformOutcome>();
  const missing = (): TransformOutcome => ({ ok: false, error: "transform returned no result" });

  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= batches.length) return;
      const batch = batches[index]!;

      const identities = batch.map((item) => source.identify(item));

      // Transform only what this batch hasn't already got an outcome for,
      // counting a duplicate inside the batch itself as a hit.
      const pending: number[] = [];
      const queued = new Set<string>();
      identities.forEach((identity, i) => {
        if (cache.has(identity.id) || queued.has(identity.id)) return;
        queued.add(identity.id);
        pending.push(i);
      });

      if (pending.length) {
        const fresh = await runBatch(
          pending.map((i) => batch[i]!),
          transform,
          ctx
        );
        pending.forEach((batchIndex, i) => {
          cache.set(identities[batchIndex]!.id, fresh[i] ?? missing());
        });
      }

      const rows = batch.map((_, i) => {
        const identity = identities[i]!;
        const outcome = cache.get(identity.id) ?? missing();
        if (outcome.ok) {
          progress.succeeded++;
          return [...outcome.cells, identity.label, STATUS_OK];
        }
        progress.failed++;
        // A failure still occupies a row, and that row names the item, so a
        // human can see exactly what was missed and why.
        return [...transform.columns.map(() => "Unknown"), identity.label, `${STATUS_FAILED}: ${outcome.error}`];
      });

      progress.processed += batch.length;

      await writer.add(rows);
      progress.written = writer.rowsWritten;
      report();
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));

  await writer.close();
  progress.written = writer.rowsWritten;
  progress.phase = "done";
  report();

  // ---- 4. Assert the invariant before claiming success -------------------
  const accounted = progress.succeeded + progress.failed;
  if (accounted !== items.length) {
    throw new Error(
      `Job accounting is wrong: discovered ${items.length} items but only ${accounted} were accounted for. Refusing to report success.`
    );
  }

  const expectedRows = items.length + 1; // + header
  if (writer.rowsWritten !== expectedRows) {
    throw new Error(
      `Sheet is incomplete: discovered ${items.length} items (expected ${expectedRows} rows including the header) but the sheet reports ${writer.rowsWritten}.`
    );
  }

  const note =
    `Exported ${progress.succeeded} of ${items.length} items to the sheet` +
    (progress.failed
      ? `. ${progress.failed} could not be processed and are in the sheet as rows marked "failed", so nothing is missing.`
      : ", with no failures.");

  return {
    processed: items.length,
    succeeded: progress.succeeded,
    failed: progress.failed,
    rowsWritten: writer.rowsWritten,
    outputUrl: handle.url,
    note,
    stats,
    breakdown,
  };
}

/**
 * Run one transform batch, converting a total failure into per-item failures.
 *
 * If the transform throws even after retries, each item in the batch still gets
 * an outcome — that is what keeps the count invariant true no matter how the
 * provider misbehaves.
 */
async function runBatch<T>(
  batch: T[],
  transform: JobConfig<T>["transform"],
  ctx: JobConfig<T>["ctx"]
): Promise<TransformOutcome[]> {
  try {
    const outcomes = await withRetry(() => transform.run(batch, ctx), {
      signal: ctx.signal,
      onRetry: (attempt, delay, err) =>
        console.warn(`[job] ${transform.id} batch retry ${attempt} in ${delay}ms: ${err.message}`),
    });

    // A transform that returns the wrong arity would silently misalign rows
    // with items — treat it as a batch failure rather than write bad data.
    if (!Array.isArray(outcomes) || outcomes.length !== batch.length) {
      return batch.map(() => ({
        ok: false as const,
        error: `transform returned ${Array.isArray(outcomes) ? outcomes.length : "non-array"} results for ${batch.length} items`,
      }));
    }
    return outcomes;
  } catch (err: any) {
    const message = String(err?.message ?? err).slice(0, 160);
    return batch.map(() => ({ ok: false as const, error: message }));
  }
}

/**
 * Turn a provider error into something the agent can relay usefully.
 *
 * Composio surfaces a missing/expired connection as an opaque execution error
 * with a nested object, which is unreadable if passed through verbatim.
 */
export function describeDiscoveryFailure(sourceId: string, ref: string, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const toolkit = sourceId.startsWith("github") ? "GitHub" : "Google";

  if (/executing the tool|401|403|unauthorized|forbidden|invalid[_ ]grant|expired/i.test(raw)) {
    return (
      `Could not read ${ref}: the ${toolkit} account may not be connected, or its access expired. ` +
      `Connect ${toolkit} and try again. (${raw.slice(0, 120)})`
    );
  }
  return `Could not read ${ref}: ${raw.slice(0, 200)}`;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
