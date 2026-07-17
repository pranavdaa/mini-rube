import { describe, expect, it, beforeEach } from "bun:test";
import { maskEmailAddress, scrubEmails, scrubDeep, createStreamScrubber } from "./redact";
import { tokenizeContactEmails, clearContactTokenCache } from "./contactRefs";

beforeEach(clearContactTokenCache);

describe("maskEmailAddress", () => {
  it("keeps the domain, masks the local part", () => {
    expect(maskEmailAddress("karan.sharma@gmail.com")).toBe("k***@gmail.com");
  });

  it("degrades to a plain mask for a non-address", () => {
    expect(maskEmailAddress("not-an-email")).toBe("***");
  });
});

describe("scrubEmails", () => {
  it("masks a third-party address embedded in prose", () => {
    const out = scrubEmails("I found Karan's address: karan@example.com and added them.", new Set());
    expect(out).not.toContain("karan@example.com");
    expect(out).toContain("k***@example.com");
  });

  it("leaves an allow-listed address (the user's own) untouched", () => {
    const allow = new Set(["me@mycompany.com"]);
    const out = scrubEmails("Sent it to me@mycompany.com as requested.", allow);
    expect(out).toContain("me@mycompany.com");
  });

  it("allow-list matching is case-insensitive", () => {
    const allow = new Set(["me@mycompany.com"]);
    const out = scrubEmails("Sent to ME@MyCompany.com", allow);
    expect(out).toContain("ME@MyCompany.com");
  });

  it("masks multiple distinct third-party addresses", () => {
    const out = scrubEmails("cc karan@example.com and priya@example.org", new Set());
    expect(out).not.toContain("karan@example.com");
    expect(out).not.toContain("priya@example.org");
  });

  it("leaves text with no email untouched", () => {
    expect(scrubEmails("Created the event for tomorrow at 3pm.", new Set())).toBe(
      "Created the event for tomorrow at 3pm."
    );
  });

  it("leaves a contact token untouched — masking it would corrupt round-tripping", () => {
    // Regression: an earlier version masked the token itself (it's
    // syntactically email-shaped on purpose), turning a resolvable
    // "ref-xxxxxxxx@contacts.internal" into an unresolvable
    // "r***@contacts.internal" before it ever reached conversation history —
    // so a later turn's resolveContactTokens() could no longer recover the
    // real address and the model invented one instead.
    const token = tokenizeContactEmails("karan@example.com") as unknown as string;
    expect(scrubEmails(`Found them: ${token}`, new Set())).toContain(token);
  });
});

describe("scrubDeep", () => {
  it("scrubs string leaves inside nested objects and arrays", () => {
    const result = scrubDeep(
      {
        attendees: [{ email: "karan@example.com", displayName: "Karan" }],
        note: "invited karan@example.com",
      },
      new Set()
    );
    expect(JSON.stringify(result)).not.toContain("karan@example.com");
  });

  it("does not mutate the original value", () => {
    const original = { email: "karan@example.com" };
    scrubDeep(original, new Set());
    expect(original.email).toBe("karan@example.com");
  });
});

describe("createStreamScrubber", () => {
  it("redacts an email split across two chunks", () => {
    const scrubber = createStreamScrubber(new Set());
    let out = "";
    out += scrubber.push("I invited kar");
    out += scrubber.push("an@example.com to the meeting. ");
    out += scrubber.push("Anything else you'd like me to do regarding scheduling or other tasks today?");
    out += scrubber.flush();
    expect(out).not.toContain("karan@example.com");
    expect(out).toContain("k***@example.com");
  });

  it("passes plain text through once the buffer fills, unchanged", () => {
    const scrubber = createStreamScrubber(new Set());
    const long = "no addresses here, just plain text ".repeat(10);
    let out = "";
    for (const word of long.split(" ")) out += scrubber.push(word + " ");
    out += scrubber.flush();
    expect(out.replace(/\s+/g, " ").trim()).toBe(long.replace(/\s+/g, " ").trim());
  });

  it("still flushes a short reply that never exceeds the buffer", () => {
    const scrubber = createStreamScrubber(new Set());
    const out = scrubber.push("karan@example.com") + scrubber.flush();
    expect(out).toContain("k***@example.com");
  });

  it("does not corrupt an email when a long reply keeps streaming after it", () => {
    // Regression: an earlier version held back a fixed-length trailing
    // window and released the *oldest* excess character on every push() once
    // the buffer filled — so once enough text streamed in after the email,
    // release would cut straight through it (e.g. "kar" now, "an@x.com"
    // later), and each half independently fails to match the email pattern.
    // This reproduces that shape: single-character deltas, exactly like a
    // real model's token stream, with a long tail after the email.
    const scrubber = createStreamScrubber(new Set());
    const before = "I found Karan Test (";
    const email = "karan.test.contact@example.com";
    const after =
      "). To schedule the event for tomorrow, I need a few more details: what time should it start, " +
      "how long should it be, and what should the title say?";

    let out = "";
    for (const ch of before + email + after) out += scrubber.push(ch);
    out += scrubber.flush();

    expect(out).not.toContain(email);
    expect(out).toContain("k***@example.com");
  });

  it("holds back a still-growing token rather than releasing it piecemeal", () => {
    const scrubber = createStreamScrubber(new Set());
    let released = "";
    for (const ch of "karan.test.contact@example") released += scrubber.push(ch);
    // Nothing should have been released yet — "example" could still become
    // "example.com", "example.org", etc. Releasing early risks emitting a
    // fragment before the boundary that decides whether it's an email at all.
    expect(released).toBe("");
  });
});
