import { composio, AUTH_CONFIGS } from "./composio";

/**
 * Connect a user's account for a given toolkit.
 * Returns the OAuth URL the user needs to visit, and waits for the connection to complete.
 */
export async function connectAccount(userId: string, toolkit: string) {
  const authConfigId = AUTH_CONFIGS[toolkit];
  if (!authConfigId) {
    throw new Error(
      `No auth config for toolkit "${toolkit}". Available: ${Object.keys(AUTH_CONFIGS).join(", ")}`
    );
  }

  const link = await composio.connectedAccounts.link(userId, authConfigId);
  return link;
}

/**
 * Connect a user to all configured toolkits that need auth.
 * Returns an array of { toolkit, link } objects.
 */
export async function connectAllAccounts(userId: string) {
  const results = [];
  for (const [toolkit, authConfigId] of Object.entries(AUTH_CONFIGS)) {
    const link = await composio.connectedAccounts.link(userId, authConfigId);
    results.push({ toolkit, link });
  }
  return results;
}

/**
 * Get all connected accounts for a user.
 *
 * The filter key is `userIds` (plural, array). Passing `userId` is not a type
 * error the SDK rejects at runtime — it is simply ignored, so the call returns
 * every account in the project rather than this user's.
 */
export async function getConnectedAccounts(userId: string) {
  return composio.connectedAccounts.list({ userIds: [userId] });
}

/**
 * Which toolkits this user can actually use right now.
 *
 * Connection state lives on Composio, not in the browser: the frontend cannot
 * know it from a page load, and a client-side flag set during an OAuth popup
 * is lost on the next refresh. This is the server-side answer.
 *
 * Reported per toolkit rather than per account because that is the question the
 * UI asks. A user accumulates several accounts for one toolkit — re-authorising
 * leaves the previous one EXPIRED beside the new ACTIVE one — so a toolkit is
 * connected when *any* of its accounts is ACTIVE. Keying off the newest account,
 * or off the first one returned, would report a stale EXPIRED row and show a
 * working connection as broken.
 */
export async function getConnectionStatus(userId: string): Promise<Record<string, boolean>> {
  const status: Record<string, boolean> = {};
  for (const toolkit of Object.keys(AUTH_CONFIGS)) status[toolkit] = false;

  const res: any = await getConnectedAccounts(userId);
  const accounts: any[] = res?.items ?? (Array.isArray(res) ? res : []);

  for (const account of accounts) {
    const toolkit = account?.toolkit?.slug ?? account?.toolkitSlug;
    if (!toolkit || !(toolkit in status)) continue;
    if (account?.status === "ACTIVE") status[toolkit] = true;
  }

  return status;
}
