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
    expect(report.droppedFields).toEqual(["messageText", "payload"]);
  });

  it("keeps exactly the identifying fields the briefing needs", () => {
    const { result } = compactToolResult(emailResult(5));
    const m = (result as any).data.messages[0];

    expect(m.sender).toBe("someone0@example.com");
    expect(m.subject).toBe("Subject 0");
    expect(m.messageTimestamp).toBe("2026-07-16T20:18:20Z");
    expect(m.labelIds).toEqual(["INBOX", "UNREAD"]);
    expect(m.preview).toBeDefined();

    expect(m.payload).toBeUndefined();
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
    expect((result as any)._note).toContain("payload");
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
