import { describe, expect, it } from "bun:test";
import { findFileUploadableField } from "./attachmentField";

/**
 * Mirrors the live GOOGLESUPER_SEND_EMAIL schema's `attachment` param
 * (fetched directly from Composio and inspected before writing this): an
 * anyOf of a single FileUploadable object and an array of the same, each
 * branch carrying `file_uploadable: true`.
 */
const SEND_EMAIL_ATTACHMENT_PARAM = {
  anyOf: [
    {
      type: "object",
      properties: { name: {}, s3key: {}, mimetype: {} },
      required: ["name", "mimetype", "s3key"],
      file_uploadable: true,
    },
    {
      type: "array",
      items: {
        type: "object",
        properties: { name: {}, s3key: {}, mimetype: {} },
        required: ["name", "mimetype", "s3key"],
        file_uploadable: true,
      },
    },
  ],
};

describe("findFileUploadableField", () => {
  it("finds the field on a schema shaped like the live SEND_EMAIL attachment param", () => {
    const schema = {
      type: "object",
      properties: {
        subject: { type: "string" },
        body: { type: "string" },
        attachment: SEND_EMAIL_ATTACHMENT_PARAM,
      },
    };
    expect(findFileUploadableField(schema)).toBe("attachment");
  });

  it("finds a directly-flagged field with no anyOf wrapping", () => {
    const schema = {
      properties: {
        file: { type: "object", file_uploadable: true },
      },
    };
    expect(findFileUploadableField(schema)).toBe("file");
  });

  it("finds a bare array-of-uploadable field", () => {
    const schema = {
      properties: {
        files: { type: "array", items: { file_uploadable: true } },
      },
    };
    expect(findFileUploadableField(schema)).toBe("files");
  });

  it("returns null when no field accepts a file", () => {
    const schema = {
      properties: {
        subject: { type: "string" },
        body: { type: "string" },
      },
    };
    expect(findFileUploadableField(schema)).toBeNull();
  });

  it("returns null for a missing or malformed schema", () => {
    expect(findFileUploadableField(undefined)).toBeNull();
    expect(findFileUploadableField({})).toBeNull();
  });
});
