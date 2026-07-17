import { executeTool } from "../../tools";
import { withRetry } from "../retry";
import type { ItemIdentity, JobContext, Source } from "../types";

/**
 * Google Drive folder contents, paginated to exhaustion.
 *
 * Uses GOOGLESUPER_FIND_FILE (folder_id + pageSize + pageToken). Note
 * ASSIGNMENT_PLAN.md names GOOGLESUPER_LIST_FILES for this — the live catalog
 * marks that tool deprecated ("use FIND_FILE instead"), as it does
 * GET_FILE_V2. Verified against the live catalog 2026-07-16.
 */

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
}

/** Drive's own page cap. */
const MAX_PAGE_SIZE = 1000;

/** Refuse to loop forever if the provider keeps handing back a cursor. */
const MAX_PAGES = 500;

/**
 * Accept a folder id or any Drive URL containing one.
 * e.g. https://drive.google.com/drive/folders/<id>?usp=sharing
 */
export function parseFolderRef(ref: string): string {
  const trimmed = ref.trim();

  const fromUrl = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (fromUrl?.[1]) return fromUrl[1];

  const fromQuery = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (fromQuery?.[1]) return fromQuery[1];

  // A bare id: Drive ids are long, opaque and have no slashes or spaces.
  if (/^[a-zA-Z0-9_-]{10,}$/.test(trimmed)) return trimmed;

  throw new Error(`"${ref}" is not a Drive folder. Expected a folder URL or id.`);
}

export const driveFolderSource: Source<DriveFile> = {
  id: "drive_folder",
  sourceColumn: "Source file",

  identify(file: DriveFile): ItemIdentity {
    return { id: file.id, label: file.name };
  },

  async *pages(ctx: JobContext, opts: { pageSize: number }) {
    const folderId = parseFolderRef(ctx.ref);
    const pageSize = Math.min(opts.pageSize, MAX_PAGE_SIZE);
    let pageToken: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      if (ctx.signal?.aborted) throw new Error("aborted");

      const args: Record<string, unknown> = {
        folder_id: folderId,
        pageSize,
        // Ask for only what we need; the default field set is far wider.
        fields: "nextPageToken, files(id, name, mimeType)",
      };
      if (pageToken) args.pageToken = pageToken;

      const res: any = await withRetry(() => executeTool("GOOGLESUPER_FIND_FILE", ctx.userId, args), {
        signal: ctx.signal,
        onRetry: (attempt, delay, err) => {
          if (ctx.stats) ctx.stats.page_retries = (ctx.stats.page_retries ?? 0) + 1;
          console.warn(`[job] drive page retry ${attempt} in ${delay}ms: ${err.message}`);
        },
      });

      if (res?.successful === false || res?.error) {
        throw new Error(`GOOGLESUPER_FIND_FILE failed: ${String(res?.error ?? "unknown error")}`);
      }

      const files: any[] = res?.data?.files ?? [];
      yield files
        .filter((f) => !isFolder(f))
        .map((f) => ({
          id: String(f?.id ?? ""),
          name: String(f?.name ?? "(unnamed)"),
          mimeType: String(f?.mimeType ?? ""),
        }))
        .filter((f) => f.id);

      // Follow Drive's own cursor. Stop only when it says there is no more —
      // never on a count, which Drive does not promise.
      pageToken = res?.data?.nextPageToken;
      if (!pageToken) return;
    }
  },
};

function isFolder(file: any): boolean {
  return String(file?.mimeType ?? "") === "application/vnd.google-apps.folder";
}
