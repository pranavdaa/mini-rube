import { describe, expect, it, mock, beforeEach } from "bun:test";
import { chunk } from "./runner";
import { isRetryable, withRetry } from "./retry";
import { parseRepoRef, isRealIssue } from "./sources/github-issues";
import { parseFolderRef } from "./sources/drive-folder";
import { parseProblems } from "./transforms/issue-problem";
import { parseCandidate } from "./transforms/resume-candidate";

// The runner talks to Google only through executeTool; stub it so the engine's
// invariants can be tested hermetically, with no network and no real sheet.
const appended: string[][] = [];
let failAppendsRemaining = 0;

mock.module("../tools", () => ({
  executeTool: async (slug: string, _userId: string, args: any) => {
    if (slug === "GOOGLESUPER_CREATE_GOOGLE_SHEET1") {
      return { successful: true, data: { spreadsheetId: "sheet-1", spreadsheetUrl: "https://sheets.test/sheet-1" } };
    }
    if (slug === "GOOGLESUPER_SPREADSHEETS_VALUES_APPEND") {
      if (failAppendsRemaining > 0) {
        failAppendsRemaining--;
        throw new Error("429 rate limit");
      }
      appended.push(...args.values);
      return { successful: true, data: { updates: { updatedRows: args.values.length } } };
    }
    throw new Error(`unexpected tool ${slug}`);
  },
}));

const { runJob } = await import("./runner");
import type { Source, Transform } from "./types";

interface Item {
  id: number;
}

/** A source yielding `total` items in pages of the requested size. */
function fakeSource(total: number): Source<Item> {
  return {
    id: "fake",
    sourceColumn: "Item",
    identify: (item) => ({ id: String(item.id), label: `item-${item.id}` }),
    async *pages(_ctx, { pageSize }) {
      for (let start = 0; start < total; start += pageSize) {
        yield Array.from({ length: Math.min(pageSize, total - start) }, (_, i) => ({ id: start + i }));
      }
    },
  };
}

function fakeTransform(over: Partial<Transform<Item>> = {}): Transform<Item> {
  return {
    id: "fake",
    columns: ["Value"],
    batchSize: 5,
    run: async (items) => items.map((item) => ({ ok: true as const, cells: [`v${item.id}`] })),
    ...over,
  };
}

const ctx = { userId: "u", ref: "r" };

beforeEach(() => {
  appended.length = 0;
  failAppendsRemaining = 0;
});

describe("runJob", () => {
  it("paginates to exhaustion and writes one row per item plus a header", async () => {
    const res = await runJob({
      source: fakeSource(230),
      transform: fakeTransform(),
      sheetTitle: "t",
      ctx,
      pageSize: 100,
      appendBatchSize: 50,
    });

    expect(res.processed).toBe(230);
    expect(res.succeeded).toBe(230);
    expect(res.failed).toBe(0);
    expect(res.rowsWritten).toBe(231); // 230 + header
    expect(appended).toHaveLength(231);
    expect(res.outputUrl).toBe("https://sheets.test/sheet-1");
  });

  it("writes the header from the transform's columns plus source and status", async () => {
    await runJob({ source: fakeSource(1), transform: fakeTransform(), sheetTitle: "t", ctx });
    expect(appended[0]).toEqual(["Value", "Item", "Status"]);
  });

  it("records a failure row naming the item instead of dropping it", async () => {
    const res = await runJob({
      source: fakeSource(4),
      transform: fakeTransform({
        batchSize: 1,
        run: async (items) =>
          items.map((item) =>
            item.id === 2 ? { ok: false as const, error: "boom" } : { ok: true as const, cells: [`v${item.id}`] }
          ),
      }),
      sheetTitle: "t",
      ctx,
    });

    expect(res.succeeded).toBe(3);
    expect(res.failed).toBe(1);
    expect(res.rowsWritten).toBe(5); // every item still has a row

    const failed = appended.find((r) => r[1] === "item-2")!;
    expect(failed[0]).toBe("Unknown");
    expect(failed[2]).toBe("Extraction failed: boom");
    expect(res.note).toContain("1 could not be processed");
  });

  it("transforms a repeated item id once but still gives every occurrence a row", async () => {
    const seen: number[] = [];
    // Same id discovered three times, as a duplicated Drive file would be.
    const duplicating: Source<Item> = {
      id: "dup",
      sourceColumn: "Item",
      identify: (item) => ({ id: String(item.id), label: `item-${item.id}` }),
      async *pages() {
        yield [{ id: 1 }, { id: 1 }];
        yield [{ id: 1 }, { id: 2 }];
      },
    };

    const res = await runJob({
      source: duplicating,
      transform: fakeTransform({
        batchSize: 1,
        run: async (items) => {
          seen.push(...items.map((i) => i.id));
          return items.map((item) => ({ ok: true as const, cells: [`v${item.id}`] }));
        },
      }),
      sheetTitle: "t",
      ctx,
      concurrency: 1,
    });

    expect(seen).toEqual([1, 2]); // downloaded/extracted once each, not four times
    expect(res.processed).toBe(4);
    expect(res.rowsWritten).toBe(5); // every discovered item still has its own row
    expect(appended.filter((r) => r[1] === "item-1")).toHaveLength(3);
  });

  it("turns a whole-batch throw into per-item failure rows, not a lost batch", async () => {
    const res = await runJob({
      source: fakeSource(6),
      transform: fakeTransform({ batchSize: 3, run: async () => { throw new Error("provider exploded"); } }),
      sheetTitle: "t",
      ctx,
    });

    expect(res.failed).toBe(6);
    expect(res.succeeded).toBe(0);
    expect(res.rowsWritten).toBe(7); // all 6 accounted for + header
    expect(appended.filter((r) => String(r[2]).startsWith("Extraction failed:")).length).toBe(6);
  });

  it("fails loudly if a transform returns the wrong number of results", async () => {
    // Silently misaligning rows with items would be worse than failing.
    const res = await runJob({
      source: fakeSource(3),
      transform: fakeTransform({ batchSize: 3, run: async () => [{ ok: true as const, cells: ["only-one"] }] }),
      sheetTitle: "t",
      ctx,
    });
    expect(res.failed).toBe(3);
    expect(appended.some((r) => String(r[2]).includes("1 results for 3 items"))).toBe(true);
  });

  it("respects maxItems for the test ladder", async () => {
    const res = await runJob({ source: fakeSource(500), transform: fakeTransform(), sheetTitle: "t", ctx, maxItems: 10 });
    expect(res.processed).toBe(10);
    expect(res.rowsWritten).toBe(11);
  });

  it("bounds concurrency to the configured limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await runJob({
      source: fakeSource(60),
      transform: fakeTransform({
        batchSize: 1,
        run: async (items) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return items.map((i) => ({ ok: true as const, cells: [`v${i.id}`] }));
        },
      }),
      sheetTitle: "t",
      ctx,
      concurrency: 5,
    });
    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1); // actually parallel, not accidentally serial
  });

  it("defaults to concurrency 5", async () => {
    let peak = 0;
    let inFlight = 0;
    await runJob({
      source: fakeSource(40),
      transform: fakeTransform({
        batchSize: 1,
        run: async (items) => {
          inFlight++; peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return items.map((i) => ({ ok: true as const, cells: [`v${i.id}`] }));
        },
      }),
      sheetTitle: "t",
      ctx,
    });
    expect(peak).toBe(5);
  });

  it("reports progress as work lands, without item content", async () => {
    const seen: string[] = [];
    const res = await runJob({
      source: fakeSource(120),
      transform: fakeTransform(),
      sheetTitle: "t",
      ctx,
      onProgress: (p) => seen.push(`${p.phase}:${p.processed}/${p.discovered}`),
    });
    expect(seen.some((s) => s.startsWith("discovering"))).toBe(true);
    expect(seen.some((s) => s.startsWith("transforming"))).toBe(true);
    expect(seen.at(-1)).toBe(`done:120/120`);
    expect(res.rowsWritten).toBe(121);
  });

  it("retries a failed sheet append rather than losing the rows", async () => {
    failAppendsRemaining = 2; // first two appends 429
    const res = await runJob({ source: fakeSource(10), transform: fakeTransform(), sheetTitle: "t", ctx });
    expect(res.rowsWritten).toBe(11);
  });

  it("creates no sheet when the source is empty", async () => {
    const res = await runJob({ source: fakeSource(0), transform: fakeTransform(), sheetTitle: "t", ctx });
    expect(res.processed).toBe(0);
    expect(res.outputUrl).toBe("");
    expect(appended).toHaveLength(0);
  });

  it("returns only compact counts and a URL — no rows, no item content", async () => {
    const res = await runJob({ source: fakeSource(50), transform: fakeTransform(), sheetTitle: "t", ctx });
    expect(Object.keys(res).sort()).toEqual(
      ["breakdown", "failed", "note", "outputUrl", "processed", "rowsWritten", "stats", "succeeded"].sort()
    );
    expect(JSON.stringify(res)).not.toContain("v1"); // no cell values leak upward
  });

  // stats/breakdown widen JobResult, so pin them to numbers: the moment a
  // source reports something item-shaped through them, this invariant is gone.
  it("keeps stats and breakdown to counts, never item content", async () => {
    const res = await runJob({ source: fakeSource(50), transform: fakeTransform(), sheetTitle: "t", ctx });
    for (const value of [...Object.values(res.stats), ...Object.values(res.breakdown)]) {
      expect(typeof value).toBe("number");
    }
  });

  it("tallies the breakdown over kept items, so it reconciles with processed", async () => {
    const source: Source<Item> = {
      ...fakeSource(50),
      classify: (item) => (item.id % 2 === 0 ? "even" : "odd"),
    };
    const res = await runJob({ source, transform: fakeTransform(), sheetTitle: "t", ctx, maxItems: 10 });

    const total = Object.values(res.breakdown).reduce((a, b) => a + b, 0);
    expect(total).toBe(res.processed);
    expect(res.processed).toBe(10);
  });
});

describe("chunk", () => {
  it("splits evenly and keeps the remainder", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe("retry", () => {
  it("retries transient failures and eventually succeeds", async () => {
    let calls = 0;
    const out = await withRetry(
      async () => {
        if (++calls < 3) throw new Error("503 unavailable");
        return "ok";
      },
      { baseMs: 1 }
    );
    expect(out).toBe("ok");
    expect(calls).toBe(3);
  });

  it("gives up immediately on permanent errors", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("404 not found");
        },
        { baseMs: 1 }
      )
    ).rejects.toThrow("404");
    expect(calls).toBe(1);
  });

  it("classifies errors", () => {
    expect(isRetryable(new Error("429 too many requests"))).toBe(true);
    expect(isRetryable(new Error("socket hang up"))).toBe(true);
    expect(isRetryable(new Error("401 unauthorized"))).toBe(false);
    expect(isRetryable(new Error("403 forbidden"))).toBe(false);
  });
});

describe("source refs", () => {
  it("parses repo references in the forms a user might type", () => {
    expect(parseRepoRef("composiohq/composio")).toEqual({ owner: "composiohq", repo: "composio" });
    expect(parseRepoRef("https://github.com/composiohq/composio")).toEqual({ owner: "composiohq", repo: "composio" });
    expect(parseRepoRef("https://github.com/composiohq/composio/issues")).toEqual({ owner: "composiohq", repo: "composio" });
    expect(() => parseRepoRef("composio")).toThrow();
  });

  it("parses the assignment's Drive folder URL", () => {
    expect(parseFolderRef("https://drive.google.com/drive/folders/1bOEE3JXX-iFqbY99VTRq1ak-UOQULc5r?usp=sharing")).toBe(
      "1bOEE3JXX-iFqbY99VTRq1ak-UOQULc5r"
    );
    expect(parseFolderRef("1bOEE3JXX-iFqbY99VTRq1ak-UOQULc5r")).toBe("1bOEE3JXX-iFqbY99VTRq1ak-UOQULc5r");
    expect(() => parseFolderRef("my folder")).toThrow();
  });

  it("excludes pull requests from issue results", () => {
    // The GitHub API models every PR as an issue; a PR is not a reported problem.
    expect(isRealIssue({ number: 1, title: "bug" })).toBe(true);
    expect(isRealIssue({ number: 2, title: "feat", pull_request: { url: "..." } })).toBe(false);
  });
});

describe("transform parsing", () => {
  it("maps issue problems by number", () => {
    const out = parseProblems('{"problems":[{"number":7,"problem":"Auth fails on refresh"}]}');
    expect(out.get(7)).toBe("Auth fails on refresh");
  });

  it("returns empty on unusable problem output, so callers fall back", () => {
    expect(parseProblems("sorry, cannot").size).toBe(0);
    expect(parseProblems('{"problems":"nope"}').size).toBe(0);
  });

  it("parses a candidate", () => {
    const c = parseCandidate('{"name":"Steven Moore","university":"Northwestern University","last_job":"Analyst at Acme"}');
    expect(c).toEqual({ name: "Steven Moore", university: "Northwestern University", lastJob: "Analyst at Acme" });
  });

  it("normalizes missing fields to Unknown rather than guessing", () => {
    expect(parseCandidate('{"name":"A","university":"","last_job":"N/A"}')).toEqual({
      name: "A",
      university: "Unknown",
      lastJob: "Unknown",
    });
    expect(parseCandidate("garbage")).toEqual({ name: "Unknown", university: "Unknown", lastJob: "Unknown" });
  });
});
