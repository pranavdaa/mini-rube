import { describe, expect, it } from "bun:test";
import { extractRequest, routeWithContext } from "./select";
import { Router } from "./router";
import type { CompactTool } from "./types";

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
  tool({
    slug: "GOOGLESUPER_CREATE_EVENT",
    toolkit: "googlesuper",
    description: "Create a calendar event with attendees at a given time",
    tags: ["calendar"],
    readonly: false,
  }),
  tool({
    slug: "GOOGLESUPER_FETCH_EMAILS",
    toolkit: "googlesuper",
    description: "Fetch email messages from Gmail",
    tags: ["gmail"],
    readonly: true,
  }),
];

const router = new Router(FIXTURE, ["googlesuper"]);

describe("extractRequest", () => {
  it("returns the latest user turn plus earlier ones as context, most recent first", () => {
    const req = extractRequest([
      { role: "user", content: "first" },
      { role: "assistant", content: "ignored" },
      { role: "user", content: "second" },
      { role: "user", content: "latest" },
    ]);
    expect(req.text).toBe("latest");
    expect(req.context).toEqual(["second", "first"]);
  });

  it("has no context on the first turn", () => {
    expect(extractRequest([{ role: "user", content: "hello" }]).context).toEqual([]);
  });

  it("reads text out of typed content parts", () => {
    const req = extractRequest([
      { role: "user", content: [{ type: "text", text: "schedule" }, { type: "text", text: "a meeting" }] },
    ]);
    expect(req.text).toBe("schedule a meeting");
  });
});

describe("routeWithContext", () => {
  /**
   * The reported bug: the agent asks "what time?" — which CLAUDE.md tells it to
   * do when a required value is missing — and then cannot route the answer.
   * "10 am and 30 mins" carries no calendar vocabulary at all.
   */
  it("routes a follow-up answer using the task it belongs to", () => {
    const req = extractRequest([
      { role: "user", content: "Schedule a meeting with Karan tomorrow" },
      { role: "assistant", content: "What time, and how long?" },
      { role: "user", content: "10 am and 30 mins" },
    ]);
    const { routed, usedContext } = routeWithContext(router, req);

    expect(usedContext).toBe(true);
    expect(routed.candidates[0]?.slug).toBe("GOOGLESUPER_CREATE_EVENT");
  });

  it("rescues a bare time that matches nothing on its own", () => {
    // "10am" alone tokenizes to ["am"] and matched zero of 1,360 tools, which
    // used to throw and surface as "An error occurred."
    const alone = routeWithContext(router, { text: "10am", attachments: [], context: [] });
    expect(alone.routed.candidates).toHaveLength(0);

    const withTask = routeWithContext(router, {
      text: "10am",
      attachments: [],
      context: ["Schedule a meeting with Karan tomorrow"],
    });
    expect(withTask.usedContext).toBe(true);
    expect(withTask.routed.candidates[0]?.slug).toBe("GOOGLESUPER_CREATE_EVENT");
  });

  it("leaves a request that routes well on its own completely alone", () => {
    const req = extractRequest([
      { role: "user", content: "schedule a meeting" },
      { role: "user", content: "fetch my emails from gmail" },
    ]);
    const { routed, usedContext, query } = routeWithContext(router, req);

    expect(usedContext).toBe(false);
    expect(query).toBe("fetch my emails from gmail"); // no earlier turn folded in
    expect(routed.candidates[0]?.slug).toBe("GOOGLESUPER_FETCH_EMAILS");
  });

  it("does not let a finished task pollute the next request", () => {
    const req = extractRequest([
      { role: "user", content: "fetch my emails from gmail" },
      { role: "user", content: "now create a calendar event with attendees" },
    ]);
    const { routed, usedContext } = routeWithContext(router, req);

    expect(usedContext).toBe(false);
    expect(routed.candidates[0]?.slug).toBe("GOOGLESUPER_CREATE_EVENT");
  });

  it("keeps an honest empty result when context cannot help either", () => {
    const { routed, usedContext } = routeWithContext(router, {
      text: "thanks",
      attachments: [],
      context: ["hello there"],
    });
    expect(usedContext).toBe(false);
    expect(routed.candidates).toHaveLength(0);
  });
});
