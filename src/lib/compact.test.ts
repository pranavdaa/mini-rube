import { describe, expect, it } from "bun:test";
import { compactToolResult } from "./compact";

/** A message shaped like a real GOOGLESUPER_FETCH_EMAILS record. */
function message(i: number, bodyChars = 16_000) {
  return {
    messageId: `id-${i}`,
    threadId: `thread-${i}`,
    sender: `someone${i}@example.com`,
    to: "me@example.com",
    subject: `Subject ${i}`,
    messageTimestamp: "2026-07-16T20:18:20Z",
    labelIds: ["INBOX", "UNREAD"],
    preview: { body: "a short snippet of the email" },
    messageText: "x".repeat(1_200),
    payload: { mimeType: "multipart/mixed", raw: "y".repeat(bodyChars) },
  };
}

const emailResult = (n: number) => ({
  successful: true,
  data: { messages: Array.from({ length: n }, (_, i) => message(i)), nextPageToken: "tok", resultSizeEstimate: n },
});

describe("compactToolResult", () => {
  it("leaves a small result untouched", () => {
    const small = { successful: true, data: { messages: [{ subject: "hi" }] } };
    const { result, report } = compactToolResult(small);
    expect(report.compacted).toBe(false);
    expect(result).toEqual(small);
  });

  it("drops oversized fields but keeps every record", () => {
    // 5 emails is ~518k chars live — well past any context window.
    const { result, report } = compactToolResult(emailResult(5));
    const msgs = (result as any).data.messages;

    expect(report.compacted).toBe(true);
    expect(msgs).toHaveLength(5); // no record silently lost
    expect(report.omittedItems).toBe(0);
    // "raw", not "payload": the payload *container* is recursed into and kept
    // (its small mimeType is useful); only its 16KB raw leaf is dropped.
    expect(report.droppedFields).toEqual(["messageText", "raw"]);
  });

  it("keeps exactly the identifying fields the briefing needs", () => {
    const { result } = compactToolResult(emailResult(5));
    const m = (result as any).data.messages[0];

    expect(m.sender).toBe("someone0@example.com");
    expect(m.subject).toBe("Subject 0");
    expect(m.messageTimestamp).toBe("2026-07-16T20:18:20Z");
    expect(m.labelIds).toEqual(["INBOX", "UNREAD"]);
    expect(m.preview).toBeDefined();

    // The container survives with its small metadata; the bulk inside it goes.
    expect(m.payload).toEqual({ mimeType: "multipart/mixed" });
    expect(m.messageText).toBeUndefined();
  });

  it("brings a context-blowing result under budget", () => {
    const before = JSON.stringify(emailResult(5)).length;
    const { report } = compactToolResult(emailResult(5));
    expect(before).toBeGreaterThan(80_000);
    expect(report.finalChars).toBeLessThan(32_000);
  });

  it("preserves sibling metadata outside the record list", () => {
    const { result } = compactToolResult(emailResult(5));
    expect((result as any).data.nextPageToken).toBe("tok");
    expect((result as any).successful).toBe(true);
  });

  it("caps item count only when pruning fields is not enough, and reports the loss", () => {
    // 4,000 lean records: nothing is individually fat, but the list is huge.
    const many = {
      data: {
        messages: Array.from({ length: 4000 }, (_, i) => ({
          messageId: `id-${i}`,
          subject: `Subject ${i}`,
          sender: `s${i}@example.com`,
        })),
      },
    };
    const { result, report } = compactToolResult(many);
    const kept = (result as any).data.messages.length;

    expect(report.omittedItems).toBeGreaterThan(0);
    expect(kept + report.omittedItems).toBe(4000); // nothing vanishes unaccounted for
    expect(report.finalChars).toBeLessThanOrEqual(32_000);
    expect((result as any)._note).toContain("omitted");
  });

  it("tells the model what was removed rather than hiding it", () => {
    const { result } = compactToolResult(emailResult(5));
    expect((result as any)._note).toContain("raw");
  });

  it("is generic: prunes a GitHub-shaped result with no per-tool code", () => {
    const issues = {
      data: Array.from({ length: 40 }, (_, i) => ({
        number: i,
        title: `Issue ${i}`,
        state: "open",
        body: "z".repeat(2_000),
      })),
    };
    const { result, report } = compactToolResult(issues);
    const items = (result as any).data;

    expect(items).toHaveLength(40);
    expect(items[0].title).toBe("Issue 0");
    expect(items[0].state).toBe("open");
    expect(items[0].body).toBeUndefined();
    expect(report.droppedFields).toContain("body");
  });

  it("survives a non-serializable result instead of throwing", () => {
    const circular: any = { data: {} };
    circular.data.self = circular;
    expect(() => compactToolResult(circular)).not.toThrow();
  });
});

describe("failure results", () => {
  /**
   * A 110KB HTML error page from a real Composio GitHub call. The error field
   * blew the field budget and was dropped, so the model got a 47-char result
   * and invented three plausible causes, none of them true.
   */
  const htmlErrorPage =
    "<!DOCTYPE html>\n<html><head><title>Unicorn! &middot; GitHub</title>" +
    "<style>" + "a".repeat(60_000) + "</style></head>" +
    "<body><div>No server is currently available to service your request.</div></body></html>";

  const failed = { successful: false, error: htmlErrorPage, data: { raw: htmlErrorPage }, logId: "log_1" };

  it("shortens an oversized error instead of dropping it", () => {
    const { result, report } = compactToolResult(failed);
    // data is recursed into rather than dropped wholesale; its raw leaf goes.
    expect(report.droppedFields).toContain("raw");
    expect(report.shortenedFields).toContain("error");
    expect((result as any).error).toBeDefined();
  });

  it("keeps the part of the error that identifies the failure", () => {
    const { result } = compactToolResult(failed);
    const error = String((result as any).error);
    expect(error).toContain("Unicorn! · GitHub"); // entity-decoded title
    expect(error).toContain("No server is currently available");
    expect(error).not.toContain("<style>"); // markup stripped
    expect(error.length).toBeLessThan(600);
  });

  it("names it as provider-side so the model reports rather than guesses", () => {
    const { result } = compactToolResult(failed);
    expect(String((result as any).error)).toContain("provider-side failure");
    expect(String((result as any)._note)).toContain("shortened, not removed");
  });

  it("preserves the failure flag", () => {
    expect((compactToolResult(failed).result as any).successful).toBe(false);
  });

  it("truncates a huge non-HTML error rather than dropping it", () => {
    const { result, report } = compactToolResult({
      successful: false,
      error: "boom: " + "x".repeat(50_000),
      data: { junk: "y".repeat(40_000) },
    });
    expect(report.shortenedFields).toContain("error");
    expect(String((result as any).error).startsWith("boom: ")).toBe(true);
    expect(String((result as any).error).length).toBeLessThan(400);
  });

  it("shortens a top-level error even when a record list is present", () => {
    const { result, report } = compactToolResult({
      successful: false,
      error: htmlErrorPage,
      data: { messages: Array.from({ length: 5 }, (_, i) => ({ id: i, body: "z".repeat(20_000) })) },
    });
    expect(report.shortenedFields).toContain("error");
    expect((result as any).data.messages).toHaveLength(5); // records still intact
  });
});

describe("multiple record arrays (aliased GraphQL)", () => {
  /**
   * Seen live: "look at the issues" ran a GraphQL query aliasing open and
   * closed issues — two sibling nodes[] arrays. The guard compacted only the
   * largest and let the other ride into context whole: 517,050 → 253,097 chars
   * (~63k tokens), eight times the budget, reported as a success.
   */
  const issue = (i: number) => ({
    number: i,
    title: `Issue ${i}`,
    state: "OPEN",
    body: "x".repeat(2_400),
    author: { login: `user${i}` },
  });
  const aliased = {
    successful: true,
    data: {
      data: {
        repository: {
          openIssues: { nodes: Array.from({ length: 100 }, (_, i) => issue(i)) },
          closedIssues: { nodes: Array.from({ length: 100 }, (_, i) => issue(i + 100)) },
        },
      },
    },
  };

  it("compacts every record array, not just the largest", () => {
    const { result, report } = compactToolResult(aliased);
    const repo = (result as any).data.data.repository;

    expect(report.finalChars).toBeLessThanOrEqual(32_000);
    // Both lists complete, both stripped of bodies.
    expect(repo.openIssues.nodes).toHaveLength(100);
    expect(repo.closedIssues.nodes).toHaveLength(100);
    expect(repo.openIssues.nodes[0].body).toBeUndefined();
    expect(repo.closedIssues.nodes[0].body).toBeUndefined();
    expect(repo.openIssues.nodes[0].title).toBe("Issue 0");
    expect(repo.closedIssues.nodes[99].title).toBe("Issue 199");
  });

  it("caps across arrays, largest first, when pruning is not enough", () => {
    // Bodies small enough to survive pruning; volume alone breaks the budget.
    const lean = (i: number) => ({ number: i, title: `t${i}`, note: "n".repeat(300) });
    const twoBig = {
      data: {
        a: { nodes: Array.from({ length: 900 }, (_, i) => lean(i)) },
        b: { nodes: Array.from({ length: 300 }, (_, i) => lean(i)) },
      },
    };
    const { result, report } = compactToolResult(twoBig);
    const d = (result as any).data;

    expect(report.finalChars).toBeLessThanOrEqual(32_000);
    expect(report.omittedItems).toBeGreaterThan(0);
    // Nothing vanishes unaccounted for, across BOTH arrays.
    expect(d.a.nodes.length + d.b.nodes.length + report.omittedItems).toBe(1200);
  });
});

describe("budget backstop", () => {
  it("holds the budget even for a shape the structural passes cannot shrink", () => {
    // Thousands of small fields, no arrays: pruning keeps every field (each is
    // tiny) and there is nothing to cap. Only the backstop can save this.
    const flat: any = { data: {} };
    for (let i = 0; i < 9_000; i++) flat.data[`k${i}`] = "v".repeat(50);

    const { result, report } = compactToolResult(flat);
    expect(report.finalChars).toBeLessThanOrEqual(32_000);
    expect((result as any).truncated_preview).toBeDefined();
    expect((result as any)._note).toContain("truncated wholesale");
  });

  it("never exceeds the budget for arrays nested past the walk depth", () => {
    let deep: any = { leaf: { nodes: Array.from({ length: 200 }, (_, i) => ({ i, body: "y".repeat(3_000) })) } };
    for (let i = 0; i < 8; i++) deep = { level: deep };
    const { report } = compactToolResult({ data: deep });
    expect(report.finalChars).toBeLessThanOrEqual(32_000);
  });
});
