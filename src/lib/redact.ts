/**
 * Third-party email redaction.
 *
 * contactRefs.ts already stops a real resolved address from ever reaching the
 * model's context (it's replaced with an opaque token at the tool-result
 * source). This is the second, mechanical layer, for anything that isn't a
 * tracked token — a stray real address slipping through some other tool, or a
 * user-supplied one the model paraphrases. It scrubs any email-shaped
 * substring from outgoing text and tool activity unless it's allow-listed
 * (the user's own address, fine to echo back — see identity.ts) or is itself
 * a contact token (already an opaque placeholder — masking it further would
 * only corrupt it before it can round-trip back to a real address later).
 */

import { isContactToken } from "./contactRefs";

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** `k***@example.com` — enough to confirm which inbox, never enough to reuse. */
export function maskEmailAddress(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return domain ? `${local.slice(0, 1)}***@${domain}` : "***";
}

/** Replace every email in `text` with a masked form, except allow-listed addresses and contact tokens. */
export function scrubEmails(text: string, allow: ReadonlySet<string>): string {
  return text.replace(EMAIL_RE, (match) => {
    if (isContactToken(match)) return match;
    return allow.has(match.toLowerCase()) ? match : maskEmailAddress(match);
  });
}

/** Recursively scrub string leaves of a tool call's args/result. Never mutates the input. */
export function scrubDeep<T>(value: T, allow: ReadonlySet<string>): T {
  if (typeof value === "string") return scrubEmails(value, allow) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, allow)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubDeep(v, allow);
    return out as T;
  }
  return value;
}

/** A character an email address (or the rest of one still arriving) could contain. */
const EMAIL_TOKEN_CHAR = /[A-Za-z0-9._%+\-@]/;

/**
 * A trailing run of email-token characters this long with no boundary in
 * sight is not an in-progress email — no real address is anywhere near this
 * long. Forces a release so a pathological unbroken token (a hash, a long
 * slug) can't buffer forever.
 */
const HARD_RELEASE_CAP = 300;

/**
 * Buffered scrubber for a token stream.
 *
 * An email can be split across two text-delta chunks ("kar" + "an@x.com"),
 * and a *fixed-length* trailing buffer doesn't fix that: once the buffer is
 * full, each new delta releases the buffer's oldest character regardless of
 * whether that character sits inside an in-progress email — releasing one
 * "kar" fragment now and "an@x.com" later, each too short on its own to match
 * the email pattern. This releases on a real boundary instead: only up to the
 * last character that *cannot* be part of an email token (whitespace or
 * punctuation an email never contains). Everything after that boundary might
 * still be a growing token, so it's held back whole — never split mid-token.
 */
export function createStreamScrubber(allow: ReadonlySet<string>) {
  let pending = "";
  return {
    push(delta: string): string {
      pending += delta;

      let boundary = pending.length - 1;
      while (boundary >= 0 && EMAIL_TOKEN_CHAR.test(pending[boundary]!)) boundary--;

      if (boundary < 0) {
        if (pending.length <= HARD_RELEASE_CAP) return "";
        boundary = pending.length - HARD_RELEASE_CAP - 1; // force progress either way
      }

      const emit = pending.slice(0, boundary + 1);
      pending = pending.slice(boundary + 1);
      return emit ? scrubEmails(emit, allow) : "";
    },
    flush(): string {
      const out = scrubEmails(pending, allow);
      pending = "";
      return out;
    },
  };
}
