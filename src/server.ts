import { StreamData, type CoreMessage } from "ai";
import { AUTH_CONFIGS } from "./lib/composio";
import { connectAccount, getConnectionStatus } from "./lib/auth";
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

Bun.serve({
  port: 3001,
  // Bun's default idleTimeout is 10s of no bytes written — but a single tool
  // execution can legitimately run longer than that with nothing to say (the
  // 100-email triage takes ~11s), and the default was silently killing the
  // response mid-turn: the UI froze on a half-finished answer. 255 is Bun's
  // maximum. Long *jobs* additionally stream progress events, so a genuinely
  // hung connection still dies — just not a healthy one that's merely quiet.
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // /api/connections — server-side connection state, so the UI survives a
    // reload. Also names the toolkits, so the frontend renders whatever is
    // configured rather than a hardcoded pair.
    if (path === "/api/connections" && req.method === "GET") {
      try {
        const connections = await getConnectionStatus(USER_ID);
        return Response.json({ toolkits: Object.keys(AUTH_CONFIGS), connections });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // /api/connect/:toolkit
    if (path.startsWith("/api/connect/") && req.method === "POST" && !path.endsWith("/wait")) {
      const toolkit = path.split("/")[3] ?? "";
      if (!AUTH_CONFIGS[toolkit]) {
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
      const toolkit = path.split("/")[3] ?? "";
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
      // The browser's own IANA zone, if the frontend sent one — a stronger
      // signal than the server process's timezone, which isn't the user's.
      // Falls back to DEFAULT_TIMEZONE in lib/agent.ts when absent/invalid.
      const timezone: string | undefined = typeof body.timezone === "string" ? body.timezone : undefined;

      // Side channel for the turn's activity (routing, executions, job
      // progress). It rides alongside the text stream, so a two-minute export
      // reports itself while it runs instead of leaving a blank pane.
      const data = new StreamData();
      // Numbered per user message so the UI can attach each turn's activity to
      // the message that caused it.
      const turn = messages.filter((m) => m.role === "user").length;

      try {
        // route → bound selection → lazy schemas → model. See lib/agent.ts.
        const { result } = await runTurn(messages, USER_ID, {
          timezone,
          turn,
          emit: (event) => data.append(event as any),
          // Closing is not optional: an open StreamData keeps the HTTP response
          // open forever, so the browser would stream text and then hang.
          onFinish: () => data.close(),
        });

        return result.toDataStreamResponse({ data });
      } catch (err: any) {
        console.error(`[chat] ${err.message}`);
        await data.close();
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
