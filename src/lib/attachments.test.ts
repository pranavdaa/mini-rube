import { describe, expect, it } from "bun:test";
import { extractAttachmentPayloads, uploadAttachment } from "./attachments";

/** A tiny valid data URL — content doesn't matter for validation-path tests. */
function pdfDataUrl(byteLength = 4): string {
  const bytes = Buffer.alloc(byteLength, 1);
  return `data:application/pdf;base64,${bytes.toString("base64")}`;
}

describe("extractAttachmentPayloads", () => {
  it("returns nothing when there is no user message", () => {
    expect(extractAttachmentPayloads([{ role: "assistant" }])).toEqual([]);
  });

  it("prefers the newest attachment, so re-attaching replaces rather than accumulates", () => {
    const older = { role: "user", experimental_attachments: [{ name: "old.pdf", url: pdfDataUrl() }] };
    const latest = { role: "user", experimental_attachments: [{ name: "new.pdf", url: pdfDataUrl() }] };
    const out = extractAttachmentPayloads([older, { role: "assistant" }, latest]);
    expect(out.map((a) => a.name)).toEqual(["new.pdf"]);
  });

  it("drops entries without a url", () => {
    const msg = { role: "user", experimental_attachments: [{ name: "broken.pdf" }] } as any;
    expect(extractAttachmentPayloads([msg])).toEqual([]);
  });

  /**
   * The reported bug: attach a PDF, the agent asks who to send it to — as it
   * should when a required value is missing — and the answer is a fresh message
   * with no file on it. Reading only the newest message lost the attachment, so
   * the agent said it could not find the file the user was looking straight at.
   */
  it("finds the attachment when the latest message is an answer to the agent's question", () => {
    const convo = [
      {
        role: "user",
        content: "Send an email with the attached pdf",
        experimental_attachments: [{ name: "cv.pdf", url: pdfDataUrl() }],
      },
      { role: "assistant", content: "Who should I send it to?" },
      { role: "user", content: "test@gmail.com, no subject, no body" },
    ];
    expect(extractAttachmentPayloads(convo as any).map((a) => a.name)).toEqual(["cv.pdf"]);
  });

  it("stops carrying an attachment forward once it is stale", () => {
    // A PDF from ten turns ago must not silently ride along on an unrelated email.
    const convo = [
      { role: "user", content: "send pdf", experimental_attachments: [{ name: "cv.pdf", url: pdfDataUrl() }] },
      { role: "user", content: "thanks" },
      { role: "user", content: "now something else" },
      { role: "user", content: "email bob about the meeting" },
    ];
    expect(extractAttachmentPayloads(convo as any)).toEqual([]);
  });

  it("ignores attachments on assistant messages", () => {
    const convo = [
      { role: "assistant", experimental_attachments: [{ name: "nope.pdf", url: pdfDataUrl() }] },
      { role: "user", content: "hi" },
    ];
    expect(extractAttachmentPayloads(convo as any)).toEqual([]);
  });
});

describe("uploadAttachment validation", () => {
  it("rejects a non-PDF content type before any upload happens", async () => {
    await expect(
      uploadAttachment(
        { name: "photo.jpg", contentType: "image/jpeg", url: `data:image/jpeg;base64,${Buffer.from("x").toString("base64")}` },
        "GOOGLESUPER_SEND_EMAIL",
        "googlesuper"
      )
    ).rejects.toThrow(/only pdf/i);
  });

  it("rejects a file over the size limit", async () => {
    const oversized = pdfDataUrl(11 * 1024 * 1024); // > 10MB limit
    await expect(
      uploadAttachment({ name: "big.pdf", contentType: "application/pdf", url: oversized }, "GOOGLESUPER_SEND_EMAIL", "googlesuper")
    ).rejects.toThrow(/limit/i);
  });

  it("rejects a malformed (non-base64) data URL", async () => {
    await expect(
      uploadAttachment(
        { name: "a.pdf", contentType: "application/pdf", url: "data:application/pdf,not-base64" },
        "GOOGLESUPER_SEND_EMAIL",
        "googlesuper"
      )
    ).rejects.toThrow(/base64/i);
  });
});
