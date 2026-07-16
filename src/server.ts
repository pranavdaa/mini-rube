import { type CoreMessage } from "ai";
import { AUTH_CONFIGS } from "./lib/composio";
import { connectAccount } from "./lib/auth";
import { getTool } from "./lib/tools";
import { getRouter } from "./lib/router/router";
import { runTurn } from "./lib/agent";

/**
 * The user the OAuth connection is bound to. Auth, connection status, and every
 * tool execution must use this same id — a mismatch fails at execution time
 * while still reporting the account as "connected".
 */
const USER_ID = "candidate";

// pending OAuth connections waiting for completion
const pendingConnections = new Map<string, Awaited<ReturnType<typeof connectAccount>>>();

/**
 * Vestigial: the scaffold's manual tool picker. Chat no longer reads this —
 * tools are routed per turn (see lib/agent.ts) — but /api/tool and
 * /api/tool/set stay so the current frontend keeps working until the UX task
 * replaces the picker with router step-rows.
 */
let activeComposioTool = await getTool("GOOGLESUPER_SEND_EMAIL");
if (!activeComposioTool) {
  throw new Error("Failed to load GOOGLESUPER_SEND_EMAIL tool");
}

Bun.serve({
  port: 3001,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // /api/connect/:toolkit
    if (path.startsWith("/api/connect/") && req.method === "POST" && !path.endsWith("/wait")) {
      const toolkit = path.split("/")[3];
      if (!AUTH_CONFIGS[toolkit as keyof typeof AUTH_CONFIGS]) {
        return Response.json(
          { error: `Unknown toolkit: ${toolkit}. Available: ${Object.keys(AUTH_CONFIGS).join(", ")}` },
          { status: 400 }
        );
      }
      try {
        const link = await connectAccount(USER_ID, toolkit);
        pendingConnections.set(toolkit, link);
        return Response.json({ redirectUrl: link.redirectUrl, id: link.id });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // /api/connect/:toolkit/wait
    if (path.startsWith("/api/connect/") && path.endsWith("/wait") && req.method === "POST") {
      const toolkit = path.split("/")[3];
      const link = pendingConnections.get(toolkit);
      if (!link) {
        return Response.json({ error: "No pending connection for " + toolkit }, { status: 400 });
      }
      try {
        await link.waitForConnection(60_000);
        pendingConnections.delete(toolkit);
        return Response.json({ connected: true, toolkit });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // /api/tool
    if (path === "/api/tool" && req.method === "GET") {
      return Response.json({ slug: activeComposioTool!.slug ?? activeComposioTool!.name });
    }

    // /api/tool/set
    if (path === "/api/tool/set" && req.method === "POST") {
      const body = await req.json();
      const slug = body.slug;
      if (!slug) {
        return Response.json({ error: "slug required" }, { status: 400 });
      }
      try {
        const t = await getTool(slug);
        if (!t) {
          return Response.json({ error: `Tool "${slug}" not found` }, { status: 404 });
        }
        activeComposioTool = t;
        return Response.json({ slug: t.slug ?? t.name });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // /api/tools — served from the router's complete catalog. The scaffold's
    // listToolSlugs({limit: 500}) truncates alphabetically against 1,360 tools,
    // so it silently omitted everything past the cut (GITHUB_LIST_REPOSITORY_
    // ISSUES among them).
    if (path === "/api/tools" && req.method === "GET") {
      try {
        const router = await getRouter();
        return Response.json({
          tools: router.all.map((t) => ({ slug: t.slug, description: t.description })),
          counts: router.counts,
          total: router.toolCount,
        });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // /api/chat — router-driven: the tools are chosen per turn, not hardcoded.
    if (path === "/api/chat" && req.method === "POST") {
      const body = await req.json();
      const messages: CoreMessage[] = body.messages ?? [];

      try {
        // route → bound selection → lazy schemas → model. See lib/agent.ts.
        const { result } = await runTurn(messages, USER_ID);
        return result.toDataStreamResponse();
      } catch (err: any) {
        console.error(`[chat] ${err.message}`);
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log("Server running at http://localhost:3001");
