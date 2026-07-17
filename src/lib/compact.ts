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
  /** Fields kept but shortened rather than dropped (errors, status). */
  shortenedFields: string[];
  omittedItems: number;
}

export function compactToolResult(result: unknown): { result: unknown; report: CompactionReport } {
  const originalChars = safeSize(result);
  const report: CompactionReport = {
    compacted: false,
    originalChars,
    finalChars: originalChars,
    droppedFields: [],
    shortenedFields: [],
    omittedItems: 0,
  };

  if (originalChars <= RESULT_BUDGET_CHARS) return { result, report };

  const clone = structuredCloneSafe(result);
  const dropped = new Set<string>();
  const shortened = new Set<string>();

  // Shorten preserved top-level fields *first*. A 110KB error page keeps the
  // result over budget on its own, and the item cap below would then throw away
  // perfectly good records trying to claw back space the error is occupying.
  condensePreservedInPlace(clone, shortened);

  // ALL record arrays, not just the largest. An aliased GraphQL query for
  // "open and closed issues" returns two sibling arrays; compacting only one
  // let the other ride into context whole — seen live as 517k → 253k chars
  // (~63k tokens), eight times the budget, with the guard reporting success.
  const arrays = findRecordArrays(clone);

  if (!arrays.length) {
    // No record list — a single fat object. Prune its fields directly.
    const pruned = pruneFields(clone, dropped, shortened);
    return finish(pruned, report, dropped, shortened);
  }

  // Prune inside every record of every list, keeping the lists complete.
  for (const found of arrays) {
    found.holder[found.key] = (found.holder[found.key] as unknown[]).map((item) =>
      pruneFields(item, dropped, shortened)
    );
  }

  // Still over budget: too many records rather than too-fat ones. Trim the
  // currently-largest list, re-measure, repeat — and say so; silently losing
  // rows is never acceptable.
  let guard = 200; // paranoid bound; each pass shrinks something by 25%
  while (safeSize(clone) > RESULT_BUDGET_CHARS && guard-- > 0) {
    let biggest: { found: FoundArray; size: number } | null = null;
    for (const found of arrays) {
      const list = found.holder[found.key] as unknown[];
      if (!Array.isArray(list) || list.length <= 1) continue;
      const size = safeSize(list);
      if (!biggest || size > biggest.size) biggest = { found, size };
    }
    if (!biggest) break; // every list is already down to one item

    const list = biggest.found.holder[biggest.found.key] as unknown[];
    const keep = Math.max(1, Math.floor(list.length * 0.75));
    report.omittedItems += list.length - keep;
    biggest.found.holder[biggest.found.key] = list.slice(0, keep);
  }

  return finish(clone, report, dropped, shortened);
}

function finish(
  value: unknown,
  report: CompactionReport,
  dropped: Set<string>,
  shortened: Set<string> = new Set()
): { result: unknown; report: CompactionReport } {
  report.compacted = true;
  report.droppedFields = [...dropped].sort();
  report.shortenedFields = [...shortened].sort();
  report.finalChars = safeSize(value);

  // Unconditional backstop. Everything above is best-effort against shapes we
  // understand; this line is the actual guarantee. A result the structural
  // passes couldn't shrink (arrays nested past the walk depth, ten thousand
  // small fields, whatever arrives next) gets truncated wholesale rather than
  // handed to the model over budget — the one thing this module must never do.
  if (report.finalChars > RESULT_BUDGET_CHARS) {
    const source = value as Record<string, unknown> | null;
    const truncated: Record<string, unknown> = {
      successful: source && typeof source === "object" ? (source.successful ?? undefined) : undefined,
      error: source && typeof source === "object" && source.error ? condense(source.error) : undefined,
      truncated_preview: safeStringify(value).slice(0, RESULT_BUDGET_CHARS / 2),
      _note:
        "This result was far too large for context and its structure could not be compacted, " +
        "so it was truncated wholesale. The preview is the beginning of the raw result. " +
        "Re-request with filters or a smaller page size for usable data.",
    };
    report.finalChars = safeSize(truncated);
    return { result: truncated, report };
  }

  return { result: attachNote(value, report), report };
}

/**
 * Fields that must never be dropped, only shortened.
 *
 * This is the one deliberate exception to "key off size, not names". An
 * oversized body is noise, but an oversized *error* is the single most
 * important thing in a failed result, and dropping it is worse than useless —
 * it is actively misleading.
 *
 * Seen live: a Composio GitHub call failed with a 110KB HTML error page. The
 * error field blew the field budget, so it was dropped, and the model — handed
 * a 47-character result with no information — invented three plausible causes
 * ("repository not found or private / rate limiting / network issues"), none of
 * them true. Truncating instead lets it report what actually happened.
 */
const PRESERVED_FIELDS = new Set(["error", "message", "successful", "status", "statusCode"]);

/** Enough to identify a failure; far short of a 110KB stack of markup. */
const PRESERVED_FIELD_CHARS = 300;

/** How deep pruning may recurse into containers before giving up on them. */
const PRUNE_MAX_DEPTH = 8;

/**
 * Drop oversized *leaves*; recurse into oversized *containers*.
 *
 * The distinction matters: a 16KB string is a body and goes, but a 16KB object
 * usually holds a couple of huge leaves among genuinely useful small fields.
 * Dropping the container throws out the good with the bad — an email's
 * `payload` loses its tiny `mimeType` along with the 16KB `raw`, and on the
 * no-record-list path an entire `data` container can vanish, handing the model
 * `{}` (seen as the "59 chars, zero messages" bug). Recursing keeps the
 * structure and sheds only the bulk.
 */
function pruneFields(
  value: unknown,
  dropped: Set<string>,
  shortened?: Set<string>,
  depth = 0
): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => pruneFields(v, dropped, shortened, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (safeSize(val) > FIELD_BUDGET_CHARS) {
      if (PRESERVED_FIELDS.has(key)) {
        out[key] = condense(val);
        shortened?.add(key);
        continue;
      }
      if (val && typeof val === "object" && depth < PRUNE_MAX_DEPTH) {
        out[key] = pruneFields(val, dropped, shortened, depth + 1);
        continue;
      }
      dropped.add(key);
      continue;
    }
    out[key] = val;
  }
  return out;
}

/**
 * Shorten oversized preserved fields on an object, in place, touching nothing
 * else. Used when a record list must survive untouched but the result also
 * carries a huge error.
 */
function condensePreservedInPlace(value: unknown, shortened: Set<string>): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (PRESERVED_FIELDS.has(key) && safeSize(obj[key]) > FIELD_BUDGET_CHARS) {
      obj[key] = condense(obj[key]);
      shortened.add(key);
    }
  }
}

/**
 * Reduce an oversized value to something a model can actually report.
 *
 * HTML gets special handling because provider errors arrive as whole error
 * pages: the <title> ("Unicorn! · GitHub") says more about what happened than
 * 300 characters of doctype and inline CSS ever would.
 */
export function condense(value: unknown): string {
  const text = typeof value === "string" ? value : safeStringify(value);

  if (/<html[\s>]|<!doctype html/i.test(text)) {
    const title = text.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim();
    const stripped = text
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&middot;/g, "·")
      .replace(/\s+/g, " ")
      .trim();
    const summary = `The provider returned an HTML error page${title ? ` titled "${decodeEntities(title)}"` : ""}, not a normal response. This is a provider-side failure, not a problem with the request.`;
    return `${summary} Page text: ${stripped.slice(0, 160)}`;
  }

  return text.length > PRESERVED_FIELD_CHARS ? `${text.slice(0, PRESERVED_FIELD_CHARS)}…` : text;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&middot;/g, "·")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Every record list in the result: arrays of objects, however many. These are
 * the things the user asked for (messages, issues, files) and must survive.
 *
 * All of them, not the largest: an aliased GraphQL query returns sibling lists
 * (openIssues.nodes, closedIssues.nodes), and any list this walk misses is a
 * list the compactor leaves in context at full size.
 */
interface FoundArray {
  holder: Record<string, unknown>;
  key: string;
}

function findRecordArrays(value: unknown): FoundArray[] {
  const found: FoundArray[] = [];

  const walk = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 6) return;
    for (const [key, val] of Object.entries(node)) {
      if (Array.isArray(val) && val.some((v) => v && typeof v === "object")) {
        found.push({ holder: node as Record<string, unknown>, key });
        continue; // don't descend into records; pruneFields handles them
      }
      walk(val, depth + 1);
    }
  };

  walk(value, 0);
  return found;
}

/**
 * Tell the model what was removed, so it reports honestly instead of assuming
 * it saw everything.
 */
function attachNote(result: unknown, report: CompactionReport): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;

  const parts: string[] = [];
  if (report.droppedFields.length) {
    parts.push(
      `Oversized fields were removed to fit context: ${report.droppedFields.join(", ")}. ` +
        `Ask for a specific record if you need its full content.`
    );
  }
  if (report.shortenedFields.length) {
    // Say it was shortened, not removed — the model should report what it says,
    // not treat it as missing and guess.
    parts.push(
      `These fields were shortened, not removed: ${report.shortenedFields.join(", ")}. ` +
        `Report what they say rather than speculating about the cause.`
    );
  }
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
