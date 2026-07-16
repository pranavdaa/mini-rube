/**
 * Context guard for tool results.
 *
 * A tool result goes straight into the model's context, and live results are
 * routinely enormous: GOOGLESUPER_FETCH_EMAILS with max_results=5 returns
 * ~518KB (~130k tokens) for *five* emails, because every message carries its
 * full MIME `payload` (~16KB) plus `messageText`. That overruns the model's
 * window on its own — the turn hangs before it can answer.
 *
 * Strategy: find the result's record list and prune *within* each record,
 * dropping oversized fields (bodies, MIME trees, blobs) while keeping the
 * identifying ones — for an email: sender, subject, timestamp, preview,
 * labels. Every record survives; only the bulk inside them goes.
 *
 * It keys off field *size*, not field names, so a GitHub issue's `body` or a
 * Drive file's content is handled the same way with no per-tool code.
 *
 * This is a guard, not a triage strategy. Reading 100 emails and ranking them
 * belongs in a server-side job (a later task); this only guarantees that no
 * single tool result can blow the context.
 */

/** Results at or under this fit comfortably; leave them untouched. */
const RESULT_BUDGET_CHARS = 32_000;

/** A field bigger than this is a body/blob, not an identifying value. */
const FIELD_BUDGET_CHARS = 400;

export interface CompactionReport {
  compacted: boolean;
  originalChars: number;
  finalChars: number;
  droppedFields: string[];
  omittedItems: number;
}

export function compactToolResult(result: unknown): { result: unknown; report: CompactionReport } {
  const originalChars = safeSize(result);
  const report: CompactionReport = {
    compacted: false,
    originalChars,
    finalChars: originalChars,
    droppedFields: [],
    omittedItems: 0,
  };

  if (originalChars <= RESULT_BUDGET_CHARS) return { result, report };

  const clone = structuredCloneSafe(result);
  const dropped = new Set<string>();

  const records = findRecordArray(clone);
  if (records) {
    // Prune inside each record, keeping the list complete.
    records.holder[records.key] = records.array.map((item) => pruneFields(item, dropped));

    // Still over budget: too many records rather than too-fat ones. Trim, and
    // say so — silently losing rows is never acceptable.
    if (safeSize(clone) > RESULT_BUDGET_CHARS) {
      const pruned = records.holder[records.key] as unknown[];
      let keep = pruned.length;
      while (keep > 1 && safeSize(clone) > RESULT_BUDGET_CHARS) {
        keep = Math.max(1, Math.floor(keep * 0.75));
        records.holder[records.key] = pruned.slice(0, keep);
      }
      report.omittedItems = pruned.length - keep;
    }
  } else {
    // No record list — a single fat object. Prune its fields directly.
    const pruned = pruneFields(clone, dropped);
    return finish(pruned, report, dropped);
  }

  return finish(clone, report, dropped);
}

function finish(
  value: unknown,
  report: CompactionReport,
  dropped: Set<string>
): { result: unknown; report: CompactionReport } {
  report.compacted = true;
  report.droppedFields = [...dropped].sort();
  report.finalChars = safeSize(value);
  return { result: attachNote(value, report), report };
}

/** Drop fields whose serialized value exceeds the field budget. */
function pruneFields(value: unknown, dropped: Set<string>): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => pruneFields(v, dropped));

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (safeSize(val) > FIELD_BUDGET_CHARS) {
      dropped.add(key);
      continue;
    }
    out[key] = val;
  }
  return out;
}

/**
 * The result's primary record list: the longest array of objects. This is the
 * thing the user asked for (messages, issues, files) and must survive.
 */
function findRecordArray(
  value: unknown
): { holder: Record<string, unknown>; key: string; array: unknown[] } | null {
  let best: { holder: Record<string, unknown>; key: string; array: unknown[] } | null = null;

  const walk = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 6) return;
    for (const [key, val] of Object.entries(node)) {
      if (Array.isArray(val) && val.some((v) => v && typeof v === "object")) {
        if (!best || safeSize(val) > safeSize(best.array)) {
          best = { holder: node as Record<string, unknown>, key, array: val };
        }
        continue; // don't descend into records; pruneFields handles them
      }
      walk(val, depth + 1);
    }
  };

  walk(value, 0);
  return best;
}

/**
 * Tell the model what was removed, so it reports honestly instead of assuming
 * it saw everything.
 */
function attachNote(result: unknown, report: CompactionReport): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;

  const parts = [
    `Oversized fields were removed to fit context: ${report.droppedFields.join(", ") || "none"}. ` +
      `Ask for a specific record if you need its full content.`,
  ];
  if (report.omittedItems > 0) {
    parts.push(
      `${report.omittedItems} further items were omitted — narrow the query or request a smaller page to see them.`
    );
  }

  return { ...(result as Record<string, unknown>), _note: parts.join(" ") };
}

function structuredCloneSafe<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function safeSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0; // circular/non-serializable — nothing we can usefully compact
  }
}
