import { createOpenAI } from "@ai-sdk/openai";
import { streamText, tool, jsonSchema, type CoreMessage } from "ai";
import { executeTool } from "./tools";
import { extractRequest, selectTools, type Selection } from "./router/select";
import { getUserEmail } from "./identity";
import { compactToolResult } from "./compact";
import { extractAttachmentPayloads, uploadAttachment, type UploadedAttachment } from "./attachments";
import { findFileUploadableField } from "./router/attachmentField";
import { getLocalCapability, isLocalSlug } from "./local/capabilities";
import { scrubDeep, scrubEmails, createStreamScrubber } from "./redact";
import { tokenizeContactEmails, resolveContactTokens, CONTACT_TOKEN_EXAMPLE } from "./contactRefs";
import { nullEmitter, sanitizeForUi, sanitizeRawForUi, type UiEvent } from "./ui-events";
import { getConnectionStatus } from "./auth";
import { LOCAL_TOOLKIT } from "./router/types";

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
 * Fallback timezone for resolving relative dates/times ("tomorrow", "3pm").
 *
 * The scaffold has no real user-timezone source: the server's own OS timezone
 * is not the user's, so we never treat it as authoritative. A stronger source
 * — if the frontend ever sends one — always wins (see `resolveTimeZone`); this
 * is only the floor when none is supplied.
 */
export const DEFAULT_TIMEZONE = "America/Los_Angeles";

/** A user-supplied timezone wins when it's a real IANA identifier; otherwise fall back. */
export function resolveTimeZone(userTimeZone?: string | null): string {
  if (userTimeZone && isValidTimeZone(userTimeZone)) return userTimeZone;
  return DEFAULT_TIMEZONE;
}

function isValidTimeZone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Per-tool, pre-uploaded attachment(s) ready to inject at execution time.
 *
 * The model never sees or chooses these — it can't produce a valid `s3key`,
 * and letting it try would mean trusting an LLM to correctly shape a file
 * upload. Instead the field is detected generically (see attachmentField.ts)
 * and its value is overwritten with the real upload right before the tool
 * runs, whatever the model did or didn't pass for it.
 */
export interface PreparedAttachment {
  /** The input field on this tool's schema that accepts a file (e.g. "attachment"). */
  field: string;
  files: UploadedAttachment[];
}

/** Everything the display channel needs, threaded to wherever an event happens. */
export interface UiContext {
  emit: (event: UiEvent) => void;
  /** Groups this turn's events so the UI can attach them to the right message. */
  turn: number;
  /** Addresses safe to render unmasked — the user's own. See identity.ts. */
  allow: ReadonlySet<string>;
}

/**
 * A provider error string is untrusted: it routinely quotes the arguments back,
 * which can include an address or a path. Sanitize it like any other value, and
 * keep it short — the UI shows a reason, not a stack trace.
 */
function sanitizeErrorForUi(error: unknown, allow: ReadonlySet<string>): string {
  const text = typeof error === "string" ? error : JSON.stringify(error ?? "unknown error");
  return String(sanitizeForUi(String(text).slice(0, 300), allow));
}

/**
 * Turn the router's selection into AI SDK tools.
 *
 * Execution goes through the scaffold's executeTool, which pins
 * dangerouslySkipVersionCheck — the scaffold's verified version behaviour. The
 * catalog version rides along on each candidate and is logged, so a
 * version-sensitive failure stays diagnosable.
 */
export function makeAITools(
  selection: Selection,
  userId: string,
  attachments: Map<string, PreparedAttachment> = new Map(),
  ui: UiContext = { emit: nullEmitter.emit, turn: 0, allow: new Set() }
) {
  // `any` mirrors the scaffold's own makeAITool: the AI SDK v4 tool() overloads
  // don't resolve against a dynamically-keyed record.
  const tools: Record<string, any> = {};

  for (const candidate of selection.selected) {
    const schema = selection.schemas.get(candidate.slug);
    if (!schema) continue; // schema fetch missed this slug; don't offer it

    const prepared = attachments.get(candidate.slug);

    tools[candidate.slug] = tool({
      description: schema.description ?? candidate.description ?? candidate.slug,
      parameters: jsonSchema((schema.inputParameters as any) ?? { type: "object", properties: {} }),
      execute: async (args: any) => {
        let finalArgs = { ...(args ?? {}) };
        if (prepared) {
          // Overrides whatever the model supplied — the only way this field is
          // ever correct is the real upload, produced server-side above.
          finalArgs[prepared.field] = prepared.files.length === 1 ? prepared.files[0] : prepared.files;
        }
        // The model never received a real third-party address (see below) —
        // only the opaque token a contact lookup's result carried instead. If
        // this call is using one (e.g. CREATE_EVENT's attendees), swap it back
        // for the real address right before Composio sees it. A real address
        // the user typed directly is untouched — this only recognizes tokens
        // this process itself minted.
        finalArgs = resolveContactTokens(finalArgs);

        const started = Date.now();
        console.log(
          `[exec] → ${candidate.slug} v${candidate.version ?? "?"} args=${Object.keys(finalArgs).join(",") || "(none)"}` +
            (prepared ? ` [+attachment on ${prepared.field}]` : "")
        );
        ui.emit({ kind: "exec", turn: ui.turn, slug: candidate.slug, status: "running" });
        try {
          const local = isLocalSlug(candidate.slug);
          const raw: any = local
            ? await getLocalCapability(candidate.slug)!.run(finalArgs, userId, {
                // A long capability streams its progress to the UI as it goes.
                // Counts only — the shape of JobProgress guarantees that.
                onProgress: (p) =>
                  ui.emit({
                    kind: "job",
                    turn: ui.turn,
                    slug: candidate.slug,
                    phase: p.phase,
                    discovered: p.discovered,
                    processed: p.processed,
                    succeeded: p.succeeded,
                    failed: p.failed,
                    written: p.written,
                    outputUrl: p.outputUrl,
                  }),
              })
            : await executeTool(candidate.slug, userId, finalArgs);
          // Composio reports failure in-band; a resolved promise is not success.
          // A local capability throws instead of returning {successful:false}, so
          // reaching here already means it succeeded.
          const ok = local || (raw?.successful !== false && !raw?.error);

          // Replace any email address in the result with a stable opaque token
          // before it ever reaches the model — not just before it's displayed.
          // Text-level redaction alone can't be undone by a later turn that
          // needs to reuse the address; this way there is no real address in
          // the model's context to lose in the first place, so it can keep
          // reusing the token across turns without ever inventing one.
          const tokenized = tokenizeContactEmails(raw);

          // Guard the context before the result reaches the model.
          const { result, report } = compactToolResult(tokenized);

          console.log(
            `[exec] ${ok ? "ok" : "FAILED"} ${candidate.slug} (${Date.now() - started}ms)` +
              // Console output is "visible tool activity" too — an error message
              // can echo back argument values, so it gets the same scrub as the
              // model's reply rather than being assumed safe.
              (ok ? "" : ` error=${scrubEmails(String(raw?.error).slice(0, 200), new Set())}`) +
              (report.compacted
                ? ` [compacted ${report.originalChars}→${report.finalChars} chars, dropped: ${report.droppedFields.join(",")}` +
                  (report.omittedItems ? `, omitted ${report.omittedItems} items` : "") +
                  "]"
                : "")
          );

          ui.emit({
            kind: "exec",
            turn: ui.turn,
            slug: candidate.slug,
            status: ok ? "ok" : "failed",
            ms: Date.now() - started,
            ...(ok ? {} : { error: sanitizeErrorForUi(raw?.error, ui.allow) }),
            // The raw view shows what the *model* received, sanitized for display.
            raw: sanitizeRawForUi(result, ui.allow),
            ...(report.compacted
              ? { compacted: { from: report.originalChars, to: report.finalChars, dropped: report.droppedFields } }
              : {}),
          });
          return result;
        } catch (err: any) {
          console.error(
            `[exec] THREW ${candidate.slug} (${Date.now() - started}ms): ${scrubEmails(err.message, new Set())}`
          );
          ui.emit({
            kind: "exec",
            turn: ui.turn,
            slug: candidate.slug,
            status: "failed",
            ms: Date.now() - started,
            error: sanitizeErrorForUi(err?.message, ui.allow),
          });
          return { successful: false, error: err.message };
        }
      },
    });
  }

  return tools;
}

/** Log the routing decision: candidates, the bounded selection, and why. */
export function logRouting(selection: Selection) {
  const chosen = new Set(selection.selected.map((c) => c.slug));

  console.log(`\n[route] "${selection.query}" — searched ${selection.searched} tools`);
  console.log(`[route] stage 1 — top ${selection.candidates.length} candidates ('*' = selected):`);
  selection.candidates.forEach((c, i) => {
    const mark = chosen.has(c.slug) ? "*" : " ";
    console.log(`  ${mark}${String(i + 1).padStart(2)}. ${c.score.toFixed(2).padStart(7)}  ${c.slug}`);
  });

  console.log(
    `[route] stage 2 — ${selection.confirm.source}${selection.confirm.cached ? " (cached)" : ""}` +
      ` → ${selection.selected.length} tools`
  );
  for (const c of selection.selected) {
    const reason = selection.confirm.reasons.get(c.slug);
    console.log(`   ${c.slug} v${c.version ?? "?"}`);
    console.log(`     why: ${reason ?? c.signals.slice(0, 4).join(" | ")}`);
  }
}

export function buildSystemPrompt(
  selection: Selection,
  userEmail: string | null,
  hasAttachment: boolean = false,
  timeZone: string = DEFAULT_TIMEZONE
): string {
  const now = new Date();

  const toolLines = selection.selected
    .map((c) => `- ${c.slug} (${c.toolkit}): ${c.description.slice(0, 160)}`)
    .join("\n");

  return [
    "You are a helpful assistant that operates the user's Google and GitHub accounts through tools.",
    "",
    `Current date and time: ${now.toISOString()} (${timeZone}).`,
    `Resolve relative dates and times like "today", "tomorrow", "next week" or "3pm" against ${timeZone}.`,
    userEmail ? `The user's own email address is ${userEmail}. Use it when they say "me" or "myself".` : "",
    hasAttachment
      ? "The user attached a file. It has already been uploaded and will be attached automatically " +
        "when you call the relevant tool — you cannot see its bytes and do not need to (and cannot) " +
        "fill in its attachment field yourself. Just call the tool normally."
      : "",
    "",
    // A turn with no tools is normal (a plain "thanks", or an answer to a
    // question you asked). Say so plainly rather than presenting an empty list.
    selection.selected.length
      ? "These are the only tools available this turn — they were selected for this request:\n" + toolLines
      : "No tools were matched for this turn. Reply conversationally. If the user is asking for " +
        "something that needs their accounts, ask them to restate it as a full request in one message.",
    "",
    "Rules:",
    "- Use a tool when the request needs real data. Do not answer from memory about the user's accounts.",
    "- When a tool's description says it triages, digests, or summarizes a large read, prefer it over manually paginating a raw list/fetch tool for the same data — the raw tool alone would pull everything into this conversation.",
    "- Likewise, when a tool performs an entire multi-item job end to end (a bulk export, for example), call that one tool instead of reproducing its workflow with raw list/create/insert tools. One call, not a hand-built pipeline.",
    "- Never invent a recipient, attendee, email address, repository, or file. If a required value is genuinely missing, ask one concise question.",
    "- To invite or schedule with a named person, search contacts for that name first and use the address the search returns as the tool argument. Never guess, remember, or construct an email address from a name.",
    // Without this the model sees ref-xxxxxxxx@contacts.internal, correctly
    // judges it not to be a real address, and asks the user for one — refusing
    // to use a contact it just resolved successfully. The token IS the address
    // as far as the model is concerned; the server swaps it for the real one
    // at execution. Verified live: this exact refusal, on a contact that
    // resolved fine.
    `- A contact search returns addresses as opaque references shaped like ${CONTACT_TOKEN_EXAMPLE}. That is deliberate and they are valid: pass one through unchanged as the attendee/recipient argument and it will reach the real person. Never reject one as fake, never ask the user to supply a "real" address in its place, and never print one in your reply — say the person's name instead.`,
    "- A resolved contact's email address is a tool argument only. Never write it in your reply — refer to the person by name instead. This does not apply to the user's own address.",
    "- If an event's date, start time, or duration is missing or ambiguous, ask one concise question naming exactly what's missing before creating anything. Never invent a time.",
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
 * Second, mechanical layer of email redaction — independent of whether the
 * model actually follows the system prompt's "never print it" rule.
 *
 * Wraps the model's outgoing stream (what reaches `toDataStreamResponse()`,
 * and so the frontend) and scrubs any email-shaped text that isn't
 * allow-listed. This runs on the *outgoing copy* of the stream only: tool
 * execution already happened against the real, unredacted arguments before a
 * chunk reaches this transform, so the model still resolves and uses the real
 * address internally — only what becomes visible is masked.
 */
function redactEmailsTransform(allow: ReadonlySet<string>) {
  return () => {
    const scrubber = createStreamScrubber(allow);
    return new TransformStream<any, any>({
      transform(chunk, controller) {
        if (typeof chunk?.textDelta === "string") {
          const out = scrubber.push(chunk.textDelta);
          if (out) controller.enqueue({ ...chunk, textDelta: out });
          return;
        }

        // Any other chunk marks a safe boundary: release buffered text before
        // it, in order, then scrub this chunk's own tool args/result — the
        // "visible tool activity" the frontend could otherwise render.
        const tail = scrubber.flush();
        if (tail) controller.enqueue({ type: "text-delta", textDelta: tail });

        if (chunk?.type === "tool-call" && "args" in chunk) {
          controller.enqueue({ ...chunk, args: scrubDeep(chunk.args, allow) });
        } else if (chunk?.type === "tool-result" && "result" in chunk) {
          controller.enqueue({ ...chunk, result: scrubDeep(chunk.result, allow) });
        } else {
          controller.enqueue(chunk);
        }
      },
      flush(controller) {
        const tail = scrubber.flush();
        if (tail) controller.enqueue({ type: "text-delta", textDelta: tail });
      },
    });
  };
}

/**
 * Upload any attached files server-side and work out which selected tool's
 * field each one belongs to.
 *
 * Runs once per turn, before the model is called, so a bad upload (wrong
 * type, too large) fails the turn loudly instead of silently sending without
 * the attachment. A tool is eligible only if its own schema exposes a
 * file-uploadable field (see attachmentField.ts) — nothing here names
 * GOOGLESUPER_SEND_EMAIL specifically.
 */
async function prepareAttachments(
  messages: CoreMessage[],
  selection: Selection
): Promise<Map<string, PreparedAttachment>> {
  const prepared = new Map<string, PreparedAttachment>();
  const raw = extractAttachmentPayloads(messages as any);
  if (!raw.length) return prepared;

  for (const candidate of selection.selected) {
    const schema = selection.schemas.get(candidate.slug);
    const field = findFileUploadableField(schema?.inputParameters);
    if (!field) continue;

    const files: UploadedAttachment[] = [];
    for (const a of raw) {
      const uploaded = await uploadAttachment(a, candidate.slug, candidate.toolkit);
      files.push(uploaded);
      console.log(`[attach] uploaded "${uploaded.name}" (${uploaded.mimetype}) for ${candidate.slug}.${field}`);
    }
    prepared.set(candidate.slug, { field, files });
  }

  return prepared;
}

/**
 * Strip attachment bytes before the messages reach the model.
 *
 * AI SDK v4 detects `experimental_attachments` on a message and inlines it as
 * a `file`/`image` content part — i.e. the raw base64 bytes would otherwise
 * ride straight into the model's prompt. We handle attachments ourselves
 * (prepareAttachments + injection in makeAITools), so the model only ever
 * needs to know a file was attached (buildSystemPrompt's hasAttachment line),
 * never the bytes.
 */
function stripAttachments(messages: CoreMessage[]): CoreMessage[] {
  return messages.map((m) => {
    if (!m || typeof m !== "object" || !("experimental_attachments" in m)) return m;
    const { experimental_attachments, ...rest } = m as Record<string, unknown>;
    return rest as CoreMessage;
  });
}

/**
 * Build and start one turn. Returns the streamText result so the caller decides
 * how to consume it (HTTP stream, or awaited text in a verification script).
 */
export async function runTurn(
  messages: CoreMessage[],
  userId: string,
  opts: {
    timezone?: string;
    emit?: (event: UiEvent) => void;
    turn?: number;
    /** Runs after the model's final step. The HTTP layer uses it to close the event stream. */
    onFinish?: () => void | Promise<void>;
  } = {}
): Promise<Turn> {
  const emit = opts.emit ?? nullEmitter.emit;
  const turn = opts.turn ?? 0;

  // Emitted before the search so the UI shows "Searching tools" during it, not
  // after — routing the full catalog is the first thing that takes real time.
  emit({ kind: "route", turn, phase: "searching" });

  const request = extractRequest(messages as any);
  const selection = await selectTools(request);
  logRouting(selection);

  emit({
    kind: "route",
    turn,
    phase: "selected",
    searched: selection.searched,
    candidates: selection.candidates.length,
    selected: selection.selected.map((c) => ({
      slug: c.slug,
      toolkit: c.toolkit,
      reason: selection.confirm.reasons.get(c.slug) ?? c.signals.slice(0, 3).join(" | "),
    })),
    confirmSource: selection.confirm.source + (selection.confirm.cached ? " (cached)" : ""),
  });

  // Surface a missing connection *before* the model runs. Otherwise the only
  // signal is the provider's own "Error executing the tool GITHUB_..." — which
  // names no cause and leaves the user with nothing to act on. Checked against
  // the toolkits this turn actually selected, so we never nag about GitHub on
  // an email request.
  await emitAuthGaps(selection, userId, turn, emit);

  // No tools is a normal conversational turn, not an error. "thanks", "yes" and
  // "10am" all match nothing in a 1,360-tool catalog, and throwing here turned
  // an ordinary reply into a 500 that the UI could only render as "An error
  // occurred." The model can still answer, confirm, or ask — it just has no
  // tools this turn.
  if (!selection.selected.length) {
    console.log(`[route] no tools matched "${selection.query}" — replying without tools`);
  }

  const userEmail = await getUserEmail(userId);
  const attachments = await prepareAttachments(messages, selection);
  const timeZone = resolveTimeZone(opts.timezone);

  // The user's own address is fine to echo back; everyone else's is not.
  const allowedEmails = new Set(userEmail ? [userEmail.toLowerCase()] : []);

  // Name the attachment so the user can see it was picked up, and which tool
  // field it will ride on. The same file is prepared once per eligible tool, so
  // report against the tool that will actually carry it.
  for (const [slug, prepared] of attachments) {
    for (const file of prepared.files) {
      emit({ kind: "attachment", turn, name: file.name, slug, field: prepared.field });
    }
  }

  const result = streamText({
    model: openrouter(MODEL),
    system: buildSystemPrompt(selection, userEmail, attachments.size > 0, timeZone),
    messages: stripAttachments(messages),
    tools: makeAITools(selection, userId, attachments, { emit, turn, allow: allowedEmails }),
    maxSteps: 10,
    experimental_transform: redactEmailsTransform(allowedEmails),
    // Fires once the final step completes (including after tool calls), which
    // is the only point the side channel can safely be closed.
    onFinish: () => void opts.onFinish?.(),
    // A mid-stream failure must close the channel too, or the response hangs.
    onError: () => void opts.onFinish?.(),
  });

  return { selection, result };
}

/**
 * Report any selected toolkit the user hasn't connected.
 *
 * Best-effort: if the status lookup itself fails we stay quiet rather than
 * claim a connection problem we haven't established — a false "connect GitHub"
 * prompt is worse than none.
 */
async function emitAuthGaps(
  selection: Selection,
  userId: string,
  turn: number,
  emit: (event: UiEvent) => void
): Promise<void> {
  const toolkits = new Set(
    selection.selected.map((c) => c.toolkit).filter((t) => t && t !== LOCAL_TOOLKIT)
  );
  if (!toolkits.size) return;

  try {
    const status = await getConnectionStatus(userId);
    for (const toolkit of toolkits) {
      if (status[toolkit] === false) {
        console.log(`[auth] ${toolkit} is not connected — this turn will likely fail`);
        emit({ kind: "auth", turn, toolkit, connected: false });
      }
    }
  } catch {
    // Status unavailable; let the turn proceed and fail honestly if it must.
  }
}
