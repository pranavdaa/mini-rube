import type { CompactTool } from "./types";

/**
 * Provider hint tags. These are structured metadata, not vocabulary, so they
 * are lifted into typed flags and kept *out* of the text index.
 *
 * Indexing them would be actively harmful: `important` sits on 359 of the 1,360
 * live tools, so a synonym expansion reaching it (urgent -> important) would
 * apply a meaningless boost to a quarter of the catalog at full tag weight.
 * That is the synonym blowout the IDF cap exists to prevent — better to not
 * feed metadata to the scorer at all.
 */
const HINT_TAGS = new Set([
  "important",
  "readOnlyHint",
  "updateHint",
  "createHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
  "deprecated",
  // Provider's "hide from MCP surfaces" marker (568 github tools). Metadata,
  // not meaning. Stripped from the index; not otherwise used as a signal.
  "mcpIgnore",
]);

/**
 * Map one raw tool from the live Composio catalog to compact metadata.
 *
 * Field mapping is against the live v3 shape, verified 2026-07-16:
 *   { slug, name, description, inputParameters, tags, toolkit: {slug},
 *     version, isDeprecated, ... }
 * Note `displayName` does not exist on this shape — `name` is the display name.
 */
export function normalizeTool(raw: any, fallbackToolkit: string): CompactTool {
  const rawTags: string[] = Array.isArray(raw?.tags) ? raw.tags : [];
  const tags = rawTags.filter((t) => !HINT_TAGS.has(t));

  // Field *names* only — the schema itself never enters the index.
  const inputFields = Object.keys(raw?.inputParameters?.properties ?? {});

  return {
    slug: raw?.slug ?? raw?.name,
    toolkit: String(raw?.toolkit?.slug ?? fallbackToolkit).toLowerCase(),
    name: raw?.name ?? raw?.slug ?? "",
    description: raw?.description ?? "",
    tags,
    inputFields,
    version: raw?.version,
    important: rawTags.includes("important"),
    readonly: readonlyFromTags(rawTags),
    deprecated: raw?.isDeprecated === true || rawTags.includes("deprecated"),
  };
}

/**
 * Read/write metadata from the provider's own hints.
 *
 * Left undefined when the provider says nothing, so callers can fall back to
 * the slug verb rather than guessing "write" and demoting a read tool.
 */
function readonlyFromTags(tags: string[]): boolean | undefined {
  if (tags.includes("readOnlyHint")) return true;
  if (
    tags.includes("updateHint") ||
    tags.includes("createHint") ||
    tags.includes("destructiveHint")
  ) {
    return false;
  }
  return undefined;
}
