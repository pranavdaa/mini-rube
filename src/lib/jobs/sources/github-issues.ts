import { executeTool } from "../../tools";
import { withRetry } from "../retry";
import type { ItemIdentity, JobContext, JobStats, Source } from "../types";

/** Increment a counter, creating it at zero so an absent key never reads as "unmeasured". */
function bump(stats: JobStats | undefined, key: string, by = 1): void {
  if (!stats) return;
  stats[key] = (stats[key] ?? 0) + by;
}

/**
 * GitHub repository issues, paginated to exhaustion.
 *
 * Two things the provider gets "right" in a way that breaks the assignment:
 *
 * 1. `state` defaults to open. The assignment wants open *and* closed, so we
 *    send state=all explicitly.
 * 2. GITHUB_LIST_REPOSITORY_ISSUES returns pull requests too — its own
 *    description says "Lists issues (including pull requests)". The GitHub API
 *    models every PR as an issue. A PR is not a reported problem, so we drop
 *    any item carrying a `pull_request` field.
 */

export interface GithubIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  createdAt: string;
  url: string;
  labels: string[];
}

/** GitHub caps per_page at 100. */
const MAX_PER_PAGE = 100;

/** Refuse to loop forever if the provider never signals the end. */
const MAX_PAGES = 200;

export function parseRepoRef(ref: string): { owner: string; repo: string } {
  const cleaned = ref
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/(issues|pulls)\/?.*$/i, "")
    .replace(/^\/+|\/+$/g, "");

  const [owner, repo] = cleaned.split("/");
  if (!owner || !repo) {
    throw new Error(`"${ref}" is not a repository reference. Expected owner/repo, e.g. composiohq/composio.`);
  }
  return { owner, repo };
}

export const githubIssuesSource: Source<GithubIssue> = {
  id: "github_issues",
  sourceColumn: "Issue",

  identify(issue: GithubIssue): ItemIdentity {
    return { id: String(issue.number), label: `#${issue.number} ${issue.title}`.slice(0, 200) };
  },

  /** GitHub reports exactly "open" or "closed"; anything else is a provider surprise. */
  classify(issue: GithubIssue): string {
    return issue.state === "open" || issue.state === "closed" ? issue.state : `state:${issue.state}`;
  },

  async *pages(ctx: JobContext, opts: { pageSize: number }) {
    // REST first; if it dies with a provider *error page* — on the first page
    // or mid-pagination — redo the whole discovery over GraphQL. Restarting
    // from scratch re-yields items REST already produced, and that is fine by
    // contract: the runner dedupes discovery by item id, so the re-yielded
    // prefix drops out and only the remainder appends.
    //
    // This exists because the failure is real and *flapping*: Composio's REST
    // egress to GitHub spent this afternoon returning 503 "Unicorn" pages —
    // including dying mid-run after a healthy first page — while its GraphQL
    // egress kept working (verified live, 2026-07-16).
    try {
      yield* restPages(ctx, opts);
      return;
    } catch (err) {
      if (!isProviderErrorPage(err)) throw err;
      console.warn(`[job] github REST returned a provider error page — redoing discovery over GraphQL`);
      bump(ctx.stats, "graphqlFallback", 1);
    }
    yield* graphqlPages(ctx, opts);
  },
};

/** A provider *error page* (HTML) rather than an API response — outage, not us. */
export function isProviderErrorPage(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /<html[\s>]|<!doctype html|unicorn!/i.test(text);
}

async function* restPages(ctx: JobContext, opts: { pageSize: number }) {
  const { owner, repo } = parseRepoRef(ctx.ref);
  const perPage = Math.min(opts.pageSize, MAX_PER_PAGE);

  for (let page = 1; page <= MAX_PAGES; page++) {
    if (ctx.signal?.aborted) throw new Error("aborted");

    const res: any = await withRetry(
      () =>
        executeTool("GITHUB_LIST_REPOSITORY_ISSUES", ctx.userId, {
          owner,
          repo,
          state: "all", // open AND closed — the provider defaults to open only
          per_page: perPage,
          page,
          sort: "created",
          direction: "desc",
        }),
      {
        signal: ctx.signal,
        onRetry: (attempt, delay, err) => {
          if (ctx.stats) ctx.stats.page_retries = (ctx.stats.page_retries ?? 0) + 1;
          console.warn(`[job] github issues page ${page} retry ${attempt} in ${delay}ms: ${err.message}`);
        },
      }
    );

    if (res?.successful === false || res?.error) {
      throw new Error(`GITHUB_LIST_REPOSITORY_ISSUES failed: ${String(res?.error ?? "unknown error")}`);
    }

    const raw: any[] = extractIssues(res?.data);
    if (!raw.length) return;

    // Report what only this function can see. The PR filter below is invisible
    // to the runner, so without these counters a page of 100 that is 70 pull
    // requests looks exactly like a page of 30 issues.
    const issues = raw.filter(isRealIssue);
    bump(ctx.stats, "apiItemsFetched", raw.length);
    bump(ctx.stats, "pullRequestsExcluded", raw.length - issues.length);
    bump(ctx.stats, "pagesFetched", 1);

    yield issues.map(toIssue);

    // A short page means the last page. Stop on the provider's own signal.
    if (raw.length < perPage) return;
  }
}

/**
 * The same discovery over GitHub's GraphQL API.
 *
 * Note the `issues` connection genuinely excludes pull requests — unlike the
 * REST endpoint — so no PR filter is needed on this path (and
 * `pullRequestsExcluded` stays honest at 0: nothing was fetched to exclude).
 */
const ISSUES_QUERY = `query($owner:String!,$name:String!,$pageSize:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    issues(first:$pageSize,after:$cursor,states:[OPEN,CLOSED],orderBy:{field:CREATED_AT,direction:DESC}){
      pageInfo{hasNextPage endCursor}
      nodes{number title state createdAt url body labels(first:10){nodes{name}}}
    }
  }
}`;

async function* graphqlPages(ctx: JobContext, opts: { pageSize: number }) {
  const { owner, repo } = parseRepoRef(ctx.ref);
  const pageSize = Math.min(opts.pageSize, MAX_PER_PAGE);
  let cursor: string | null = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    if (ctx.signal?.aborted) throw new Error("aborted");

    const res: any = await withRetry(
      () =>
        executeTool("GITHUB_RUN_GRAPH_QL_QUERY", ctx.userId, {
          query: ISSUES_QUERY,
          variables: { owner, name: repo, pageSize, cursor },
        }),
      {
        signal: ctx.signal,
        onRetry: (attempt, delay, err) => {
          if (ctx.stats) ctx.stats.page_retries = (ctx.stats.page_retries ?? 0) + 1;
          console.warn(`[job] github graphql page ${page} retry ${attempt} in ${delay}ms: ${err.message}`);
        },
      }
    );

    if (res?.successful === false || res?.error) {
      throw new Error(`GITHUB_RUN_GRAPH_QL_QUERY failed: ${String(res?.error ?? "unknown error")}`);
    }

    const connection = parseGraphqlIssuesPage(res);
    if (!connection) {
      throw new Error("GITHUB_RUN_GRAPH_QL_QUERY returned no repository.issues — is the repo name right?");
    }

    bump(ctx.stats, "apiItemsFetched", connection.nodes.length);
    bump(ctx.stats, "pagesFetched", 1);

    yield connection.nodes.map(graphqlNodeToIssue);

    if (!connection.hasNextPage || !connection.endCursor) return;
    cursor = connection.endCursor;
  }
}

export function parseGraphqlIssuesPage(
  res: any
): { nodes: any[]; hasNextPage: boolean; endCursor: string | null } | null {
  // The tool wraps the GraphQL envelope inconsistently; accept both.
  const issues = res?.data?.data?.repository?.issues ?? res?.data?.repository?.issues;
  if (!issues || !Array.isArray(issues.nodes)) return null;
  return {
    nodes: issues.nodes,
    hasNextPage: issues.pageInfo?.hasNextPage === true,
    endCursor: issues.pageInfo?.endCursor ?? null,
  };
}

export function graphqlNodeToIssue(node: any): GithubIssue {
  return {
    number: Number(node?.number ?? 0),
    title: String(node?.title ?? "(untitled)"),
    body: String(node?.body ?? ""),
    // GraphQL reports OPEN/CLOSED; REST reports open/closed. Normalize so
    // classify() and the sheet's State column read the same either way.
    state: String(node?.state ?? "unknown").toLowerCase(),
    createdAt: String(node?.createdAt ?? ""),
    url: String(node?.url ?? ""),
    labels: Array.isArray(node?.labels?.nodes)
      ? node.labels.nodes.map((l: any) => String(l?.name ?? "")).filter(Boolean)
      : [],
  };
}

/** The tool wraps the array differently depending on shape; accept all of them. */
function extractIssues(data: any): any[] {
  if (Array.isArray(data)) return data;
  for (const key of ["items", "issues", "details", "response_data"]) {
    const value = data?.[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

/** GitHub returns PRs from the issues endpoint; a PR is not a reported problem. */
export function isRealIssue(raw: any): boolean {
  return !raw?.pull_request && !raw?.pullRequest;
}

function toIssue(raw: any): GithubIssue {
  return {
    number: Number(raw?.number ?? 0),
    title: String(raw?.title ?? "(untitled)"),
    body: String(raw?.body ?? ""),
    state: String(raw?.state ?? "unknown"),
    createdAt: String(raw?.created_at ?? raw?.createdAt ?? ""),
    url: String(raw?.html_url ?? raw?.url ?? ""),
    labels: Array.isArray(raw?.labels)
      ? raw.labels.map((l: any) => String(typeof l === "string" ? l : (l?.name ?? ""))).filter(Boolean)
      : [],
  };
}
