import { createOpenAI } from "@ai-sdk/openai";
import { streamText, tool, jsonSchema, type CoreMessage } from "ai";
import { executeTool } from "./tools";
import { extractRequest, selectTools, type Selection } from "./router/select";
import { getUserEmail } from "./identity";
import { compactToolResult } from "./compact";

/**
 * One agent turn: route → bound → load schemas → run the model.
 *
 * Kept out of server.ts so the turn can be exercised without binding a port,
 * and so the HTTP layer stays a transport concern.
 */

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set");

const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: OPENROUTER_API_KEY,
});

export const MODEL = "moonshotai/kimi-k2";

/**
 * Turn the router's selection into AI SDK tools.
 *
 * Execution goes through the scaffold's executeTool, which pins
 * dangerouslySkipVersionCheck — the scaffold's verified version behaviour. The
 * catalog version rides along on each candidate and is logged, so a
 * version-sensitive failure stays diagnosable.
 */
export function makeAITools(selection: Selection, userId: string) {
  // `any` mirrors the scaffold's own makeAITool: the AI SDK v4 tool() overloads
  // don't resolve against a dynamically-keyed record.
  const tools: Record<string, any> = {};

  for (const candidate of selection.selected) {
    const schema = selection.schemas.get(candidate.slug);
    if (!schema) continue; // schema fetch missed this slug; don't offer it

    tools[candidate.slug] = tool({
      description: schema.description ?? candidate.description ?? candidate.slug,
      parameters: jsonSchema((schema.inputParameters as any) ?? { type: "object", properties: {} }),
      execute: async (args: any) => {
        const started = Date.now();
        console.log(
          `[exec] → ${candidate.slug} v${candidate.version ?? "?"} args=${Object.keys(args ?? {}).join(",") || "(none)"}`
        );
        try {
          const raw: any = await executeTool(candidate.slug, userId, args ?? {});
          // Composio reports failure in-band; a resolved promise is not success.
          const ok = raw?.successful !== false && !raw?.error;

          // Guard the context before the result reaches the model.
          const { result, report } = compactToolResult(raw);

          console.log(
            `[exec] ${ok ? "ok" : "FAILED"} ${candidate.slug} (${Date.now() - started}ms)` +
              (ok ? "" : ` error=${String(raw?.error).slice(0, 200)}`) +
              (report.compacted
                ? ` [compacted ${report.originalChars}→${report.finalChars} chars, dropped: ${report.droppedFields.join(",")}` +
                  (report.omittedItems ? `, omitted ${report.omittedItems} items` : "") +
                  "]"
                : "")
          );
          return result;
        } catch (err: any) {
          console.error(`[exec] THREW ${candidate.slug} (${Date.now() - started}ms): ${err.message}`);
          return { successful: false, error: err.message };
        }
      },
    });
  }

  return tools;
}

/** Log the routing decision: candidates, the bounded selection, and why. */
export function logRouting(selection: Selection) {
  console.log(`\n[route] "${selection.query}" — searched ${selection.searched} tools`);
  console.log(`[route] top ${selection.candidates.length} candidates ('*' = sent to model):`);
  selection.candidates.forEach((c, i) => {
    const mark = i < selection.selected.length ? "*" : " ";
    console.log(`  ${mark}${String(i + 1).padStart(2)}. ${c.score.toFixed(2).padStart(7)}  ${c.slug}`);
  });
  console.log(`[route] why:`);
  for (const c of selection.selected) {
    console.log(`   ${c.slug} v${c.version ?? "?"} — ${c.signals.slice(0, 6).join(" | ")}`);
  }
}

export function buildSystemPrompt(selection: Selection, userEmail: string | null): string {
  const now = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const toolLines = selection.selected
    .map((c) => `- ${c.slug} (${c.toolkit}): ${c.description.slice(0, 160)}`)
    .join("\n");

  return [
    "You are a helpful assistant that operates the user's Google and GitHub accounts through tools.",
    "",
    `Current date and time: ${now.toISOString()} (${timeZone}).`,
    'Resolve relative dates like "today", "tomorrow" or "next week" against that, in the user\'s timezone.',
    userEmail ? `The user's own email address is ${userEmail}. Use it when they say "me" or "myself".` : "",
    "",
    "These are the only tools available this turn — they were selected for this request:",
    toolLines,
    "",
    "Rules:",
    "- Use a tool when the request needs real data. Do not answer from memory about the user's accounts.",
    "- Never invent a recipient, attendee, email address, repository, or file. If a required value is genuinely missing, ask one concise question.",
    "- Resolve a person to an address with a contacts tool before using it. Never print a third party's full email address back to the user.",
    "- Only state that something was sent, created, or changed if the tool result confirms it. If a tool fails, say so plainly.",
    "- Never reveal API keys, tokens, or local file paths.",
    "- Be concise.",
  ]
    .filter(Boolean)
    .join("\n");
}

export interface Turn {
  selection: Selection;
  result: ReturnType<typeof streamText>;
}

/**
 * Build and start one turn. Returns the streamText result so the caller decides
 * how to consume it (HTTP stream, or awaited text in a verification script).
 */
export async function runTurn(messages: CoreMessage[], userId: string): Promise<Turn> {
  const request = extractRequest(messages as any);
  const selection = await selectTools(request);
  logRouting(selection);

  if (!selection.selected.length) {
    throw new Error(`No tools matched "${selection.query}"`);
  }

  const userEmail = await getUserEmail(userId);

  const result = streamText({
    model: openrouter(MODEL),
    system: buildSystemPrompt(selection, userEmail),
    messages,
    tools: makeAITools(selection, userId),
    maxSteps: 10,
  });

  return { selection, result };
}
