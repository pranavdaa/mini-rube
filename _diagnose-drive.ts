/**
 * TEMPORARY DIAGNOSTIC SCRIPT — not part of the application.
 * Verifies live Drive access to the target resumes folder using the
 * scaffold's existing Composio client (src/lib/tools.ts) and USER_ID.
 * Delete this file after use.
 */
import { executeTool } from "./src/lib/tools";

const USER_ID = "candidate";
const FOLDER_ID = "1bOEE3JXX-iFqbY99VTRq1ak-UOQULc5r";

function preview(value: unknown, maxLen = 80): string {
  if (typeof value === "string") {
    const redactLooksLikeSecret = /^(ya29\.|Bearer |eyJ|sk-|ak_)/.test(value);
    if (redactLooksLikeSecret) return "[redacted-looks-like-a-token]";
    return value.length > maxLen ? `${value.slice(0, maxLen)}... (len=${value.length})` : value;
  }
  return JSON.stringify(value);
}

async function listAllFiles() {
  let pageToken: string | undefined;
  let page = 0;
  const allFiles: any[] = [];
  const paginationFieldsSeen = new Set<string>();
  let firstPageAccessible = false;
  let lastError: string | null = null;

  do {
    page++;
    const result = await executeTool(USER_ID === "candidate" ? "GOOGLESUPER_FIND_FILE" : "GOOGLESUPER_FIND_FILE", USER_ID, {
      folder_id: FOLDER_ID,
      pageSize: 100,
      fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime)",
      ...(pageToken ? { pageToken } : {}),
    });

    if (!result.successful) {
      lastError = JSON.stringify(result.error);
      console.log(`  page ${page}: FAILED — ${lastError}`);
      break;
    }

    if (page === 1) firstPageAccessible = true;

    const data = result.data as any;
    Object.keys(data ?? {}).forEach((k) => paginationFieldsSeen.add(k));
    const files = data?.files ?? [];
    allFiles.push(...files);
    pageToken = data?.nextPageToken;
    console.log(`  page ${page}: fetched ${files.length} files (running total ${allFiles.length}), nextPageToken=${pageToken ? "present" : "absent"}`);
  } while (pageToken);

  return { allFiles, pageCount: page, paginationFieldsSeen, firstPageAccessible, lastError };
}

async function main() {
  console.log("=".repeat(70));
  console.log("STEP 1 — Folder listing:", FOLDER_ID);
  console.log("=".repeat(70));

  const { allFiles, pageCount, paginationFieldsSeen, firstPageAccessible, lastError } = await listAllFiles();

  console.log("\n--- Summary ---");
  console.log("Folder accessible:", firstPageAccessible ? "YES" : "NO");
  if (lastError) console.log("Last error encountered:", lastError);
  console.log("Pages fetched:", pageCount);
  console.log("Total file count (via full pagination):", allFiles.length);
  console.log("Pagination fields observed in responses:", [...paginationFieldsSeen]);

  console.log("\nFirst 5 file names:");
  allFiles.slice(0, 5).forEach((f, i) => console.log(`  ${i + 1}. ${f.name}  [${f.mimeType}]  size=${f.size ?? "n/a"}`));

  const mimeCounts: Record<string, number> = {};
  for (const f of allFiles) mimeCounts[f.mimeType] = (mimeCounts[f.mimeType] ?? 0) + 1;
  console.log("\nMIME type distribution:", mimeCounts);

  const pdfCount = allFiles.filter((f) => f.mimeType === "application/pdf").length;
  console.log(`Files appearing to be PDFs: ${pdfCount} / ${allFiles.length} (${allFiles.length ? ((pdfCount / allFiles.length) * 100).toFixed(1) : 0}%)`);

  if (allFiles.length === 0) {
    console.log("\nNo files found — skipping download step.");
    return;
  }

  console.log("\n" + "=".repeat(70));
  console.log("STEP 2 — Download one representative file");
  console.log("=".repeat(70));

  const target = allFiles.find((f) => f.mimeType === "application/pdf") ?? allFiles[0];
  console.log(`Target: ${target.name} (id=${target.id}, mimeType=${target.mimeType})`);

  const downloadResult = await executeTool("GOOGLESUPER_DOWNLOAD_FILE", USER_ID, {
    fileId: target.id,
  });

  console.log("\ndownload successful:", downloadResult.successful);
  if (!downloadResult.successful) {
    console.log("error:", JSON.stringify(downloadResult.error));
    return;
  }

  console.log("Top-level response keys:", Object.keys(downloadResult as any));
  const data = downloadResult.data as any;
  console.log("data keys:", data ? Object.keys(data) : null);

  console.log("\n--- Field-by-field shape (values truncated, tokens redacted) ---");
  for (const [k, v] of Object.entries(data ?? {})) {
    if (typeof v === "string") {
      console.log(`  ${k}: string — ${preview(v)}`);
    } else if (v && typeof v === "object") {
      console.log(`  ${k}: object — keys=${JSON.stringify(Object.keys(v))}`);
      for (const [ik, iv] of Object.entries(v)) {
        console.log(`    .${ik}: ${typeof iv === "string" ? preview(iv) : JSON.stringify(iv)}`);
      }
    } else {
      console.log(`  ${k}: ${typeof v} — ${v}`);
    }
  }

  // Heuristics for "extractable text availability" without doing real PDF parsing here
  console.log("\n--- Extractable-text heuristic ---");
  const candidateStringFields = Object.entries(data ?? {}).filter(([, v]) => typeof v === "string") as [string, string][];
  for (const [k, v] of candidateStringFields) {
    const looksBase64 = /^[A-Za-z0-9+/]+={0,2}$/.test(v.slice(0, 200)) && v.length > 200;
    const looksUrl = /^https?:\/\//.test(v);
    const looksPlainText = !looksBase64 && !looksUrl && /[a-zA-Z]{3,}/.test(v);
    console.log(`  field "${k}": looksBase64=${looksBase64} looksUrl=${looksUrl} looksPlainText=${looksPlainText} length=${v.length}`);
  }
  console.log(
    "\nNote: this script reports the response SHAPE only. Whether text is truly extractable from a PDF's" +
      " byte content (vs. scanned/image-only) requires actually parsing the bytes — not attempted here" +
      " per the 'no application workflow yet' instruction."
  );
}

main().catch((e) => console.error("FATAL:", e?.message ?? e));
