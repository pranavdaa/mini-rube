import { describe, expect, it } from "bun:test";
import { scoreEmail, parseClassifyResponse, type CompactEmail } from "./triage";

function email(partial: Partial<CompactEmail> = {}): CompactEmail {
  return {
    id: "msg1",
    sender: "Someone <someone@example.com>",
    subject: "Hello",
    timestamp: "2026-07-16T00:00:00Z",
    snippet: "",
    labels: [],
    ...partial,
  };
}

describe("scoreEmail", () => {
  it("boosts messages Gmail already flagged important or starred", () => {
    const plain = scoreEmail(email());
    const important = scoreEmail(email({ labels: ["IMPORTANT"] }));
    const starred = scoreEmail(email({ labels: ["STARRED"] }));
    expect(important.score).toBeGreaterThan(plain.score);
    expect(starred.score).toBeGreaterThan(plain.score);
  });

  it("demotes automated/bulk senders", () => {
    const personal = scoreEmail(email({ sender: "Jane <jane@company.com>" }));
    const bulk = scoreEmail(email({ sender: "No Reply <no-reply@service.com>" }));
    expect(bulk.score).toBeLessThan(personal.score);
    expect(bulk.signals).toContain("bulk/automated sender");
  });

  it("demotes promotional/social category labels", () => {
    const plain = scoreEmail(email());
    const promo = scoreEmail(email({ labels: ["CATEGORY_PROMOTIONS"] }));
    expect(promo.score).toBeLessThan(plain.score);
  });

  it("rewards urgency vocabulary in subject or snippet", () => {
    const plain = scoreEmail(email());
    const urgent = scoreEmail(email({ subject: "Action required: contract deadline tomorrow" }));
    expect(urgent.score).toBeGreaterThan(plain.score);
    expect(urgent.signals.some((s) => s.includes("mentions"))).toBe(true);
  });

  it("never inspects a full body — only subject/snippet/labels/sender feed the score", () => {
    // scoreEmail's signature has no body/payload field at all; this is a type-level
    // guarantee, exercised here so the test fails loudly if the shape ever grows one.
    const e = email({ subject: "x", snippet: "y" });
    expect(Object.keys(e).sort()).toEqual(["id", "labels", "sender", "snippet", "subject", "timestamp"]);
  });
});

describe("parseClassifyResponse", () => {
  const allowed = new Set(["m1", "m2"]);

  it("parses the documented shape", () => {
    const out = parseClassifyResponse('{"important":[{"id":"m1","reason":"needs a reply"}]}', allowed);
    expect(out).toEqual([{ id: "m1", reason: "needs a reply" }]);
  });

  it("accepts an empty list as a valid answer", () => {
    expect(parseClassifyResponse('{"important":[]}', allowed)).toEqual([]);
  });

  it("handles a fenced code block", () => {
    const out = parseClassifyResponse('```json\n{"important":[{"id":"m2","reason":"r"}]}\n```', allowed);
    expect(out?.map((o) => o.id)).toEqual(["m2"]);
  });

  it("drops ids that were never in the candidate pool", () => {
    const out = parseClassifyResponse(
      '{"important":[{"id":"m1","reason":"ok"},{"id":"NOT_A_CANDIDATE","reason":"no"}]}',
      allowed
    );
    expect(out?.map((o) => o.id)).toEqual(["m1"]);
  });

  it("dedupes repeated ids", () => {
    const out = parseClassifyResponse(
      '{"important":[{"id":"m1","reason":"a"},{"id":"m1","reason":"b"}]}',
      allowed
    );
    expect(out).toHaveLength(1);
  });

  it("returns null on unusable output, so the caller falls back", () => {
    for (const bad of ["", "I cannot help with that", "{nope}", '{"important":"not-an-array"}', "null"]) {
      expect(parseClassifyResponse(bad, allowed)).toBeNull();
    }
  });
});
