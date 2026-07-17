import { describe, expect, it, beforeAll } from "bun:test";
import { Router } from "./router";
import { LexicalIndex, tokenize } from "./lexical";
import { queryAspect, toolAspect, impliesUnresolvedPerson } from "./scoring";
import { normalizeTool } from "./normalize";
import { fetchCatalog, TOOLKITS } from "./catalog";
import type { CompactTool } from "./types";

// ---------------------------------------------------------------------------
// Hermetic tests: scoring mechanics over a fixture. No network.
// ---------------------------------------------------------------------------

function tool(partial: Partial<CompactTool> & { slug: string; toolkit: string }): CompactTool {
  return {
    name: partial.slug,
    description: "",
    tags: [],
    inputFields: [],
    important: false,
    deprecated: false,
    ...partial,
  };
}

const FIXTURE: CompactTool[] = [
  tool({ slug: "GOOGLESUPER_FETCH_EMAILS", toolkit: "googlesuper", description: "Fetch email messages from Gmail", tags: ["gmail"], readonly: true, important: true }),
  tool({ slug: "GOOGLESUPER_SEND_EMAIL", toolkit: "googlesuper", description: "Send an email", tags: ["gmail"], readonly: false, important: true }),
  tool({ slug: "GOOGLESUPER_BATCH_MODIFY_EMAIL_LABELS", toolkit: "googlesuper", description: "Modify labels on email messages in the inbox", tags: ["gmail", "labels"], readonly: false }),
  tool({ slug: "GOOGLESUPER_CREATE_EVENT", toolkit: "googlesuper", description: "Create a calendar event", tags: ["calendar"], readonly: false, important: true }),
  tool({ slug: "GOOGLESUPER_OLD_FETCH_EMAILS", toolkit: "googlesuper", description: "Fetch email messages from Gmail", tags: ["gmail"], readonly: true, important: true, deprecated: true }),
  tool({ slug: "GITHUB_LIST_REPOSITORY_ISSUES", toolkit: "github", description: "List issues in a repository", tags: ["issues"], readonly: true, important: true }),
];

describe("normalizeTool", () => {
  const raw = {
    slug: "GITHUB_LIST_REPOSITORY_ISSUES",
    name: "List repository issues",
    description: "Lists issues from a GitHub repository.",
    tags: ["important", "issues", "openWorldHint", "readOnlyHint", "idempotentHint"],
    toolkit: { slug: "github", name: "github" },
    version: "20260713_00",
    isDeprecated: false,
    inputParameters: { properties: { owner: {}, repo: {}, state: {} }, required: ["owner", "repo"] },
  };

  it("lifts provider hint tags into typed flags", () => {
    const t = normalizeTool(raw, "github");
    expect(t.important).toBe(true);
    expect(t.readonly).toBe(true);
    expect(t.deprecated).toBe(false);
    expect(t.version).toBe("20260713_00");
    expect(t.toolkit).toBe("github");
  });

  it("keeps hint tags out of the searchable tags, leaving only semantic ones", () => {
    const t = normalizeTool(raw, "github");
    expect(t.tags).toEqual(["issues"]);
  });

  it("keeps input field names but never the schema itself", () => {
    const t = normalizeTool(raw, "github");
    expect(t.inputFields).toEqual(["owner", "repo", "state"]);
    expect(JSON.stringify(t)).not.toContain("required");
  });

  it("leaves readonly undefined when the provider gives no hint", () => {
    const t = normalizeTool({ ...raw, tags: ["issues"] }, "github");
    expect(t.readonly).toBeUndefined();
  });
});

describe("query aspect", () => {
  it("reads a read-only query as read", () => {
    expect(queryAspect(["read", "emails"])).toBe("read");
  });

  it("reads a write-only query as write", () => {
    expect(queryAspect(["send", "email"])).toBe("write");
  });

  it("treats a query with both read and write intent as mixed, so prerequisites survive", () => {
    expect(queryAspect(["read", "issues", "make", "sheet"])).toBe("mixed");
  });

  it("falls back to the slug verb when the provider gives no read/write hint", () => {
    expect(toolAspect(tool({ slug: "GITHUB_LIST_ISSUES", toolkit: "github" }))).toBe("read");
    expect(toolAspect(tool({ slug: "GITHUB_CREATE_ISSUE", toolkit: "github" }))).toBe("write");
  });
});

describe("impliesUnresolvedPerson", () => {
  // A stand-in for the catalog's own vocabulary: only words this fixture's
  // tools actually use are "known" — everything else (a name like "karan")
  // is not, regardless of any fixed word list.
  const index = new LexicalIndex(FIXTURE);
  const isKnownTerm = (t: string) => index.hasTerm(t);

  it("flags an unknown word after a person preposition", () => {
    expect(impliesUnresolvedPerson("schedule a calendar event tomorrow with karan", isKnownTerm)).toBe(true);
  });

  it("flags 'invite <name>' directly", () => {
    expect(impliesUnresolvedPerson("invite karan to the sync", isKnownTerm)).toBe(true);
  });

  it("does not flag a stopword following the preposition", () => {
    expect(impliesUnresolvedPerson("schedule a meeting with a saved contact", isKnownTerm)).toBe(false);
  });

  it("does not flag relative-time vocabulary following the preposition", () => {
    expect(impliesUnresolvedPerson("create an event for tomorrow", isKnownTerm)).toBe(false);
  });

  it("does not flag real catalog vocabulary the fixture actually indexes", () => {
    // "email" is genuine vocabulary for this fixture (GOOGLESUPER_SEND_EMAIL).
    expect(impliesUnresolvedPerson("send this to email", isKnownTerm)).toBe(false);
  });

  it("returns false when no person preposition appears at all", () => {
    expect(impliesUnresolvedPerson("read recent emails", isKnownTerm)).toBe(false);
  });
});

describe("scoring mechanics", () => {
  const router = new Router(FIXTURE, ["googlesuper", "github"]);

  it("ranks a read tool above a same-vocabulary write tool for a read query", () => {
    const slugs = router.search("read my emails").candidates.map((c) => c.slug);
    expect(slugs.indexOf("GOOGLESUPER_FETCH_EMAILS")).toBeLessThan(
      slugs.indexOf("GOOGLESUPER_BATCH_MODIFY_EMAIL_LABELS")
    );
  });

  it("demotes a deprecated tool below its live equivalent", () => {
    const slugs = router.search("read my emails").candidates.map((c) => c.slug);
    expect(slugs.indexOf("GOOGLESUPER_FETCH_EMAILS")).toBeLessThan(
      slugs.indexOf("GOOGLESUPER_OLD_FETCH_EMAILS")
    );
  });

  it("explains every ranking it produces", () => {
    for (const c of router.search("read my emails").candidates) {
      expect(c.signals.length).toBeGreaterThan(0);
    }
  });

  it("reports how the query was parsed", () => {
    const { parsed } = router.search("read my emails");
    // baseTerms are the user's own words; "email" is reached as a stem.
    expect(parsed.baseTerms).toEqual(["read", "emails"]);
    expect(parsed.expandedTerms.map(([term]) => term)).toContain("email");
    expect(parsed.hintedToolkits).toContain("googlesuper");
    expect(parsed.hintedFacets).toContain("gmail");
    expect(parsed.aspect).toBe("read");
  });

  it("caps the credit a synonym expansion can earn", () => {
    // "urgent" expands to "important"/"starred". A tool whose text carries the
    // expansion must not outrank one matching the user's actual word.
    const tools: CompactTool[] = [
      tool({ slug: "APP_FETCH_URGENT", toolkit: "googlesuper", description: "urgent" }),
      ...Array.from({ length: 40 }, (_, i) =>
        tool({ slug: `APP_STARRED_${i}`, toolkit: "googlesuper", description: "starred" })
      ),
    ];
    const r = new Router(tools, ["googlesuper"]);
    expect(r.search("urgent").candidates[0]!.slug).toBe("APP_FETCH_URGENT");
  });

  it("returns compact candidates that carry no input schema", () => {
    const c = router.search("read my emails").candidates[0]!;
    expect(c).toHaveProperty("slug");
    expect(c).toHaveProperty("version");
    expect(c).not.toHaveProperty("inputParameters");
  });

  it("defaults to 15 candidates", () => {
    const many: CompactTool[] = Array.from({ length: 40 }, (_, i) =>
      tool({ slug: `APP_FETCH_EMAIL_${i}`, toolkit: "googlesuper", description: "email" })
    );
    expect(new Router(many, ["googlesuper"]).search("email").candidates).toHaveLength(15);
  });
});

describe("LexicalIndex", () => {
  it("indexes every tool it is given", () => {
    expect(new LexicalIndex(FIXTURE).size).toBe(FIXTURE.length);
  });

  it("drops stopwords and keeps meaningful terms", () => {
    const { parse } = new LexicalIndex(FIXTURE).search("read all of the issues in my repository");
    expect(parse.baseTerms).toEqual(["read", "issues", "repository"]);
  });

  it("splits letter/digit boundaries so SHEET1 is reachable from 'sheet'", () => {
    // GOOGLESUPER_CREATE_GOOGLE_SHEET1 is the real slug for creating a sheet.
    // Left unsplit, "sheet1" never matches "sheet" and the tool sinks ~80 ranks.
    expect(tokenize("GOOGLESUPER_CREATE_GOOGLE_SHEET1")).toEqual(["googlesuper", "create", "google", "sheet"]);
  });

  it("keeps 'make' as a write verb rather than a stopword", () => {
    // "...and make a google sheet" is the assignment's own phrasing; dropping
    // "make" loses the write half of the request entirely.
    const { parse } = new LexicalIndex(FIXTURE).search("read all the issues and make a google sheet");
    expect(parse.baseTerms).toContain("make");
    expect(queryAspect(parse.baseTerms)).toBe("mixed");
  });
});

// ---------------------------------------------------------------------------
// Live catalog: the seven routing cases. Needs COMPOSIO_API_KEY.
//
// These run against the real googlesuper + github catalogs rather than a
// fixture, because that is the only thing that proves the router routes — a
// fixture would only prove the scorer scores the fixture.
// ---------------------------------------------------------------------------

describe("routing over the live catalog", () => {
  let router: Router;
  let catalog: CompactTool[];

  beforeAll(async () => {
    catalog = await fetchCatalog(TOOLKITS);
    router = new Router(catalog, TOOLKITS);
  }, 60_000);

  const topSlugs = (query: string) => router.search(query).candidates.map((c) => c.slug);

  it("fetches the complete catalog with no alphabetical truncation", () => {
    const counts = router.counts;
    // 467 + 893 = 1,360, verified against the live API.
    expect(counts.googlesuper).toBeGreaterThan(400);
    expect(counts.github).toBeGreaterThan(800);
    // Canaries: both sort past a truncated window and vanish if `limit` bites.
    expect(catalog.some((t) => t.slug === "GITHUB_LIST_REPOSITORY_ISSUES")).toBe(true);
    expect(catalog.some((t) => t.slug === "GOOGLESUPER_LIST_FILES")).toBe(true);
  });

  it("routes: read recent emails", () => {
    expect(topSlugs("read recent emails")).toContain("GOOGLESUPER_FETCH_EMAILS");
  });

  it("routes: find urgent messages in my inbox", () => {
    expect(topSlugs("find urgent messages in my inbox")).toContain("GOOGLESUPER_FETCH_EMAILS");
  });

  it("routes: schedule a meeting with a saved contact (incl. the contact prerequisite)", () => {
    const slugs = topSlugs("schedule a meeting with a saved contact");
    expect(slugs).toContain("GOOGLESUPER_CREATE_EVENT");
    // The hidden prerequisite: you cannot invite someone you haven't resolved.
    expect(slugs.some((s) => s === "GOOGLESUPER_SEARCH_PEOPLE" || s === "GOOGLESUPER_GET_CONTACTS")).toBe(true);
  });

  it("routes: schedule a calendar event tomorrow with karan (unresolved-name prerequisite)", () => {
    // The assignment's own wording. Unlike "with a saved contact" above, no
    // catalog vocabulary names a person here — "karan" scores zero against
    // every tool — so this only passes via the position-based seeding in
    // router.ts (impliesUnresolvedPerson / bestFacetTool), not lexical overlap.
    const routed = router.search("schedule a calendar event tomorrow with karan");
    const slugs = routed.candidates.map((c) => c.slug);
    expect(routed.parsed.impliesPerson).toBe(true);
    expect(slugs).toContain("GOOGLESUPER_CREATE_EVENT");
    expect(slugs.some((s) => s === "GOOGLESUPER_SEARCH_PEOPLE" || s === "GOOGLESUPER_GET_CONTACTS")).toBe(true);
  });

  it("does not falsely flag catalog vocabulary as a person's name", () => {
    // "with subject" ("send an email to me with subject X") must not be read
    // as "with <name>" — "subject" is real catalog vocabulary (an input field
    // on GOOGLESUPER_SEND_EMAIL), just not part of this query's top matches.
    const routed = router.search("send an email to me with subject Router Test");
    expect(routed.parsed.impliesPerson).toBe(false);
  });

  it("routes: list all repository issues", () => {
    expect(topSlugs("list all repository issues")).toContain("GITHUB_LIST_REPOSITORY_ISSUES");
  });

  it("routes: export issues to a spreadsheet (spans both toolkits)", () => {
    const slugs = topSlugs("export issues to a spreadsheet");
    expect(slugs).toContain("GITHUB_LIST_REPOSITORY_ISSUES");
    // Both halves of a cross-toolkit request must be represented — the issue
    // source and a sheet tool that can actually *write* the rows. An earlier
    // version of this test passed on GET_SPREADSHEET_INFO, which reads.
    expect(slugs.some((s) => s.startsWith("GOOGLESUPER_") && /SHEET|SPREADSHEET/.test(s))).toBe(true);
    expect(slugs.some((s) => s.startsWith("GITHUB_"))).toBe(true);
    const writesASheet = slugs.some(
      (s) => /SHEET|SPREADSHEET/.test(s) && router.getTool(s)?.readonly === false
    );
    expect(writesASheet).toBe(true);
  });

  it("routes: read resumes from a Drive folder", () => {
    const slugs = topSlugs("read resumes from a Drive folder");
    expect(
      slugs.some((s) => ["GOOGLESUPER_FIND_FOLDER", "GOOGLESUPER_FIND_FILE"].includes(s))
    ).toBe(true);
  });

  it("ranks a live Drive tool above the deprecated one it replaces", () => {
    // GOOGLESUPER_LIST_FILES is marked deprecated by the provider ("use
    // FIND_FILE instead") despite being tagged important. ASSIGNMENT_PLAN.md
    // still names it as the prompt-4 enumeration tool; the live catalog
    // disagrees, and the router must follow the catalog.
    expect(catalog.find((t) => t.slug === "GOOGLESUPER_LIST_FILES")?.deprecated).toBe(true);
    const all = router.search("read resumes from a Drive folder", { limit: 1400 }).candidates.map((c) => c.slug);
    expect(all.indexOf("GOOGLESUPER_FIND_FILE")).toBeLessThan(all.indexOf("GOOGLESUPER_LIST_FILES"));
  });

  it("routes: email a PDF attachment", () => {
    expect(topSlugs("email a PDF attachment")).toContain("GOOGLESUPER_SEND_EMAIL");
  });

  it("keeps the model's view compact: 15 candidates, no schemas", () => {
    const res = router.search("read recent emails");
    expect(res.candidates).toHaveLength(15);
    expect(res.searched).toBe(catalog.length);
    expect(JSON.stringify(res.candidates)).not.toContain("inputParameters");
  });
});
