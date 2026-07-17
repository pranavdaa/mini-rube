import { composio } from "../composio";
import { normalizeTool } from "./normalize";
import { LOCAL_CAPABILITIES, toCompactTool } from "../local/capabilities";
import type { CompactTool } from "./types";

/**
 * Toolkits the router indexes. Adding a toolkit is a config line, not a code
 * change — set COMPOSIO_TOOLKITS=googlesuper,github,slack to extend.
 */
export const TOOLKITS: string[] = (process.env.COMPOSIO_TOOLKITS ?? "googlesuper,github")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/**
 * Requested per toolkit. Must exceed any real toolkit's size — `limit` is not
 * pagination, it's a truncation point (see assertNotTruncated).
 */
const FETCH_LIMIT = 2000;

/**
 * `limit` truncates the catalog **alphabetically**, it does not paginate.
 * Verified against the live API 2026-07-16:
 *
 *   getRawComposioTools({toolkits:['github'], limit:100})
 *     -> 100 tools, GITHUB_ABORT_... through GITHUB_CREATE_A_PROJECT_COLUMN
 *     -> GITHUB_LIST_REPOSITORY_ISSUES silently does not exist
 *
 * There is no cursor on this endpoint, so completeness rests entirely on
 * requesting more than the toolkit holds. A response that exactly fills the
 * limit is indistinguishable from a truncated one, so treat it as a failure
 * rather than indexing a catalog with silent holes.
 */
function assertNotTruncated(toolkit: string, count: number): void {
  if (count >= FETCH_LIMIT) {
    throw new Error(
      `Catalog for "${toolkit}" returned ${count} tools, filling the requested ` +
        `limit of ${FETCH_LIMIT}. The response is alphabetically truncated and ` +
        `tools are missing. Raise FETCH_LIMIT above the toolkit's true size.`
    );
  }
}

/** Fetch one toolkit's complete catalog as compact metadata. */
export async function fetchToolkitCatalog(toolkit: string): Promise<CompactTool[]> {
  const res: any = await composio.tools.getRawComposioTools({
    toolkits: [toolkit],
    limit: FETCH_LIMIT,
  } as any);

  const items: any[] = Array.isArray(res) ? res : (res?.items ?? []);
  assertNotTruncated(toolkit, items.length);

  return items.map((item) => normalizeTool(item, toolkit)).filter((t) => !!t.slug);
}

/**
 * Fetch every configured toolkit's complete catalog, plus locally-implemented
 * capabilities (see lib/local/capabilities.ts). Local capabilities are indexed
 * and scored by the exact same router as real Composio tools — a new one is a
 * registry entry, not a special case here.
 */
export async function fetchCatalog(toolkits: string[] = TOOLKITS): Promise<CompactTool[]> {
  const perToolkit = await Promise.all(toolkits.map(fetchToolkitCatalog));

  const tools: CompactTool[] = [];
  const seen = new Set<string>();
  for (const list of perToolkit) {
    for (const tool of list) {
      if (seen.has(tool.slug)) continue;
      seen.add(tool.slug);
      tools.push(tool);
    }
  }
  for (const cap of LOCAL_CAPABILITIES) {
    const tool = toCompactTool(cap);
    if (seen.has(tool.slug)) continue;
    seen.add(tool.slug);
    tools.push(tool);
  }
  return tools;
}

/**
 * In-memory catalog cache. The promise itself is cached so concurrent callers
 * share one fetch rather than racing to load 1,360 tools several times over.
 */
let cached: Promise<CompactTool[]> | null = null;

export function loadCatalog(): Promise<CompactTool[]> {
  if (!cached) {
    cached = fetchCatalog().catch((err) => {
      cached = null; // don't cache a failure — let the next caller retry
      throw err;
    });
  }
  return cached;
}

/** Drop the cache (tests, or to pick up a catalog change without a restart). */
export function clearCatalogCache(): void {
  cached = null;
}

/** Per-toolkit counts, for startup logging and completeness assertions. */
export function catalogCounts(tools: CompactTool[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of tools) counts[t.toolkit] = (counts[t.toolkit] ?? 0) + 1;
  return counts;
}

/**
 * Fingerprint of the catalog's contents: every slug at its exact version.
 *
 * Used to key caches, so a cached decision is discarded the moment Composio
 * ships a tool change rather than being served against a catalog that no longer
 * exists. FNV-1a — not cryptographic, just a stable content hash.
 */
export function catalogVersion(tools: CompactTool[]): string {
  const signature = tools
    .map((t) => `${t.slug}@${t.version ?? "?"}`)
    .sort()
    .join("\n");

  let hash = 0x811c9dc5;
  for (let i = 0; i < signature.length; i++) {
    hash ^= signature.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
