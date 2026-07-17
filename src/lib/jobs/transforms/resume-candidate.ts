import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { readFile } from "node:fs/promises";
import { extractText, getDocumentProxy } from "unpdf";
import { executeTool } from "../../tools";
import type { DriveFile } from "../sources/drive-folder";
import type { JobContext, Transform, TransformOutcome } from "../types";

/**
 * Resume → {name, university, last job}.
 *
 * Per item (batchSize 1) because each resume needs its own download, PDF parse
 * and extraction; parallelism comes from the runner's concurrency cap instead.
 *
 * Resume text is read, used, and dropped inside this function. It never returns
 * upward, so it cannot reach the agent's context — 1,000 resumes stay out of
 * the conversation entirely, which is the whole point of the job runner.
 *
 * Verified 2026-07-16: the assignment's resumes are text-layer PDFs
 * (FlateDecode), so text extraction works and no OCR/vision path is needed —
 * this was ASSIGNMENT_PLAN.md §7's largest stated risk.
 */

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.JOB_TRANSFORM_MODEL ?? "openai/gpt-4o-mini";
const REQUEST_TIMEOUT_MS = 30_000;

/** A resume's identity lives at the top; this is plenty and bounds cost. */
const RESUME_CHARS = 6_000;

const UNKNOWN = "Unknown";

export interface Candidate {
  name: string;
  university: string;
  lastJob: string;
}

export const resumeCandidateTransform: Transform<DriveFile> = {
  id: "resume_candidate",
  columns: ["Name", "University", "Last job"],
  batchSize: 1,

  async run(files, ctx): Promise<TransformOutcome[]> {
    const file = files[0];
    if (!file) return [];

    try {
      const text = await extractResumeText(file, ctx);
      if (!text.trim()) {
        // A real file that yields no text is a finding, not a crash: it earns a
        // failure row naming the file, so a human can go look at it.
        return [{ ok: false, error: "no readable text in file (scanned image?)" }];
      }

      const candidate = await extractCandidate(text);
      return [{ ok: true, cells: [candidate.name, candidate.university, candidate.lastJob] }];
    } catch (err: any) {
      return [{ ok: false, error: String(err?.message ?? err).slice(0, 160) }];
    }
  },
};

/**
 * Download via Composio, then read the bytes it wrote to disk.
 *
 * GOOGLESUPER_DOWNLOAD_FILE saves to a local path and returns a URI rather than
 * inline content. That path is an implementation detail: it is never logged and
 * never surfaced to the user.
 */
async function extractResumeText(file: DriveFile, ctx: JobContext): Promise<string> {
  const res: any = await executeTool("GOOGLESUPER_DOWNLOAD_FILE", ctx.userId, { fileId: file.id });
  if (res?.successful === false || res?.error) {
    throw new Error(`download failed: ${String(res?.error ?? "unknown error")}`);
  }

  const uri = res?.data?.downloaded_file_content?.uri ?? res?.data?.file?.uri;
  if (!uri) throw new Error("download returned no file content");

  const bytes = await readFile(uri);
  return await pdfToText(new Uint8Array(bytes));
}

export async function pdfToText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return (Array.isArray(text) ? text.join("\n") : text) ?? "";
}

const SYSTEM_PROMPT = [
  "You read resume text and pull out three facts.",
  "- name: the candidate's full name.",
  "- university: the university or college they attended. If several, the one for their highest degree.",
  "- last_job: their most recent job, as \"Title at Company\".",
  `Use exactly "${UNKNOWN}" for anything the resume does not state. Never guess or infer.`,
  'Reply with JSON only, no prose: {"name":"...","university":"...","last_job":"..."}',
].join("\n");

/**
 * One bounded model call per resume.
 *
 * A failure here returns Unknown fields rather than throwing: the file was
 * found and read, so the candidate belongs in the sheet with honest gaps rather
 * than being recorded as a processing failure.
 */
async function extractCandidate(text: string): Promise<Candidate> {
  if (!OPENROUTER_API_KEY) {
    return { name: UNKNOWN, university: UNKNOWN, lastJob: UNKNOWN };
  }

  let raw: string;
  try {
    const openrouter = createOpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: OPENROUTER_API_KEY,
    });
    const res = await generateText({
      model: openrouter(MODEL),
      system: SYSTEM_PROMPT,
      prompt: text.replace(/\s+/g, " ").trim().slice(0, RESUME_CHARS),
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    raw = res.text;
  } catch {
    return { name: UNKNOWN, university: UNKNOWN, lastJob: UNKNOWN };
  }

  return parseCandidate(raw);
}

export function parseCandidate(raw: string): Candidate {
  const unknown: Candidate = { name: UNKNOWN, university: UNKNOWN, lastJob: UNKNOWN };
  const json = extractJson(raw);
  if (!json) return unknown;

  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    return unknown;
  }

  return {
    name: field(parsed?.name),
    university: field(parsed?.university),
    lastJob: field(parsed?.last_job ?? parsed?.lastJob),
  };
}

function field(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text || /^(unknown|n\/?a|none|null|not (stated|specified|listed))$/i.test(text)) return UNKNOWN;
  return text.slice(0, 200);
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
