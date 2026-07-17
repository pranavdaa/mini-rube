/**
 * Shared between server (src/lib/attachments.ts) and client (src/app/App.tsx):
 * plain constants only, no Bun/Node/DOM-only APIs, so this one file bundles
 * cleanly on both sides of the Vite/Bun split.
 */

/** Only PDFs are accepted — this is the one prompt that needs an attachment. */
export const ALLOWED_ATTACHMENT_CONTENT_TYPE = "application/pdf";

/**
 * Gmail rejects a message over ~25MB *after* base64 encoding (~37% inflation).
 * 10MB raw stays comfortably under that with room for the body and headers.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
