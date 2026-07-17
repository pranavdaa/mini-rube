import { describe, expect, it, beforeEach } from "bun:test";
import { parseSelection, isDecisive, cacheKey, clearConfirmCache, MAX_SELECTED_OUT } from "./confirm";
import type { ParsedQuery, RouterCandidate } from "./types";

function candidate(slug: string, score: number, toolkit = "googlesuper"): RouterCandidate {
  return {
    slug,
    toolkit,
    name: slug,
    description: "",
    important: false,
    inputFields: [],
    score,
    signals: [],
  };
}

function parsedQuery(over: Partial<ParsedQuery> = {}): ParsedQuery {
  return {
    baseTerms: [],
    expandedTerms: [],
    intents: [],
    aspect: null,
    hintedToolkits: [],
    hintedFacets: [],
    impliesPerson: false,
    ...over,
  };
}

const POOL = [
  candidate("GOOGLESUPER_FETCH_EMAILS", 86),
  candidate("GOOGLESUPER_SEND_EMAIL", 34),
  candidate("GOOGLESUPER_SEARCH_PEOPLE", 20),
];

beforeEach(clearConfirmCache);

describe("parseSelection", () => {
  it("parses the documented shape", () => {
    const out = parseSelection(
      '{"selected":[{"slug":"GOOGLESUPER_FETCH_EMAILS","reason":"reads the inbox"}]}',
      POOL,
      8
    );
    expect(out).toEqual([{ slug: "GOOGLESUPER_FETCH_EMAILS", reason: "reads the inbox" }]);
  });

  it("handles a fenced code block", () => {
    const out = parseSelection(
      '```json\n{"selected":[{"slug":"GOOGLESUPER_SEND_EMAIL","reason":"sends it"}]}\n```',
      POOL,
      8
    );
    expect(out.map((o) => o.slug)).toEqual(["GOOGLESUPER_SEND_EMAIL"]);
  });

  it("handles prose wrapped around the JSON", () => {
    const out = parseSelection(
      'Sure! Here you go:\n{"selected":[{"slug":"GOOGLESUPER_SEND_EMAIL","reason":"x"}]}\nHope that helps.',
      POOL,
      8
    );
    expect(out.map((o) => o.slug)).toEqual(["GOOGLESUPER_SEND_EMAIL"]);
  });

  it("drops hallucinated slugs that are not candidates", () => {
    const out = parseSelection(
      '{"selected":[{"slug":"GOOGLESUPER_FETCH_EMAILS","reason":"ok"},{"slug":"TOTALLY_MADE_UP","reason":"no"}]}',
      POOL,
      8
    );
    expect(out.map((o) => o.slug)).toEqual(["GOOGLESUPER_FETCH_EMAILS"]);
  });

  it("dedupes repeated slugs", () => {
    const out = parseSelection(
      '{"selected":[{"slug":"GOOGLESUPER_SEND_EMAIL"},{"slug":"GOOGLESUPER_SEND_EMAIL"}]}',
      POOL,
      8
    );
    expect(out).toHaveLength(1);
  });

  it("accepts bare slug strings and supplies a default reason", () => {
    const out = parseSelection('{"selected":["GOOGLESUPER_SEND_EMAIL"]}', POOL, 8);
    expect(out[0]!.slug).toBe("GOOGLESUPER_SEND_EMAIL");
    expect(out[0]!.reason.length).toBeGreaterThan(0);
  });

  it("enforces the output limit", () => {
    const many = Array.from({ length: 20 }, (_, i) => candidate(`T_${i}`, 10));
    const raw = JSON.stringify({ selected: many.map((c) => ({ slug: c.slug, reason: "r" })) });
    expect(parseSelection(raw, many, MAX_SELECTED_OUT)).toHaveLength(MAX_SELECTED_OUT);
  });

  it("returns empty on unusable output, so the caller can fall back", () => {
    for (const bad of ["", "I cannot help with that", "{nope}", '{"selected":"not-an-array"}', "null"]) {
      expect(parseSelection(bad, POOL, 8)).toEqual([]);
    }
  });
});

describe("isDecisive", () => {
  it("skips when one candidate clearly dominates a single-facet request", () => {
    expect(isDecisive(POOL, parsedQuery({ aspect: "read", hintedFacets: ["gmail"] }))).toBe(true);
  });

  it("does not skip when scores are close", () => {
    const close = [candidate("A", 50), candidate("B", 45)];
    expect(isDecisive(close, parsedQuery({ hintedFacets: ["gmail"] }))).toBe(false);
  });

  it("never skips a request spanning sub-apps, however dominant the leader", () => {
    // "schedule a meeting with a saved contact": GET_CONTACTS leads 2x, but
    // CREATE_EVENT is also required. Skipping here would break the chain.
    expect(isDecisive(POOL, parsedQuery({ hintedFacets: ["calendar", "contacts"] }))).toBe(false);
  });

  it("never skips a mixed read+write request", () => {
    expect(isDecisive(POOL, parsedQuery({ aspect: "mixed", hintedFacets: ["sheets"] }))).toBe(false);
  });

  it("handles thin candidate lists", () => {
    expect(isDecisive([], parsedQuery())).toBe(false);
    expect(isDecisive([candidate("ONLY", 5)], parsedQuery())).toBe(true);
  });
});

describe("cacheKey", () => {
  it("is stable across casing and whitespace", () => {
    const a = cacheKey("Show My  Emails ", [], "v1");
    const b = cacheKey("show my emails", [], "v1");
    expect(a).toBe(b);
  });

  it("changes when the catalog version changes", () => {
    expect(cacheKey("x", [], "v1")).not.toBe(cacheKey("x", [], "v2"));
  });

  it("distinguishes requests by attachment type", () => {
    expect(cacheKey("send this", [{ contentType: "application/pdf" }], "v1")).not.toBe(
      cacheKey("send this", [], "v1")
    );
  });
});
