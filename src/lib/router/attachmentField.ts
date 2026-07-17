/**
 * Generic detector for "this input field accepts an uploaded file."
 *
 * Composio marks these fields with `file_uploadable: true` in the live schema
 * (verified on GOOGLESUPER_SEND_EMAIL's `attachment` param, which offers a
 * single-file branch and a multi-file array branch under `anyOf`). Reading the
 * flag rather than hardcoding a field name or tool slug is what keeps
 * attachment support a property of the schema, not a special case wired to
 * one tool — a future toolkit with its own upload field works with zero
 * changes here.
 */
export function findFileUploadableField(inputParameters: unknown): string | null {
  const properties = (inputParameters as { properties?: unknown } | undefined)?.properties;
  if (!properties || typeof properties !== "object") return null;

  for (const [key, prop] of Object.entries(properties as Record<string, unknown>)) {
    if (isFileUploadableProp(prop)) return key;
  }
  return null;
}

function isFileUploadableProp(prop: unknown): boolean {
  if (!prop || typeof prop !== "object") return false;
  const p = prop as Record<string, unknown>;

  if (p.file_uploadable === true) return true;
  if (p.type === "array" && isFileUploadableProp(p.items)) return true;

  const branches = [
    ...(Array.isArray(p.anyOf) ? (p.anyOf as unknown[]) : []),
    ...(Array.isArray(p.oneOf) ? (p.oneOf as unknown[]) : []),
  ];
  return branches.some(isFileUploadableProp);
}
