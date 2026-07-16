import { executeTool } from "./tools";

/**
 * Who the connected user is.
 *
 * "Send an email to me" cannot be honoured by guessing — inventing a recipient
 * is exactly the failure mode we refuse. So resolve the user's own address from
 * their connected account and let the model use it. Resolution is best-effort:
 * when it fails, the model is told nothing and asks instead of assuming.
 *
 * This is the user's *own* address. Third-party addresses stay private and are
 * never printed back to the user.
 */
const cache = new Map<string, string | null>();

export async function getUserEmail(userId: string): Promise<string | null> {
  if (cache.has(userId)) return cache.get(userId)!;

  let email: string | null = null;
  try {
    const res: any = await executeTool("GOOGLESUPER_GET_PROFILE", userId, {});
    const data = res?.data ?? {};
    email = data.emailAddress ?? data.email ?? data.response_data?.emailAddress ?? null;
  } catch {
    email = null; // not connected, or the tool failed — the model will ask.
  }

  cache.set(userId, email);
  return email;
}

/** Mask an address for logs: never write a full private address to the console. */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 2)}***@${domain}`;
}

export function clearIdentityCache(): void {
  cache.clear();
}
