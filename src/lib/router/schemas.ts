import { composio } from "../composio";

/**
 * Lazy full-schema loading.
 *
 * The router's index holds compact metadata only. Full input schemas are
 * fetched here, for the handful of tools actually selected for a turn — never
 * for the catalog. At ~600 tokens a schema, 1,360 tools would be ~800k tokens
 * against a 500k ceiling; ~8 is a few thousand.
 */
export interface FullTool {
  slug: string;
  description?: string;
  inputParameters?: Record<string, unknown>;
  version?: string;
  [key: string]: unknown;
}

/** Schemas are immutable per tool version, so a process-lifetime cache is safe. */
const cache = new Map<string, FullTool>();

/**
 * Fetch full schemas for the given slugs in a single catalog call, reusing
 * anything already seen this process.
 */
export async function loadToolSchemas(slugs: string[]): Promise<Map<string, FullTool>> {
  const missing = slugs.filter((s) => !cache.has(s));

  if (missing.length) {
    const res: any = await composio.tools.getRawComposioTools({ tools: missing } as any);
    const items: any[] = Array.isArray(res) ? res : (res?.items ?? []);
    for (const item of items) {
      const slug = item?.slug ?? item?.name;
      if (slug) cache.set(slug, item as FullTool);
    }
  }

  const out = new Map<string, FullTool>();
  for (const slug of slugs) {
    const tool = cache.get(slug);
    if (tool) out.set(slug, tool);
  }
  return out;
}

export function clearSchemaCache(): void {
  cache.clear();
}
