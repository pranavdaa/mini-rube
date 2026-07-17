import { composio } from "./composio";
import { ALLOWED_ATTACHMENT_CONTENT_TYPE, MAX_ATTACHMENT_BYTES } from "./attachment-limits";

/**
 * Server-side handling of a user-uploaded attachment.
 *
 * The client sends the file as a base64 data URL inside the chat message
 * (AI SDK's `experimental_attachments`). That is the *only* place raw bytes
 * exist outside this module: they are decoded here, validated here, and
 * handed straight to Composio's own S3 uploader — never written to a local
 * path, never logged, and (see agent.ts) stripped from the messages before
 * they reach the model.
 */

export interface RawAttachment {
  name?: string;
  contentType?: string;
  /** A data: URL — the AI SDK's client-side FileList -> Attachment conversion. */
  url: string;
}

/** The exact shape Composio's file-uploadable fields require (verified against the live GOOGLESUPER_SEND_EMAIL schema). */
export interface UploadedAttachment {
  name: string;
  mimetype: string;
  s3key: string;
}

interface LooseMessageWithAttachments {
  role?: string;
  experimental_attachments?: RawAttachment[];
}

/**
 * How many recent user turns may carry an attachment forward.
 *
 * The reported bug: attach a PDF and say "send an email with the attached pdf",
 * the agent correctly asks who to send it to, and the answer — a fresh message
 * with no file on it — loses the attachment. The file only ever reaches the
 * turn it was typed on, so the agent then reports it cannot find the file the
 * user is looking straight at.
 *
 * The bytes are still available: the file stays on its original message in the
 * conversation, and useChat re-sends the whole history (that is how the UI keeps
 * rendering the attachment chip). We simply were not looking past the newest
 * message.
 *
 * Bounded to a few turns rather than the whole conversation, because carrying an
 * attachment forever is its own bug: a PDF attached ten turns ago must not
 * silently ride along on an unrelated email. Three covers ask-and-answer with
 * margin; anything staler, the user can re-attach.
 */
const ATTACHMENT_LOOKBACK_TURNS = 3;

/**
 * Raw attachments (with bytes) for this turn: the newest user message that
 * carries any, within the lookback window.
 *
 * A newer attachment always wins — the search stops at the first user turn that
 * has one, so re-attaching replaces rather than accumulates.
 */
export function extractAttachmentPayloads(
  messages: LooseMessageWithAttachments[]
): RawAttachment[] {
  const recentUserTurns = messages.filter((m) => m.role === "user").slice(-ATTACHMENT_LOOKBACK_TURNS);

  for (const message of [...recentUserTurns].reverse()) {
    const attachments = (message.experimental_attachments ?? []).filter(
      (a): a is RawAttachment => typeof a?.url === "string"
    );
    if (attachments.length) return attachments;
  }
  return [];
}

function decodeDataUrl(url: string): { mimeType: string; bytes: Uint8Array<ArrayBuffer> } {
  const match = /^data:([^;,]*)(?:;charset=[^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (!match || !match[2]) {
    throw new Error("Attachment must be a base64-encoded data URL.");
  }
  const [, mimeType, , data] = match;
  // Buffer.from allocates a plain (non-shared) ArrayBuffer under the hood, but its
  // type is the wider ArrayBufferLike — copy into a freshly-typed Uint8Array so it
  // satisfies BlobPart for `new File([...])` below.
  const decoded = Buffer.from(data!, "base64");
  const bytes = new Uint8Array(decoded.length);
  bytes.set(decoded);
  return { mimeType: mimeType || "application/octet-stream", bytes };
}

/** Reject anything that isn't a PDF, or that exceeds the size limit — never trust the client's own claims alone. */
function assertValidPdf(attachment: RawAttachment, byteLength: number): void {
  const looksLikePdf =
    attachment.contentType === ALLOWED_ATTACHMENT_CONTENT_TYPE ||
    (!attachment.contentType && attachment.name?.toLowerCase().endsWith(".pdf"));

  if (!looksLikePdf) {
    throw new Error(
      `Only PDF attachments are supported (got ${attachment.contentType || "an unrecognized type"}).`
    );
  }

  if (byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachment "${attachment.name ?? "file"}" is ${(byteLength / (1024 * 1024)).toFixed(1)}MB, ` +
        `over the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB limit.`
    );
  }
}

/**
 * Decode, validate, and upload one attachment to Composio's file store, in
 * the exact {name, mimetype, s3key} shape the live tool schemas require.
 *
 * Bytes never touch the filesystem: `File` is constructed in memory and handed
 * directly to the SDK's uploader, so there is no local path to ever leak.
 */
export async function uploadAttachment(
  attachment: RawAttachment,
  toolSlug: string,
  toolkitSlug: string
): Promise<UploadedAttachment> {
  const { mimeType, bytes } = decodeDataUrl(attachment.url);
  assertValidPdf(attachment, bytes.length);

  const name = attachment.name?.trim() || "attachment.pdf";
  const file = new File([bytes], name, { type: attachment.contentType || mimeType });

  return composio.files.upload({ file, toolSlug, toolkitSlug });
}
