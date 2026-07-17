import { executeTool } from "../tools";
import { withRetry } from "./retry";
import type { JobStats } from "./types";

/**
 * Incremental Google Sheets writer.
 *
 * Buffers rows and flushes in batches, so a 1,000-row export is ~10-20 API
 * calls instead of 1,000, and so partial results are visible in the sheet while
 * the job is still running rather than all-or-nothing at the end.
 *
 * Uses GOOGLESUPER_SPREADSHEETS_VALUES_APPEND (the Sheets values.append API).
 * Note ASSIGNMENT_PLAN.md names GOOGLESUPER_CREATE_SPREADSHEET_ROW for this —
 * that is the insertDimension API (insert_index, inherit_from_before), which
 * inserts *blank* rows and cannot carry values. Verified against the live tool
 * schema 2026-07-16.
 */

/** Google's values.append tolerates large payloads; 50-100 keeps calls small. */
const DEFAULT_APPEND_BATCH = 100;
const MIN_APPEND_BATCH = 50;
const MAX_APPEND_BATCH = 100;

export interface SheetHandle {
  spreadsheetId: string;
  url: string;
}

export async function createSheet(userId: string, title: string): Promise<SheetHandle> {
  const res: any = await withRetry(() =>
    executeTool("GOOGLESUPER_CREATE_GOOGLE_SHEET1", userId, { title })
  );
  if (res?.successful === false || res?.error) {
    throw new Error(`Could not create the sheet: ${String(res?.error ?? "unknown error")}`);
  }

  const data = res?.data ?? {};
  const spreadsheetId = data.spreadsheetId ?? data.spreadsheet_id;
  const url = data.spreadsheetUrl ?? data.display_url;
  if (!spreadsheetId) throw new Error("Sheet was created but no spreadsheetId came back");

  return {
    spreadsheetId,
    url: url ?? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
  };
}

/**
 * Buffers rows, flushing whenever the buffer reaches the batch size. Callers
 * must `close()` to flush the tail.
 */
export class SheetWriter {
  private buffer: string[][] = [];
  private written = 0;
  readonly batchSize: number;

  constructor(
    private userId: string,
    readonly handle: SheetHandle,
    batchSize: number = DEFAULT_APPEND_BATCH,
    private signal?: AbortSignal,
    /** Job-owned counters; append retries are recorded here when provided. */
    private stats?: JobStats
  ) {
    // Clamp rather than trust a caller: below 50 the call count balloons on a
    // 1,000-row job; above 100 a single failed append costs too much rework.
    this.batchSize = Math.max(MIN_APPEND_BATCH, Math.min(batchSize, MAX_APPEND_BATCH));
  }

  get rowsWritten(): number {
    return this.written;
  }

  /** Queue rows; flushes automatically once a full batch is available. */
  async add(rows: string[][]): Promise<void> {
    this.buffer.push(...rows);
    while (this.buffer.length >= this.batchSize) {
      await this.flush(this.buffer.splice(0, this.batchSize));
    }
  }

  /** Flush whatever is left. Always call this, even on a failed job. */
  async close(): Promise<number> {
    if (this.buffer.length) {
      await this.flush(this.buffer.splice(0));
    }
    return this.written;
  }

  private async flush(rows: string[][]): Promise<void> {
    if (!rows.length) return;

    const res: any = await withRetry(
      () =>
        executeTool("GOOGLESUPER_SPREADSHEETS_VALUES_APPEND", this.userId, {
          spreadsheetId: this.handle.spreadsheetId,
          range: "Sheet1!A1",
          valueInputOption: "RAW",
          insertDataOption: "INSERT_ROWS",
          values: rows,
        }),
      {
        signal: this.signal,
        onRetry: (attempt, delay, err) => {
          if (this.stats) this.stats.sheet_append_retries = (this.stats.sheet_append_retries ?? 0) + 1;
          console.warn(`[job] sheet append retry ${attempt} in ${delay}ms: ${err.message}`);
        },
      }
    );

    if (res?.successful === false || res?.error) {
      throw new Error(`Sheet append failed: ${String(res?.error ?? "unknown error")}`);
    }

    // Trust the API's own count over our own optimism.
    const updated = res?.data?.updates?.updatedRows;
    this.written += typeof updated === "number" ? updated : rows.length;
  }
}
