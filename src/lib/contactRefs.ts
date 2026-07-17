/**
 * Opaque contact references.
 *
 * Text redaction (redact.ts) hides a resolved email from anything the model
 * *says*, but that alone breaks multi-turn conversations: once masked, the
 * real address is gone from history, and a later turn that needs to reuse it
 * (e.g. the user supplying the missing event time, with no fresh contacts
 * search routed this turn) has nothing to work with — and will invent one.
 * Confirmed live: fixing the text redaction bug immediately surfaced this,
 * because the model fabricated a plausible-looking address to fill the gap.
 *
 * The real fix is to never let the address enter the model's context at all.
 * A contact search's result gets its email fields replaced with a stable,
 * syntactically email-shaped opaque token before the model ever sees it; the
 * model treats the token exactly like an email (copies it into the next tool
 * call's attendee field, same as it would a real address) without ever
 * learning the real value. The token is deterministic from the address, so
 * the same contact maps to the same token across turns — the model can keep
 * reusing it from conversation history — and execution-time substitution
 * resolves it back to the real address right before the actual Composio
 * call. A user-typed literal address (not from a lookup) is untouched: this
 * only intercepts addresses that passed through a tool result.
 */

const TOKEN_DOMAIN = "contacts.internal";
const TOKEN_RE = /^ref-[a-f0-9]{8}@contacts\.internal$/i;

/**
 * A specimen token, for explaining the shape to the model.
 *
 * Exported so the system prompt can't drift from the real format: the model
 * must be told these are legitimate, or it sees a plainly fake-looking address
 * and refuses to use a contact it just resolved (verified live).
 */
export const CONTACT_TOKEN_EXAMPLE = `ref-1a2b3c4d@${TOKEN_DOMAIN}`;
const EMAIL_RE_FULL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

const tokenToEmail = new Map<string, string>();

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function tokenFor(email: string): string {
  const token = `ref-${fnv1a(email.toLowerCase())}@${TOKEN_DOMAIN}`;
  tokenToEmail.set(token, email);
  return token;
}

/**
 * True for a string minted by `tokenFor`. It's syntactically email-shaped on
 * purpose (so the model treats it exactly like any other address), which
 * means the wire-level email redaction (redact.ts) would otherwise mask it
 * too — corrupting it before it can round-trip back to a real address on a
 * later turn. redact.ts exempts anything this returns true for.
 */
export function isContactToken(value: string): boolean {
  return TOKEN_RE.test(value);
}

/**
 * Replace every email-shaped string leaf in a tool result with its opaque
 * token. Generic by shape (a whole-string email match), not tied to any one
 * tool's field names — so it works for GOOGLESUPER_SEARCH_PEOPLE,
 * GET_CONTACTS, GET_PEOPLE, or anything else that ever returns an address.
 */
export function tokenizeContactEmails<T>(value: T): T {
  if (typeof value === "string") {
    if (EMAIL_RE_FULL.test(value) && !TOKEN_RE.test(value)) {
      return tokenFor(value) as unknown as T;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => tokenizeContactEmails(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = tokenizeContactEmails(v);
    return out as T;
  }
  return value;
}

/**
 * Resolve any opaque contact tokens in a tool call's arguments back to real
 * addresses, right before execution. Anything that isn't a known token —
 * including a real address the user typed directly — passes through as-is.
 */
export function resolveContactTokens<T>(value: T): T {
  if (typeof value === "string") {
    const real = tokenToEmail.get(value.toLowerCase());
    return (real ?? value) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => resolveContactTokens(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveContactTokens(v);
    return out as T;
  }
  return value;
}

export function clearContactTokenCache(): void {
  tokenToEmail.clear();
}
