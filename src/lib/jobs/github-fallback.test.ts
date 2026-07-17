import { describe, expect, it, mock } from "bun:test";

/**
 * Deterministic proof of the REST→GraphQL fallback wiring: REST returns the
 * provider's HTML error page (as Composio's GitHub egress did all afternoon,
 * 2026-07-16), GraphQL works. Discovery must complete over GraphQL.
 */
const UNICORN = "<!DOCTYPE html><html><head><title>Unicorn! &middot; GitHub</title></head></html>";

const gqlNode = (i: number) => ({
  number: i, title: `Issue ${i}`, state: i % 2 ? "OPEN" : "CLOSED",
  createdAt: "2026-07-16T00:00:00Z", url: `https://github.com/o/r/issues/${i}`,
  body: `body ${i}`, labels: { nodes: [{ name: "bug" }] },
});

let gqlCalls = 0;
// -1 = REST always dies; N>=0 = REST serves N pages then dies (mid-run flap).
let restPagesBeforeDeath = -1;
let restCalls = 0;

const restIssue = (i: number) => ({
  number: i, title: `Issue ${i}`, state: "open",
  created_at: "2026-07-16T00:00:00Z", html_url: `https://github.com/o/r/issues/${i}`,
  body: `body ${i}`, labels: [{ name: "bug" }],
});

mock.module("../tools", () => ({
  executeTool: async (slug: string, _u: string, args: any) => {
    if (slug === "GITHUB_LIST_REPOSITORY_ISSUES") {
      restCalls++;
      if (restPagesBeforeDeath >= 0 && restCalls <= restPagesBeforeDeath) {
        // A full healthy REST page (100 = per_page, so pagination continues).
        return { successful: true, data: Array.from({ length: 100 }, (_, i) => restIssue((restCalls - 1) * 100 + i)) };
      }
      throw new Error(`Error executing: ${UNICORN}`);
    }
    if (slug === "GITHUB_RUN_GRAPH_QL_QUERY") {
      gqlCalls++;
      const page = args.variables.cursor === null ? 0 : 1;
      const nodes = Array.from({ length: page === 0 ? 100 : 30 }, (_, i) => gqlNode(page * 100 + i));
      return {
        successful: true,
        data: { data: { repository: { issues: {
          pageInfo: { hasNextPage: page === 0, endCursor: page === 0 ? "c1" : null },
          nodes,
        } } } },
      };
    }
    throw new Error(`unexpected tool ${slug}`);
  },
}));

const { githubIssuesSource } = await import("./sources/github-issues");

describe("REST→GraphQL discovery fallback", () => {
  it("completes discovery over GraphQL when REST returns a provider error page", async () => {
    restPagesBeforeDeath = -1; restCalls = 0; gqlCalls = 0;
    const stats: Record<string, number> = {};
    const ctx = { userId: "u", ref: "composiohq/composio", stats };

    const all: any[] = [];
    for await (const page of githubIssuesSource.pages(ctx as any, { pageSize: 100 })) {
      all.push(...page);
    }

    expect(all).toHaveLength(130); // both GraphQL pages, cursor followed
    expect(gqlCalls).toBe(2);
    expect(stats.graphqlFallback).toBe(1);
    // Normalized shape: classify() must bucket GraphQL items like REST ones.
    expect(all[0].state).toMatch(/^(open|closed)$/);
    expect(githubIssuesSource.classify!(all[0])).toMatch(/^(open|closed)$/);
    expect(all[0].labels).toEqual(["bug"]);
  });

  it("falls back even when REST dies mid-pagination, re-yielding safely", async () => {
    // Seen live: REST served page 1, then the outage flapped back and page 2
    // returned the Unicorn. The old first-page-only fallback aborted the job.
    restPagesBeforeDeath = 1; restCalls = 0; gqlCalls = 0;
    const stats: Record<string, number> = {};
    const ctx = { userId: "u", ref: "composiohq/composio", stats };

    const all: any[] = [];
    for await (const page of githubIssuesSource.pages(ctx as any, { pageSize: 100 })) {
      all.push(...page);
    }

    // 100 from REST page 1, then the GraphQL redo re-yields 130 (overlapping
    // ids) — the runner dedupes; the source just must deliver both streams.
    expect(all.length).toBe(230);
    expect(stats.graphqlFallback).toBe(1);
    expect(gqlCalls).toBe(2);
  });
});
