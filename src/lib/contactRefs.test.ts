import { describe, expect, it, beforeEach } from "bun:test";
import { tokenizeContactEmails, resolveContactTokens, clearContactTokenCache } from "./contactRefs";

beforeEach(clearContactTokenCache);

describe("tokenizeContactEmails", () => {
  it("replaces a whole-string email with a syntactically email-shaped token", () => {
    const out: any = tokenizeContactEmails({ name: "Karan Test", email: "karan@example.com" });
    expect(out.email).not.toBe("karan@example.com");
    expect(out.email).toMatch(/^ref-[a-f0-9]{8}@contacts\.internal$/);
    expect(out.name).toBe("Karan Test");
  });

  it("tokenizes nested Google People API shapes (emailAddresses[].value)", () => {
    const raw = {
      results: [{ person: { names: [{ displayName: "Karan Test" }], emailAddresses: [{ value: "karan@example.com" }] } }],
    };
    const out: any = tokenizeContactEmails(raw);
    expect(out.results[0].person.emailAddresses[0].value).toMatch(/^ref-[a-f0-9]{8}@contacts\.internal$/);
  });

  it("is deterministic: the same address always maps to the same token", () => {
    const a = tokenizeContactEmails("karan@example.com") as unknown as string;
    const b = tokenizeContactEmails("karan@example.com") as unknown as string;
    expect(a).toBe(b);
  });

  it("gives distinct contacts distinct tokens", () => {
    const a = tokenizeContactEmails("karan@example.com") as unknown as string;
    const b = tokenizeContactEmails("priya@example.com") as unknown as string;
    expect(a).not.toBe(b);
  });

  it("leaves non-email strings untouched", () => {
    expect(tokenizeContactEmails("Karan Test")).toBe("Karan Test");
    expect(tokenizeContactEmails("not-an-email-at-all")).toBe("not-an-email-at-all");
  });

  it("does not re-tokenize an already-tokenized value", () => {
    const token = tokenizeContactEmails("karan@example.com") as unknown as string;
    expect(tokenizeContactEmails(token)).toBe(token);
  });

  it("does not mutate the original object", () => {
    const original = { email: "karan@example.com" };
    tokenizeContactEmails(original);
    expect(original.email).toBe("karan@example.com");
  });
});

describe("resolveContactTokens", () => {
  it("round-trips: tokenize then resolve returns the original address", () => {
    const token = tokenizeContactEmails("karan@example.com") as unknown as string;
    expect(resolveContactTokens(token)).toBe("karan@example.com");
  });

  it("resolves a token nested inside tool-call args (e.g. attendees array)", () => {
    const token = tokenizeContactEmails("karan@example.com") as unknown as string;
    const args = { attendees: [token], summary: "Sync" };
    const resolved: any = resolveContactTokens(args);
    expect(resolved.attendees).toEqual(["karan@example.com"]);
    expect(resolved.summary).toBe("Sync");
  });

  it("leaves a real, never-tokenized address the user typed directly untouched", () => {
    expect(resolveContactTokens("bob@company.com")).toBe("bob@company.com");
  });

  it("leaves an unrecognized token-shaped string untouched", () => {
    const fake = "ref-deadbeef@contacts.internal";
    expect(resolveContactTokens(fake)).toBe(fake);
  });

  it("survives across separate tokenize/resolve calls (simulating separate turns)", () => {
    const token = tokenizeContactEmails("karan@example.com") as unknown as string;
    // A later, independent call (as a later HTTP turn would make) still resolves it.
    expect(resolveContactTokens(token)).toBe("karan@example.com");
  });
});
