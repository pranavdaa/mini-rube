import type { CompactTool } from "../router/types";
import { LOCAL_TOOLKIT } from "../router/types";
import { triageImportantEmails } from "../email/triage";
import { JOB_KINDS, runPreset } from "../jobs/registry";
import type { JobProgress } from "../jobs/types";

/**
 * Local capabilities: server-side workflows that are more than one Composio
 * tool call (paginate, score, bounded model calls) but need to show up in the
 * agent's tool set exactly like a real tool — discovered by the same lexical
 * router, confirmed by the same stage 2, invoked the same way.
 *
 * Adding one is the same shape as adding a toolkit: one registry entry here,
 * plus a handler function elsewhere. Nothing in catalog.ts, router.ts,
 * scoring.ts, or agent.ts names a specific capability.
 */
/**
 * What the caller hands a capability beyond its arguments.
 *
 * `onProgress` exists because a capability can run for minutes — the export
 * takes ~115s against a real repo — and without it the caller has no way to
 * show that anything is happening. Optional: a capability that finishes fast
 * simply never calls it.
 */
export interface CapabilityContext {
  onProgress?: (progress: JobProgress) => void;
}

export interface LocalCapability {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  inputFields: string[];
  important: boolean;
  /**
   * Whether this capability only reads. Feeds the router's read/write intent
   * scoring exactly like Composio's readOnlyHint — an export capability creates
   * a sheet, so claiming read-only would demote it on "make me a sheet".
   */
  readonly: boolean;
  /** JSON Schema for the AI SDK tool — this capability's own contract, not a Composio schema. */
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>, userId: string, ctx?: CapabilityContext) => Promise<unknown>;
}

export const LOCAL_CAPABILITIES: LocalCapability[] = [
  {
    slug: "TRIAGE_IMPORTANT_EMAILS",
    name: "Triage important emails",
    description:
      "Reviews the user's most recent emails (paginated server-side, metadata only — sender, subject, timestamp, snippet, labels) and returns a compact digest of the ones that are genuinely important, each with a short reason, plus how many were reviewed. Prefer this over manually fetching and reading a large batch of raw emails: it keeps the full inbox out of the conversation.",
    tags: ["email", "gmail", "important", "triage", "inbox", "digest", "summary", "priority"],
    inputFields: ["max_results"],
    important: true,
    readonly: true,
    inputSchema: {
      type: "object",
      properties: {
        max_results: {
          type: "integer",
          description: "How many of the most recent emails to review, most recent first. Default 100, max 500.",
          minimum: 1,
          maximum: 500,
          default: 100,
        },
      },
    },
    run: async (args, userId, ctx) =>
      triageImportantEmails(userId, {
        maxResults: typeof args?.max_results === "number" ? args.max_results : undefined,
        onProgress: ctx?.onProgress,
      }),
  },
  {
    slug: "EXPORT_TO_GOOGLE_SHEET",
    name: "Export a large collection to a Google Sheet",
    description:
      "Exports an entire large collection into a new Google Sheet, server-side: paginates the source to completion, extracts one row per item, and writes the rows incrementally. Use for 'all the issues in a repo into a sheet' or 'all the resumes in a Drive folder into a sheet'. Handles every item however many there are, records failures as rows rather than dropping them, and returns only counts and the sheet link — the underlying issue bodies and resume contents are never loaded into this conversation. Prefer this over listing items yourself and adding rows one by one.",
    tags: ["sheet", "spreadsheet", "export", "bulk", "issues", "github", "resumes", "drive", "folder", "candidates", "rows", "report"],
    inputFields: ["kind", "ref", "sheet_title", "max_items"],
    important: true,
    // Creates a spreadsheet — must not be scored as a read tool.
    readonly: false,
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: JOB_KINDS,
          description:
            "What to export. 'github_issues' = every issue (open and closed, pull requests excluded) in a repository, one row per issue describing the problem reported. 'drive_resumes' = every resume in a Drive folder, one row per candidate with name, university and last job.",
        },
        ref: {
          type: "string",
          description:
            'What to export from: for github_issues, "owner/repo" (e.g. composiohq/composio); for drive_resumes, the Drive folder URL or folder id.',
        },
        sheet_title: {
          type: "string",
          description: "Optional title for the new sheet. A sensible one is chosen if omitted.",
        },
        max_items: {
          type: "integer",
          description:
            "Optional cap on how many items to export. Omit to export everything, which is almost always what the user wants.",
          minimum: 1,
        },
      },
      required: ["kind", "ref"],
    },
    run: async (args, userId, ctx) =>
      runPreset({
        kind: String(args?.kind ?? ""),
        ref: String(args?.ref ?? ""),
        userId,
        sheetTitle: typeof args?.sheet_title === "string" ? args.sheet_title : undefined,
        maxItems: typeof args?.max_items === "number" ? args.max_items : undefined,
        onProgress: (p) => {
          console.log(
            `[job] ${p.phase} discovered=${p.discovered} processed=${p.processed} ok=${p.succeeded} failed=${p.failed} written=${p.written}`
          );
          ctx?.onProgress?.(p);
        },
      }),
  },
];

const bySlug = new Map(LOCAL_CAPABILITIES.map((c) => [c.slug, c]));

export function getLocalCapability(slug: string): LocalCapability | undefined {
  return bySlug.get(slug);
}

export function isLocalSlug(slug: string): boolean {
  return bySlug.has(slug);
}

/** Reduce a capability to the same compact shape the router indexes real tools as. */
export function toCompactTool(cap: LocalCapability): CompactTool {
  return {
    slug: cap.slug,
    toolkit: LOCAL_TOOLKIT,
    name: cap.name,
    description: cap.description,
    tags: cap.tags,
    inputFields: cap.inputFields,
    version: "local",
    important: cap.important,
    readonly: cap.readonly,
    deprecated: false,
  };
}
