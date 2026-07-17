import { describe, expect, it } from "bun:test";
import { resolveTimeZone, buildSystemPrompt, DEFAULT_TIMEZONE } from "./agent";
import { CONTACT_TOKEN_EXAMPLE, isContactToken } from "./contactRefs";
import type { Selection } from "./router/select";

function selection(over: Partial<Selection> = {}): Selection {
  return {
    query: "",
    parsed: {
      baseTerms: [],
      expandedTerms: [],
      intents: [],
      aspect: null,
      hintedToolkits: [],
      hintedFacets: [],
      impliesPerson: false,
    },
    candidates: [],
    selected: [],
    schemas: new Map(),
    searched: 0,
    confirm: { source: "disabled", cached: false, reasons: new Map() },
    ...over,
  };
}

describe("resolveTimeZone", () => {
  it("falls back to America/Los_Angeles when nothing is supplied", () => {
    expect(resolveTimeZone(undefined)).toBe(DEFAULT_TIMEZONE);
    expect(resolveTimeZone(null)).toBe(DEFAULT_TIMEZONE);
  });

  it("uses a real IANA timezone the frontend sends, over the default", () => {
    expect(resolveTimeZone("Asia/Kolkata")).toBe("Asia/Kolkata");
  });

  it("falls back on a bogus timezone string rather than passing it through", () => {
    expect(resolveTimeZone("PST")).toBe(DEFAULT_TIMEZONE);
    expect(resolveTimeZone("not a timezone")).toBe(DEFAULT_TIMEZONE);
  });
});

describe("buildSystemPrompt — contact resolution and privacy rules", () => {
  it("tells the model to resolve a person via contacts before using an address", () => {
    const prompt = buildSystemPrompt(selection(), null, false, "America/Los_Angeles");
    expect(prompt).toMatch(/search contacts/i);
    expect(prompt).toMatch(/never guess|construct an email/i);
  });

  it("tells the model never to print a resolved third-party address", () => {
    const prompt = buildSystemPrompt(selection(), null, false, "America/Los_Angeles");
    expect(prompt).toMatch(/never write it in your reply/i);
  });

  it("tells the model that opaque contact tokens are valid and must be passed through", () => {
    // Without this the model sees ref-xxxxxxxx@contacts.internal, judges it
    // fake, and asks the user for a "real" address — refusing a contact it
    // just resolved. Observed live before the rule existed.
    const prompt = buildSystemPrompt(selection(), null, false, "America/Los_Angeles");
    expect(prompt).toContain(CONTACT_TOKEN_EXAMPLE);
    expect(prompt).toMatch(/never reject one as fake/i);
  });

  it("shows the model the real token shape, so the prompt can't drift from contactRefs", () => {
    // The example must actually be a token the resolver recognizes; if the
    // format changes, this fails rather than leaving the prompt describing a
    // shape that no longer exists.
    expect(isContactToken(CONTACT_TOKEN_EXAMPLE)).toBe(true);
  });

  it("tells the model to ask rather than invent a missing event time", () => {
    const prompt = buildSystemPrompt(selection(), null, false, "America/Los_Angeles");
    expect(prompt).toMatch(/ask one concise question/i);
    expect(prompt).toMatch(/never invent a time/i);
  });

  it("resolves relative dates against the timezone it's given, not the server's own", () => {
    const prompt = buildSystemPrompt(selection(), null, false, "Asia/Kolkata");
    expect(prompt).toContain("Asia/Kolkata");
  });
});
