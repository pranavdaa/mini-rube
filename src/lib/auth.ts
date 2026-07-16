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
 */
export async function getConnectedAccounts(userId: string) {
  return composio.connectedAccounts.list({ userId });
}
