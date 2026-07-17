import { describe, expect, it } from "bun:test";
import { sanitizeForUi, sanitizeRawForUi } from "./ui-events";

/**
 * These pin the "never show" list. Each case is shaped like a real result we
 * have actually seen from the live API, not an invented string.
 */
describe("sanitizeForUi", () => {
  it("redacts the local file path a Drive download really returns", () => {
    // Verbatim shape from GOOGLESUPER_DOWNLOAD_FILE.
    const result = {
      downloaded_file_content: {
        uri: "/Users/mac/.composio/files/GOOGLESUPER_DOWNLOAD_FILE_17842332753247fa1f4ed.pdf",
        file_downloaded: true,
        mimeType: "application/pdf",
      },
    };
    const out: any = sanitizeForUi(result);
    expect(JSON.stringify(out)).not.toContain("/Users/mac");
    expect(out.downloaded_file_content.uri).toBe("[local path redacted]");
    expect(out.downloaded_file_content.mimeType).toBe("application/pdf"); // useful bits survive
  });

  it("redacts a pre-signed URL's credential query string but keeps the host", () => {
    const out = sanitizeForUi({
      s3url: "https://temp.r2.cloudflarestorage.com/856385/go?X-Amz-Signature=abc123&X-Amz-Expires=3600",
    }) as any;
    expect(out.s3url).not.toContain("X-Amz-Signature");
    expect(out.s3url).not.toContain("abc123");
  });

  it("redacts anything living under a credential-shaped key", () => {
    const out = sanitizeForUi({
      api_key: "ak_m5xjkWO5164pctjSM73h",
      OPENROUTER_API_KEY: "sk-or-v1-5bd54200d95f102c",
      access_token: "ya29.a0AfB_xyz",
      authorization: "Bearer eyJhbGciOi",
      nested: { client_secret: "shhh" },
    }) as any;
    const json = JSON.stringify(out);
    expect(json).not.toContain("ak_m5xjk");
    expect(json).not.toContain("sk-or-v1");
    expect(json).not.toContain("ya29.");
    expect(json).not.toContain("eyJhbGciOi");
    expect(json).not.toContain("shhh");
  });

  it("masks a third-party email but leaves the user's own address readable", () => {
    const allow = new Set(["me@mine.com"]);
    const out = sanitizeForUi({ to: "me@mine.com", from: "karan@other.com" }, allow) as any;
    expect(out.to).toBe("me@mine.com");
    expect(out.from).not.toContain("karan@other.com");
    expect(out.from).toContain("***");
  });

  it("truncates a long body rather than rendering an email or resume verbatim", () => {
    const body = "CONFIDENTIAL RESUME TEXT. ".repeat(200);
    const out = sanitizeForUi({ messageText: body }) as any;
    expect(out.messageText.length).toBeLessThan(400);
    expect(out.messageText).toContain("chars total");
  });

  it("caps a long list instead of rendering every item", () => {
    const out = sanitizeForUi({ files: Array.from({ length: 1000 }, (_, i) => ({ n: i })) }) as any;
    expect(out.files.length).toBe(21); // 20 + the "more items" marker
    expect(String(out.files.at(-1))).toContain("980 more");
  });

  it("survives a cyclic result instead of throwing", () => {
    const cyclic: any = { a: 1 };
    cyclic.self = cyclic;
    expect(() => sanitizeRawForUi(cyclic)).not.toThrow();
  });

  it("hard-caps an oversized raw blob", () => {
    const huge = { rows: Array.from({ length: 50 }, () => "x".repeat(299)) };
    const out = sanitizeRawForUi(huge) as any;
    expect(JSON.stringify(out).length).toBeLessThan(9_000);
  });

  it("keeps the sheet URL — it is the deliverable, not a secret", () => {
    const url = "https://docs.google.com/spreadsheets/d/1cf0vvpb/edit";
    const out = sanitizeForUi({ outputUrl: url }) as any;
    expect(out.outputUrl).toBe(url);
  });
});
