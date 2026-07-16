import { composio } from "./composio";

/**
 * Get a single tool by slug.
 */
export async function getTool(slug: string) {
  const results = await composio.tools.getRawComposioTools({ tools: [slug] });
  return results[0] ?? null;
}

/**
 * List all available tool slugs for the given toolkits.
 */
export async function listToolSlugs(
  toolkits: string[] = ["googlesuper", "github", "composio_search"]
) {
  const tools = await composio.tools.getRawComposioTools({ toolkits, limit: 500 });
  return tools.map((t) => ({ slug: t.slug ?? t.name, description: t.description ?? "" }));
}

/**
 * Execute a Composio tool by name.
 */
export async function executeTool(
  toolName: string,
  userId: string,
  args: Record<string, unknown> = {}
) {
  return composio.tools.execute(toolName, {
    userId,
    dangerouslySkipVersionCheck: true,
    arguments: args,
  });
}
