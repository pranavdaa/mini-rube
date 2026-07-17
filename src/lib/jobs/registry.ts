import { runJob } from "./runner";
import { githubIssuesSource } from "./sources/github-issues";
import { driveFolderSource } from "./sources/drive-folder";
import { issueProblemTransform } from "./transforms/issue-problem";
import { resumeCandidateTransform } from "./transforms/resume-candidate";
import type { JobProgress, JobResult } from "./types";

/**
 * Named job presets: a source paired with the transform that makes sense for it.
 *
 * This is the config seam. "Export Linear issues to a sheet" is a new Source, a
 * new Transform and one entry here — the runner, the router, the agent and the
 * capability registry are all untouched.
 */
export interface JobPreset {
  kind: string;
  /** What `ref` means for this preset — shown to the model in the schema. */
  refDescription: string;
  source: any;
  transform: any;
  sheetTitle: (ref: string) => string;
  /**
   * Concurrency this preset has been *measured* safe at. Absent means the
   * engine default (5) — presets only override where a ladder run proved the
   * higher setting, so an untested job never inherits another job's tuning.
   */
  concurrency?: number;
}

export const JOB_PRESETS: Record<string, JobPreset> = {
  github_issues: {
    kind: "github_issues",
    refDescription: 'a GitHub repository as "owner/repo", e.g. composiohq/composio',
    source: githubIssuesSource,
    transform: issueProblemTransform,
    sheetTitle: (ref) => `${ref} — reported problems`,
  },
  drive_resumes: {
    kind: "drive_resumes",
    refDescription: "a Google Drive folder URL or folder id containing resumes",
    source: driveFolderSource,
    transform: resumeCandidateTransform,
    sheetTitle: () => "Candidates from resumes",
    // Measured 2026-07-16 on the live folder: 100 files at concurrency 5/20/40
    // took 72s/23.5s/14.3s, zero failures and zero rate-limit retries at every
    // level. 20 keeps draw (~12 req/s) well inside Composio's advertised
    // 2,000/60s while capturing most of the win; 40+ doubles rate-limit
    // exposure for ~9s more.
    concurrency: 20,
  },
};

export const JOB_KINDS = Object.keys(JOB_PRESETS);

export interface RunPresetOptions {
  kind: string;
  ref: string;
  userId: string;
  sheetTitle?: string;
  maxItems?: number;
  pageSize?: number;
  transformBatchSize?: number;
  appendBatchSize?: number;
  concurrency?: number;
  onProgress?: (progress: JobProgress) => void;
  signal?: AbortSignal;
}

/**
 * Concurrency precedence: explicit caller > JOB_CONCURRENCY env > preset >
 * engine default. The env var exists so a run failing on rate limits can be
 * tuned down (or a proven-safe run tuned up) without a code change; explicit
 * caller opts still win because passing one is a deliberate per-run decision.
 * Returns undefined to let runJob apply its own default.
 */
export function resolveConcurrency(
  explicit: number | undefined,
  preset: JobPreset,
  env: string | undefined = process.env.JOB_CONCURRENCY
): number | undefined {
  if (explicit !== undefined) return explicit;
  const fromEnv = Number(env);
  if (env !== undefined && Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  return preset.concurrency;
}

export async function runPreset(opts: RunPresetOptions): Promise<JobResult> {
  const preset = JOB_PRESETS[opts.kind];
  if (!preset) {
    throw new Error(`Unknown export kind "${opts.kind}". Available: ${JOB_KINDS.join(", ")}.`);
  }

  return runJob({
    source: preset.source,
    transform: preset.transform,
    sheetTitle: opts.sheetTitle?.trim() || preset.sheetTitle(opts.ref),
    ctx: { userId: opts.userId, ref: opts.ref, signal: opts.signal },
    pageSize: opts.pageSize,
    transformBatchSize: opts.transformBatchSize,
    appendBatchSize: opts.appendBatchSize,
    concurrency: resolveConcurrency(opts.concurrency, preset),
    maxItems: opts.maxItems,
    onProgress: opts.onProgress,
  });
}
