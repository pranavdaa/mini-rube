import { createOpenAI } from "@ai-sdk/openai";
import { streamText, tool, jsonSchema, type CoreMessage } from "ai";
import { AUTH_CONFIGS } from "./lib/composio";
import { connectAccount } from "./lib/auth";
import { getTool, executeTool, listToolSlugs } from "./lib/tools";

const USER_ID = "candidate";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY is not set");
}

const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: OPENROUTER_API_KEY,
});

// pending OAuth connections waiting for completion
const pendingConnections = new Map<string, Awaited<ReturnType<typeof connectAccount>>>();

// the currently loaded tool — starts with just GOOGLESUPER_SEND_EMAIL.
// your job is to build a router that picks the right tool(s) for each prompt.
let activeComposioTool = await getTool("GOOGLESUPER_SEND_EMAIL");
if (!activeComposioTool) {
  throw new Error("Failed to load GOOGLESUPER_SEND_EMAIL tool");
}

// convert a composio tool into an AI SDK tool
function makeAITool(composioTool: NonNullable<typeof activeComposioTool>) {
  const slug = composioTool.slug ?? composioTool.name;
  return {
    [slug]: tool({
      description: composioTool.description ?? slug,
      parameters: jsonSchema(
        composioTool.inputParameters ?? { type: "object", properties: {} }
      ),
      execute: async (args: Record<string, unknown>) => {
        console.log(`[tool] ${slug}`, args);
        try {
          return await executeTool(slug, USER_ID, args);
        } catch (err: any) {
          console.error(`[tool error] ${slug}:`, err.message, err.cause ?? "", JSON.stringify(err, null, 2));
          return { error: err.message };
        }
      },
    }),
  };
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

    // /api/tools
    if (path === "/api/tools" && req.method === "GET") {
      try {
        const tools = await listToolSlugs();
        return Response.json({ tools });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // /api/chat
    if (path === "/api/chat" && req.method === "POST") {
      const body = await req.json();
      const messages: CoreMessage[] = body.messages ?? [];

      const toolName = activeComposioTool!.slug ?? activeComposioTool!.name;

      const result = streamText({
        model: openrouter("moonshotai/kimi-k2"),
        system: `You are a helpful assistant. You have one tool available: ${toolName}. Use it to fulfill the user's request. Be concise.`,
        messages,
        tools: makeAITool(activeComposioTool!),
        maxSteps: 10,
      });

      return result.toDataStreamResponse();
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log("Server running at http://localhost:3001");
