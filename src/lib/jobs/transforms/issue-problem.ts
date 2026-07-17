import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import type { GithubIssue } from "../sources/github-issues";
import type { Transform, TransformOutcome } from "../types";

/**
 * GitHub issue → "the problem this person is reporting".
 *
 * Batched: one model call summarises many issues at once, because the value per
 * issue is a single sentence and a call per issue would mean ~550 calls.
 *
 * Issue bodies are read here and never leave — the main agent sees counts and a
 * URL. Bodies are truncated before they reach even *this* model, since a long
 * reproduction script adds cost without changing the one-line summary.
 */

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.JOB_TRANSFORM_MODEL ?? "openai/gpt-4o-mini";
const REQUEST_TIMEOUT_MS = 45_000;

/** Enough to state the problem; far short of a full reproduction log. */
const BODY_CHARS = 700;

/** One call per this many issues. Small enough to stay reliable, big enough to amortise. */
const BATCH_SIZE = 15;

export const issueProblemTransform: Transform<GithubIssue> = {
  id: "issue_problem",
  columns: ["Issue #", "Title", "State", "Created", "Problem reported", "Link"],
  batchSize: BATCH_SIZE,

  async run(issues): Promise<TransformOutcome[]> {
    const problems = await summarizeProblems(issues);

    return issues.map((issue, i) => ({
      ok: true as const,
      cells: [
        String(issue.number),
        issue.title,
        issue.state,
        issue.createdAt ? issue.createdAt.slice(0, 10) : "Unknown",
        problems[i] ?? fallbackProblem(issue),
        issue.url,
      ],
    }));
  },
};

/**
 * Deterministic fallback: the title is the reporter's own one-line summary.
 *
 * A model outage should degrade the "Problem reported" column to something
 * truthful, not turn 550 real issues into 550 failure rows.
 */
function fallbackProblem(issue: GithubIssue): string {
  const body = issue.body.replace(/\s+/g, " ").trim();
  return body ? `${issue.title} — ${body.slice(0, 160)}` : issue.title;
}

const SYSTEM_PROMPT = [
  "You summarise GitHub issues into the single problem the reporter is describing.",
  "For each issue, write one sentence, under 25 words, stating what is wrong or what",
  "the person needs — not the fix, not a restatement of the title.",
  "If an issue is a question, say what they are confused about.",
  "If there is genuinely no problem described, reply with the title.",
  'Reply with JSON only, no prose: {"problems":[{"number":123,"problem":"..."}]}',
].join("\n");

function buildPrompt(issues: GithubIssue[]): string {
  const lines = issues.map((issue) => {
    const body = issue.body.replace(/\s+/g, " ").trim().slice(0, BODY_CHARS);
    return `number=${issue.number} | title: ${issue.title} | body: ${body || "(empty)"}`;
  });
  return [`Summarise the problem in each of these ${issues.length} issues:`, "", ...lines].join("\n");
}

/** Returns a problem per issue, index-aligned; entries may be undefined. */
async function summarizeProblems(issues: GithubIssue[]): Promise<(string | undefined)[]> {
  if (!OPENROUTER_API_KEY || !issues.length) return issues.map(() => undefined);

  let text: string;
  try {
    const openrouter = createOpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: OPENROUTER_API_KEY,
    });
    const res = await generateText({
      model: openrouter(MODEL),
      system: SYSTEM_PROMPT,
      prompt: buildPrompt(issues),
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    text = res.text;
  } catch {
    return issues.map(() => undefined); // falls back per issue
  }

  const byNumber = parseProblems(text);
  return issues.map((issue) => byNumber.get(issue.number));
}

/** Parse defensively; anything unusable degrades to the deterministic fallback. */
export function parseProblems(raw: string): Map<number, string> {
  const out = new Map<number, string>();
  const json = extractJson(raw);
  if (!json) return out;

  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    return out;
  }

  const list = parsed?.problems;
  if (!Array.isArray(list)) return out;

  for (const item of list) {
    const number = Number(item?.number);
    const problem = typeof item?.problem === "string" ? item.problem.trim() : "";
    if (Number.isFinite(number) && problem) out.set(number, problem);
  }
  return out;
}

function extractJson(raw: string): string | null {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return null;
}
