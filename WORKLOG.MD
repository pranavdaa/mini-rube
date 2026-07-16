# Work Log

_Updated: 2026-07-16, after progressive Drive resume export testing._

## Completed — Drive resume bulk export (prompt 4, full progressive ladder)

Requirement was: paginate until every file is discovered; use bounded concurrency; cache results by Drive file ID during the run; write rows incrementally; every discovered resume appears in the sheet; Unknown for missing fields; Extraction failed plus an error reason when parsing fails; no silent drops; validate discovered count against rows written.

### Infrastructure already existed
- **`src/lib/jobs/runner.ts`** — generic pagination + batching + sheet-writing + invariant enforcement (every item gets a row or an error row). Defaults to concurrency 5.
- **`src/lib/jobs/sources/drive-folder.ts`** — paginates `GOOGLESUPER_FIND_FILE` to exhaustion using Drive's own `nextPageToken`, filters out folders, returns stable item identity (id + name).
- **`src/lib/jobs/transforms/resume-candidate.ts`** — per-resume (batchSize 1): download via `GOOGLESUPER_DOWNLOAD_FILE`, parse PDF bytes with `unpdf`, extract text, one bounded model call (gpt-4o-mini, OpenRouter) to extract `{name, university, lastJob}`. Unknown for unreliable fields, failures thrown as per-item errors.
- **`src/lib/jobs/registry.ts`** — presets matching sources to transforms, invoked by a simple CLI: `bun run _job.ts drive_resumes <folderRef> [maxItems]`.

### Two gaps closed this session

1. **Per-run caching by file ID (req 3)** — the runner had no cache, so if a Drive file appeared twice in pagination (e.g. a shortcut to the same file), it would download and extract twice. Fixed in `runner.ts:114–146`:
   - Cache keyed on `source.identify(item).id` (a Drive file id, an issue number, etc.)
   - Per-batch, filter items to only the ones not yet cached; call transform only on fresh items.
   - Every discovered item still gets a row, cached or not — so a duplicate still counts toward the output, just its extraction ran once.
   - Cache is per-run, dies with the job, so re-runs always re-read the provider.

2. **Failure status wording (req 7)** — was `failed: <reason>`, now `Extraction failed: <reason>` (a more explicit label for the sheet). Updated test assertions to match.

### Verification

**Test suite:** `bun test` → 129 pass / 0 fail (one new test for the duplicate-id case).

**Live ladder:**
- **5 files** (skipped, intermediate step)
- **25 files:** 25/25 ok, 19s wall-clock, 0 failures
- **100 files:** 100/100 ok, 72s wall-clock, 0 failures — *independently verified by reading the sheet back via `GOOGLESUPER_SPREADSHEETS_VALUES_BATCH_GET_BY_DATA_FILTER`: 101 rows (100 data + 1 header), 100 distinct sources, 100 status `ok`, zero Unknown fields*
- **1,000 files (full folder):** 1,000/1,000 ok, 693s (11m 34s) wall-clock, 0 failures — *independently verified: 1,001 rows, 1,000 distinct sources, 1,000 status `ok`, zero Unknown fields, zero Extraction failed*

**Early file inspection (first 5):**
- All 5 are clean text-layer PDFs (`application/pdf`, `%PDF-` header, 1 page each, 735–1,063 chars of extractable text).
- No image-only scans; no OCR/vision path needed.
- Extraction quality: 5/5 correct (e.g., `["Matthew Robinson", "University of Texas at Austin", "Strategy Consultant at Anthropic"]`).

**Compliance:** ban grep and secret grep both pass (no banned Composio meta-tools, no exposed keys).

### Sheet URLs
- 100-file test: https://docs.google.com/spreadsheets/d/11UwG6ufe18-KaRYouNMSYQOgkilJr2w79WSdj9eyYzU/edit
- 1,000-file final: https://docs.google.com/spreadsheets/d/1bChNmE-5GjiYcRwf_hDvw1YAFc0POyHEZiH52sMR2_k/edit

## Completed — contact resolution before calendar creation (prompt 2)

Closes the gap the router worklog flagged earlier ("the 'with karan' case needs
something beyond vocabulary") and implements CLAUDE.md's full named-contact
rule set: search first, never invent, redact the address everywhere, resolve
the timezone properly, ask rather than guess a missing time.

- **`src/lib/router/scoring.ts`** — `impliesUnresolvedPerson(query, isKnownTerm)`: a person preposition ("with", "to", "invite", …) followed by a word the *catalog's own vocabulary* doesn't know (via `LexicalIndex.hasTerm`, not a fixed word list — so "subject" in "with subject X" is correctly recognized as real vocabulary, not a name). `bestFacetTool` picks the best contacts-facet tool by shape (prefers SEARCH/FIND over a plain enumerate-all).
- **`src/lib/router/router.ts`** — when a person is implied, the contacts facet is added even if nothing lexically hinted it, and if the contacts tool still isn't among the ranked candidates (its lexical score is exactly zero against "karan" — confirmed live), it's seeded in directly rather than left to the cut. `ParsedQuery.impliesPerson` surfaces the decision for logging/tests.
- **`src/lib/contactRefs.ts`** (new) — the actual fix for "never invent, use internally": a contact search's result has every email-shaped value replaced with a deterministic, syntactically-valid opaque token (`ref-<hash>@contacts.internal`) *before it ever reaches the model*, so there's no real address in context to leak — the model just carries the token into `CREATE_EVENT`'s `attendees` like it would any address. `resolveContactTokens` substitutes the real address back right before the actual Composio call. Because the token is stable and appears in plain conversation history, it survives across turns — the model can reuse it later (e.g. once the user supplies the missing time) without ever needing to see or re-search for the real address.
- **`src/lib/redact.ts`** (new) — second, mechanical layer, independent of the model following the system prompt: `experimental_transform` wraps `streamText`'s outgoing stream and scrubs any *other* email-shaped text (a stray leak, not a tracked token) from text-deltas and tool-call/result chunks, using a real token-boundary buffer rather than a fixed trailing window (see bug below). Contact tokens are explicitly exempt (masking them would corrupt round-tripping).
- **`src/lib/agent.ts`** — `DEFAULT_TIMEZONE = "America/Los_Angeles"` with `resolveTimeZone()`: a real IANA zone from the frontend wins, else this floor (the server process's own OS timezone is never treated as the user's). System prompt gained explicit rules: search contacts before using an address, never write a resolved address in the reply, ask one concise question naming exactly what's missing (date/time/duration) rather than inventing it.
- **`src/server.ts` / `src/app/App.tsx`** — the browser's own `Intl` timezone rides along on every `/api/chat` call as `body.timezone` — a stronger signal than the server's, wired through to `runTurn`.

### Two real bugs found only by live end-to-end verification (not by unit tests in isolation)

1. **The streaming email buffer released text in small increments once past a length threshold** — correct-looking in isolation, but live streaming showed it slicing a real email in half across two separate release calls ("kar" now, "an@x.com" later), each fragment too short to match the email pattern on its own, so the whole address leaked into the assistant's visible reply. Fixed by releasing only up to the last character that *cannot* be part of an email token (whitespace/punctuation), so an in-progress token is always held back whole. Regression test in `redact.test.ts` reproduces the exact character-by-character streaming shape that exposed it.
2. **Fixing bug 1 immediately exposed a second, worse one**: once the real address was properly masked in turn 1's history, a follow-up turn needing to reuse it (time supplied, no fresh contacts search routed) had nothing to work with — and the model **fabricated** a plausible-looking address rather than asking. Confirmed live via a two-turn conversation replaying the AI SDK's actual `response.messages` (not a hand-shortened history). This is what motivated `contactRefs.ts`: text redaction alone cannot satisfy "never invent" across turns, because masking after the fact destroys the only copy of the real address. A related sub-bug surfaced during the fix: the token itself is syntactically email-shaped, so the wire-redaction layer was masking *it* too, corrupting it before it could round-trip — fixed by exempting recognized tokens (`isContactToken`) from `scrubEmails`.

### Verification passed

- `bun test` — all new/updated suites green (`redact.test.ts`, `contactRefs.test.ts`, `agent.test.ts`, plus router/confirm updates for `impliesPerson`); full repo suite green alongside concurrent work in this tree.
- `bun run typecheck` — 0 new errors.
- Ban grep / secret grep clean.
- **Live, end-to-end, two-turn** (contacts search result simulated at the `composio.tools.execute` boundary — the live connected account has zero saved contacts and no `CREATE_CONTACT` tool exists in the catalog to seed one; execution path itself is real, only the contacts-API response is stubbed):
  - Turn 1 ("schedule a calendar event tomorrow with karan"): router seeds `GOOGLESUPER_SEARCH_PEOPLE` (score 0.00, lexically absent, "seeded" signal) alongside `GOOGLESUPER_CREATE_EVENT`; model searches first, never prints the real or token address, asks for the missing time.
  - Turn 2 ("3pm for 30 minutes"), replaying the real `response.messages` history: `CREATE_EVENT` executes with the **correct real resolved address** server-side; everything wire-visible (streamed tool-call args, assistant text) shows only the opaque token — confirmed by direct string comparison against the real address, not by inspection.
  - Against the real (contact-less) account: asks for the email and the time in one message, invents nothing — the honesty path, exercised for real.

### Known gap

Redaction is currently "mask every email not on the allow-list" rather than "mask only addresses that came from a contact lookup" — a real address the *user* types directly in their own message would also get masked back to them, which is unnecessary (not a privacy leak, just a UX rough edge). Not fixed: out of scope for the five required prompts, and the allow-list default is the safer direction to err in.

---

_Updated: 2026-07-16, after the generic bulk job runner (prompts 3 + 4)._

## Completed — generic server-side job runner (prompts 3 + 4)

The "sandbox" the constraints imply: Composio's own bulk answer (SEARCH_TOOLS + MULTI_EXECUTE + remote workbench) is banned three ways over, but we own the server and know the shape of bulk work up front — paginate, transform per item, write in batches. So that is implemented directly. **No queue, no database, no workers.**

- **`src/lib/jobs/types.ts`** — the engine's whole vocabulary: a `Source<T>` yields pages, a `Transform<T>` turns items into cells, a sheet takes rows. The runner knows nothing about GitHub, Drive, issues or resumes.
- **`src/lib/jobs/runner.ts`** — `runJob`: paginate to exhaustion → transform in bounded-concurrency batches → append rows incrementally → assert → compact result. Concurrency defaults to **5**; `pageSize`, `transformBatchSize`, `appendBatchSize`, `concurrency`, `maxItems` all configurable.
- **`src/lib/jobs/retry.ts`** — exponential backoff with jitter. Jitter matters *because* of the concurrency: without it a shared 429 syncs every worker onto the same retry schedule. Permanent errors (401/403/404) fail fast instead of burning retries.
- **`src/lib/jobs/sheets.ts`** — `SheetWriter` buffers and flushes in batches, clamped to **50–100** rows. Trusts the API's own `updatedRows` over our optimism.
- **`src/lib/jobs/sources/github-issues.ts`** — `state: "all"` (the provider defaults to open only) and **excludes pull requests** (GitHub models every PR as an issue; a PR is not a reported problem).
- **`src/lib/jobs/sources/drive-folder.ts`** — parses a folder id out of any Drive URL, follows `nextPageToken` to exhaustion.
- **`src/lib/jobs/transforms/issue-problem.ts`** — batched (15/call, ~44 calls not 661). Model failure degrades the "Problem reported" column to the issue title rather than turning 661 real issues into 661 failure rows.
- **`src/lib/jobs/transforms/resume-candidate.ts`** — per item (batchSize 1; parallelism comes from the runner). Download → `unpdf` text extract → one bounded model call → `{name, university, last job}`, `Unknown` for anything not stated.
- **`src/lib/jobs/registry.ts`** — named presets. "Export Linear issues to a sheet" = a Source + a Transform + one entry; the runner, router, agent and capability registry are untouched.
- **`src/lib/local/capabilities.ts`** — `EXPORT_TO_GOOGLE_SHEET` exposes it to the agent as an ordinary tool, discovered by the same router and stage-2 confirm. Also added `readonly` to `LocalCapability`: `toCompactTool` hardcoded `readonly: true`, which would have scored a *sheet-creating* capability as a read tool and demoted it on "make me a sheet".

**The load-bearing invariant**: every discovered item produces exactly one row. A failed transform yields a failure row *naming the item*, not a gap. A whole-batch throw becomes per-item failure rows. A transform returning the wrong arity is caught rather than silently misaligning rows against items. The runner **throws instead of reporting success** if `succeeded + failed ≠ discovered` or `rows ≠ discovered + 1`.

**Context**: issue bodies and resume text are read, used and dropped inside the transforms. They never return upward. The agent receives `{processed, succeeded, failed, rowsWritten, outputUrl, note}` — asserted by test.

### Findings (verified live, not assumed)

1. **`ASSIGNMENT_PLAN.md`'s sheet-write tool is wrong.** It names `GOOGLESUPER_CREATE_SPREADSHEET_ROW`; that is the *insertDimension* API (`insert_index`, `inherit_from_before`) — it inserts **blank** rows and cannot carry values. The real tool is `GOOGLESUPER_SPREADSHEETS_VALUES_APPEND` (Sheets `values.append`), verified writing 5 rows in one call.
2. **The resumes have a text layer.** FlateDecode PDFs, ~850 chars extracted cleanly. This was §7's largest stated risk ("if image-only, need OCR / a vision model") — it is **not a risk**. Using `unpdf` (added dep) rather than the system `pdftotext`, so setup still reproduces from `bun install`.
3. **`GOOGLESUPER_DOWNLOAD_FILE` writes to a local path** and returns a URI rather than inline bytes. The path is an implementation detail — never logged, never shown.
4. **The issues endpoint is mostly pull requests**: 800 items fetched → **661 were PRs**, 139 real issues. Without the exclusion the sheet would have been ~83% wrong on those pages.

### Verification passed

- `bun test` — **128 pass / 0 fail** (23 new: count invariant, failure rows, batch-throw → per-item failures, arity mismatch, concurrency bounds/default-5, retry classification, progress, ref parsing, PR exclusion, transform parsing). Hermetic: `executeTool` is stubbed, no network, no real sheet.
- `bun run typecheck` — **0 errors in my code**; 1 pre-existing scaffold error (`src/connect.ts:10`).
- **GitHub, full run — all 661 issues** (open + closed) in 114s, 662 rows, **0 failures, 0 retries**. Verified by reading the sheet back: **661 links, all `/issues/`, zero `/pull/`.** Content is real (`#3860 [Bug]: GOOGLEDRIVE_CREATE_FOLDER…`) with genuine one-line problem summaries, both states present. (The assignment says ~550 "at the time of writing"; the repo now has 661.)
- **Drive discovery — exactly 1,000 files across 10 pages**, pagination to exhaustion confirmed against the real folder.
- **Drive ladder 5 → 100 → all**: 5/5 in 9.5s; 100/100 in 73s; **all 1,000/1,000 in 11m28s, 0 failures, 0 retries** — no rate limiting at concurrency 5. Sheet read back independently rather than trusting the runner's own counters: **1,001 rows, 1,000 `ok`, 0 `failed`, 1,000 distinct source files** (nothing processed twice, nothing missed) and **zero `Unknown`** across name/university/last job — every resume produced a complete row. Clean cross-check: `resume_1000_Steven_Moore.pdf` → "Steven Moore", Northwestern University, Portfolio Manager at Morgan St…
  → **The assignment's headline bulk requirement ("the 1k resumes should all be in the sheet") is met and verified.**
- Rows land in completion order, not source order — a consequence of bounded concurrency. The invariant is one row per item, not ordering.

### Known gaps

- The agent-facing path (`EXPORT_TO_GOOGLE_SHEET` chosen by the router and invoked by the model end-to-end) is **not yet verified** — the runner has only been driven directly. Next task.
- **11m28s for 1,000 resumes** is correct but slow, and it runs synchronously inside one agent turn. Nothing streams progress to the UI yet, so a user watching the browser sees a long silence. The progress callback already emits the data (`onProgress`); it just has no transport. Worth wiring before the UX pass.
- Drive's source reports no `stats`/`breakdown` (both `{}`) — those counters are currently only populated by the GitHub source, where the PR exclusion makes them load-bearing.
- `MAX_PAGES` guards (200 github / 500 drive) would silently stop a genuinely larger source; they log nothing on hit.

## Completed — PDF email attachments (prompt 5)

Prompt 5 ("send an email with the attached pdf") needed a real upload path into `GOOGLESUPER_SEND_EMAIL`'s `attachment` field, which requires Composio's own `{name, mimetype, s3key}` `FileUploadable` shape (verified against the live schema) — not raw bytes, and not something a model can produce (it has no S3 key to invent).

- **`src/lib/attachment-limits.ts`** — the only PDF-attachment constants (`MAX_ATTACHMENT_BYTES` = 10MB, content type `application/pdf`), plain enough to import from both the Bun server and the Vite-bundled frontend unchanged.
- **`src/lib/attachments.ts`** — server-side only. Decodes the client's base64 data URL, validates type/size **server-side** (never trusts the client's own claims), builds an in-memory `File` (Bun's global Web File API — bytes never touch a filesystem path, so there is no local path to ever leak), and calls `composio.files.upload({file, toolSlug, toolkitSlug})` — the SDK's own uploader — to get the exact `{name, mimetype, s3key}` shape back.
- **`src/lib/router/attachmentField.ts`** — `findFileUploadableField(inputParameters)` scans *any* tool's schema (including the `anyOf` single-file/array-of-files branches Composio uses) for its `file_uploadable: true` flag. Generic by construction: nothing here names `GOOGLESUPER_SEND_EMAIL` or `attachment` — a future toolkit's own upload field is detected the same way, no code change.
- **`src/lib/agent.ts`**:
  - `prepareAttachments` runs once per turn, before the model is called: for each selected tool whose schema has a file-uploadable field, uploads every attached file and records `{field, files}`. A bad upload (wrong type, too large) throws and fails the turn loudly — never a silent send-without-attachment.
  - `makeAITools`'s `execute` now overrides `finalArgs[field]` with the real uploaded file object immediately before calling `executeTool`, regardless of what the model did or didn't pass for that field. The model is never trusted to shape the upload.
  - **`stripAttachments` — the fix that mattered most**: AI SDK v4 detects `experimental_attachments` on a message (`detectSingleMessageCharacteristics` in `ai/dist/index.js`) and auto-converts it into a `file`/`image` content part inlined into the model's prompt. Left alone, the *raw base64 PDF bytes* would have ridden straight into kimi-k2's context — exactly the "bulk data must never enter context" failure CLAUDE.md bans, and likely a hard error besides (kimi-k2 has no file-input support). `runTurn` now strips `experimental_attachments` from every message before calling `streamText`, after already using it (server-side, via `extractAttachmentPayloads`) to get the bytes for upload. The model only learns a file exists via one `buildSystemPrompt` line ("already uploaded, don't fill in the field yourself") — never the bytes.
- **`src/app/App.tsx`** — file input (`accept="application/pdf"`), client-side type/size pre-check (same constants as the server, so the UI's limit can never quietly drift from what the server enforces), a filename+size chip with a remove control, and an attachment chip rendered on the message itself in the chat log. The file input's own `FileList` is passed straight to `useChat`'s `experimental_attachments` on submit — no manual base64 encoding in the frontend.

### Verification passed

- `bun test` — **126 pass / 0 fail** (11 new: data-URL/size/type validation in `attachments.ts`, generic field detection in `attachmentField.ts` against a fixture mirroring the live schema).
- `bun run typecheck` — 0 errors in touched files; the one pre-existing `connect.ts` error is untouched.
- Ban grep and secret grep both clean on touched files.
- **Live end-to-end**: sent a small real PDF (`mini-rube-test.pdf`, 4 lines of raw PDF, 408 bytes) to the user's own address via `runTurn` directly (bypassing the browser to isolate the pipeline). Stage 2 non-deterministically chose either `GOOGLESUPER_SEND_EMAIL` directly or `CREATE_EMAIL_DRAFT` → `SEND_DRAFT` across runs — **both chains attached the file correctly**, confirming the injection is keyed off the schema's file-uploadable field, not one hardcoded tool. `executeTool` returned `successful:true` with a real Gmail message id and `display_url`; the model's final reply quoted that id back rather than assuming success. **Independently re-fetched the sent message via `GOOGLESUPER_FETCH_MESSAGE_BY_MESSAGE_ID`** and found a real attachment part: `filename: "mini-rube-test.pdf"`, `mimeType: "application/pdf"`, `size: 408`, a real Gmail `attachmentId` — proof the PDF is genuinely attached to the delivered message, not just accepted by the API without effect.

## Completed — important-email triage (prompt 1)

Prompt 1 ("read my last 100 emails and show me the important ones") previously routed to raw `GOOGLESUPER_FETCH_EMAILS`, which returns everything it fetches — no deterministic ranking, no bounded triage, no digest. Built the workflow CLAUDE.md specifies: paginate → compact metadata only → deterministic signals → one bounded model call → digest.

- **`src/lib/email/triage.ts`** — `triageImportantEmails(userId, {maxResults})`:
  - `fetchCompactEmails` pages `GOOGLESUPER_FETCH_EMAILS` with `verbose:false, include_payload:false` (the tool's own "metadata only" mode — subject/sender/timestamp/labels, no MIME payload, no body) and loops on `nextPageToken` until `maxResults` is reached or the provider says there's no next page. Never trusts `resultSizeEstimate` (documented as approximate).
  - Each message reduces to `{id, sender, subject, timestamp, snippet≤160 chars, labels}` — never a full body.
  - `scoreEmail` — deterministic, no model: `IMPORTANT`/`STARRED`/`UNREAD` labels, urgency vocabulary in subject/snippet, automated/bulk sender markers (no-reply, newsletter, marketing…), demoted `CATEGORY_PROMOTIONS`/`SOCIAL`/`FORUMS`/`SPAM`/`TRASH`. Runs over every fetched message.
  - Top 25 by deterministic score go to **one** bounded model call (`classifyImportant`, `gpt-4o-mini` by default, `EMAIL_TRIAGE_MODEL` to override) — regardless of whether 100 or 500 messages were fetched, the model only ever sees ≤25 compact records and returns `{important:[{id,reason}]}`. Empty list is treated as a valid answer, not a failure.
  - Every failure path (no API key, request error/timeout, unparseable reply, non-candidate id) falls back to a deterministic top-N by score — mirrors the safety-by-construction pattern already used in `confirm.ts`.
  - Returns `{reviewed, important:[{sender,subject,timestamp,reason}], note}` — sender/subject/timestamp/reason only, no ids, no labels, no snippets, in the digest that actually reaches the agent.

- **`src/lib/local/capabilities.ts`** — new concept: a **local capability** registry for server-side workflows that are more than one Composio call but still need to appear in the agent's tool set exactly like a real tool. `TRIAGE_IMPORTANT_EMAILS` is the first entry: slug, description, tags, and its own JSON Schema + `run(args, userId)` handler. Adding the next one (e.g. a GitHub-issue triage capability) is one more registry entry, not a special case anywhere else.
- **`src/lib/router/types.ts`** — added `LOCAL_TOOLKIT = "local"`.
- **`src/lib/router/catalog.ts`** — `fetchCatalog` appends local capabilities (as compact tools) after the real Composio fetch, so they're indexed, lexically scored, and stage-2-confirmed by the exact same pipeline as the 1,360 live tools — no bypass, no hardcoded routing.
- **`src/lib/router/scoring.ts`** — toolkit-affinity scoring now exempts `toolkit:"local"` from the miss penalty: a triage capability over Gmail data isn't itself "googlesuper" vocabulary, so penalizing it for "missing" a toolkit hint would be wrong by construction, not a real signal.
- **`src/lib/router/schemas.ts`** — `loadToolSchemas` synthesizes a `FullTool` for local slugs directly from the registry's own JSON Schema, skipping the Composio fetch entirely for them.
- **`src/lib/agent.ts`** — `makeAITools`'s `execute` special-cases local slugs to call `capability.run(args, userId)` instead of `executeTool` (Composio). Added one generic system-prompt rule: prefer a tool whose description says it triages/digests/summarizes a large read over manually paginating the raw list/fetch tool for the same data. This is phrased generically (not "email" specifically) so it also applies to any future triage-style local capability.
- **`src/lib/router/confirm.ts`** — same generic preference added to the stage-2 system prompt, so the bounded LLM confirm also knows to prefer a triage capability over a raw list/fetch tool when both are candidates.

### Verification passed

- `bun test` — **65 pass / 0 fail** (11 new: deterministic scoring signals + classify-response parsing/fallback, hermetic, no network).
- `bun run typecheck` — 0 errors in touched/new files (confirmed by grepping typecheck output for touched filenames); pre-existing scaffold errors unchanged.
- Ban grep and secret grep both clean.
- **Router surfaces the new capability without being told to**: for "read my last 100 emails and show me the important ones", `TRIAGE_IMPORTANT_EMAILS` ranks **#2** in stage 1 (score 61.97 vs `FETCH_EMAILS`'s 85.97) — inside both the top-15 stage-1 pool and the top-8 sent to stage 2. Same top-2 placement for "what are the important emails in my inbox". For a plain "show my 5 most recent emails" it still surfaces (#2) but `FETCH_EMAILS` remains the obviously correct single answer — stage 2 makes that call, not stage 1.
- **Live end-to-end, exactly 100 messages**: `triageImportantEmails("candidate", {maxResults:100})` against the real connected account — `reviewed: 100` (exact), digest **1,533 chars total**, 6 messages flagged important, each with a concrete, non-generic reason (e.g. "Sublease unavailable, needs a response", "Time-sensitive DMV test assistance"). Newsletters/security-alert/no-reply mail from the same inbox (verified present in an earlier raw-fetch probe) did not appear — the bulk-sender and category demotions worked as intended. Took ~10.7s (100-message page fetch + one classify call).

### Known limitation

`CANDIDATE_POOL` is fixed at 25 — if more than 25 messages score positively, the ones ranked 26th+ deterministically never reach the model, however important they might be. Acceptable for a 100-message page (rarely does inbox triage surface >25 plausible candidates), but if this pattern is reused for `maxResults` in the hundreds, worth revisiting (e.g. raising the pool or chunking into 2 bounded calls instead of 1).

## Completed — step 4: stage 2 (bounded semantic confirm)

- **`src/lib/router/confirm.ts`** — optional confirm stage between lexical retrieval and schema loading. ≤15 candidates in (slug, toolkit, one-sentence description + attachment types), ≤8 slugs out with one short reason each. Own prompt, own `{selected:[{slug,reason}]}` shape — shares no field names or response contract with any COMPOSIO_* meta-tool (verified: the only contract fields are `selected`/`slug`/`reason`).
- Model: `openai/gpt-4o-mini` (~0.9s), overridable via `ROUTER_CONFIRM_MODEL`. Probed the provisioned OpenRouter key first — it reaches kimi-k2, gpt-4o-mini and llama-3.3-70b; gemini-flash and claude-haiku return "No endpoints found".
- Disable with `ROUTER_CONFIRM=0`, or per call via `selectTools(req, {confirm:false})`.
- **Safety by construction**: hallucinated slugs are dropped (candidates-only), duplicates deduped, output capped at 8, 20s timeout, and *every* failure path (parse, error, no key) falls back to stage 1's deterministic top-N. A bad confirm can only be as good as no confirm, never worse.
- **Cache** keyed by normalized request + `catalogVersion` (FNV-1a fingerprint of every `slug@version`), so a cached decision dies the moment Composio ships a tool change.
- **Skip rule** (`isDecisive`) is deliberately asymmetric: an unnecessary confirm costs ~1s, but a wrong skip drops a prerequisite and breaks the chain. So it skips only single-step-looking requests — one facet, not mixed read+write — whose top candidate wins by ≥2×. "schedule a meeting with a saved contact" hints calendar+contacts and is never skipped even though GET_CONTACTS leads by 2×.

### Measured effect on the four verified prompts — no regressions, tighter sets

| Prompt | Stage 2 | Tools sent to model |
|---|---|---|
| "Show my five most recent emails." | `lexical-decisive` (skipped) | 8 (unchanged) |
| "What events do I have tomorrow?" | `model` | **8 → 1** (`EVENTS_LIST_ALL_CALENDARS`; dropped the Analytics near-ties) |
| "Show open issues from composiohq/composio." | `model` | **8 → 1** (`GITHUB_LIST_REPOSITORY_ISSUES`) |
| "Send an email to me with subject Router Test." | `model` | **8 → 1** (`SEND_EMAIL`, correctly not draft+send) |

Re-ran two end-to-end: both still execute and answer correctly on the narrowed sets.

### 🔴 What stage 2 exposed: stage 1 recall fails on two real assignment prompts

Stage 2 can only choose from the candidates (rule 5), so a prerequisite missing from the top 15 is **unrecoverable**. Measured against the *actual* assignment wording:

- **"schedule a calendar event tomorrow with karan"** → all 15 candidates are calendar tools. **No contacts tool at any rank.** Stage 2 returned `CREATE_EVENT` alone — correct given its options, and still a broken chain. The prompt hints only `facets=[calendar]`: "karan" is an unknown proper noun and "with" is a stopword, so *nothing lexical points at contacts*. This is the hidden-prerequisite case at its hardest — hidden precisely because the vocabulary is absent. (Note "schedule a meeting with a saved **contact**" works only because the word "contact" appears.)
- **"take all the resumes in this drive folder and make a google sheet…"** → candidates are all write tools (`CREATE_GOOGLE_SHEET1`, `CREATE_FOLDER`, `MOVE_FILE`, `DELETE…`). **No `FIND_FILE`, `FIND_FOLDER` or `DOWNLOAD_FILE`.** Stage 2 picked `UPLOAD_FILE` — the exact opposite of what's needed. Cause: the real prompt has no read verb ("take"/"make" are both writes), so `aspect=write` demotes the read tools, and 15 slots are then monopolized by one facet. ("read resumes from a Drive folder" works — it has "read".)

Both are stage-1 recall problems, not stage-2 defects, and neither is fixable inside stage 2 without breaking rule 5. **This is the next task** (see below).

## Completed — step 3: agent integration

- **`src/lib/agent.ts`** — one turn: extract latest user text + attachment metadata → route → bound to 8 → load schemas for only those → AI SDK `tools{}` → execute via the scaffold's `executeTool`. Kept out of `server.ts` so a turn can run without binding a port.
- **`src/lib/router/select.ts`** — `extractRequest`, `buildRoutingQuery` (folds attachment *type* into the query, never bytes), `selectTools`. Asserts ≤10 schemas per turn.
- **`src/lib/router/schemas.ts`** — lazy full-schema load for selected slugs only, one batched call, process-lifetime cache.
- **`src/lib/identity.ts`** — resolves the connected user's own address via `GOOGLESUPER_GET_PROFILE`. Needed because "send an email to me" cannot be answered by guessing, and inventing a recipient is banned. Best-effort: on failure the model is told nothing and asks.
- **`src/lib/compact.ts`** — context guard on tool results (see below). Unit-tested in `compact.test.ts`.
- **`server.ts`** — `/api/chat` is now router-driven per turn; the hardcoded `GOOGLESUPER_SEND_EMAIL` is gone. `/api/tools` repointed at the router's complete catalog (was `listToolSlugs({limit:500})`, which truncated 1,360 → 500 alphabetically and dropped `GITHUB_LIST_REPOSITORY_ISSUES`). Verified live: `/api/tools` now returns 1,360 with the canary present.
- Logs per turn: all 15 candidates with scores (`*` marks the 8 sent to the model), per-tool `signals[]`, tool version, and execution status with timing + compaction stats.

### The finding that mattered most: tool results, not schemas, are what blow the context

`GOOGLESUPER_FETCH_EMAILS({max_results: 5})` returns **518,591 chars (~130k tokens) for five emails** — each message carries a full MIME `payload` (~16KB) plus `messageText`. That alone exceeds kimi-k2's window, and it is why the first end-to-end run hung with no error.

The router solves the *input* side (8 schemas ≈ 2.5k tokens, measured). It does nothing for the *output* side. `compact.ts` closes that: it finds the record list, prunes oversized **fields** within each record, and keeps every record. Measured on the live payload: **518,591 → 3,448 chars (~130k → ~862 tokens, 150×)**, all 5 messages retained, dropping exactly `messageText` + `payload` and keeping sender/subject/timestamp/preview/labels — which is precisely the compact set CLAUDE.md specifies, reached generically by field size rather than field names. If pruning is not enough it caps items and *reports the count*; nothing is silently dropped.

### Bugs found and fixed in this step

- **`queryAspect` was blind to questions.** "What events do I have tomorrow?" has no action verb ("what" is a stopword, "have" is untracked), so it scored intentless and ranked the write tool `SEND_EVENTS` alongside `EVENTS_GET`. Questions now read as read-intent, checked *after* verbs so "Can you send an email?" stays write.
- **Google Analytics tools were riding the calendar boost.** Inside googlesuper, Calendar and Analytics both own the word "events" (`EVENTS_GET` vs `LIST_CONVERSION_EVENTS`), and the provider's tags collide outright — `"Events Management"` is Calendar, `"Event Management"` is Analytics. All six tied at exactly 50.8 and all were `important=true`, so neither tags nor the important prior could separate them. Fixed by keying the calendar facet on distinctive vocabulary (`calendar`, `recurring`, `timemin`) and matching facets against the description too. Analytics fell to #6/#7; real calendar tools took #1–#4.
- My first `compact.ts` was **broken**: it dropped the whole `data` container (518KB > field budget) leaving 59 chars and zero messages. Size-based field-dropping cannot tell a record *container* from a *blob*; rewritten to find the record array and prune within records.

## Completed — steps 1–2

- **Migration map** from `pre-work/mini-rube` → scaffold: reuse catalog fetch, normalization, lexical IDF, synonym cap, affinity, intent, explanations, eval metrics. Dropped the MCP server (`search_tools`/`execute_tool`/`list_connected`), old web server, old CLI, old auth, old frontend, seed/OpenAPI catalogs, `llm.ts`, `connections.ts` (real `connectedAccounts` replaces it).
- **`src/lib/router/`** — stage 1 of the router, no model, no network at query time:
  - `catalog.ts` — complete live fetch per toolkit + in-memory cache (promise-cached so concurrent callers share one fetch). Toolkits from `COMPOSIO_TOOLKITS` env, defaulting to `googlesuper,github`.
  - `normalize.ts` — raw live tool → `CompactTool`.
  - `aliases.ts` — stopwords, synonyms, verb sets, facets. Re-authored for googlesuper/github.
  - `lexical.ts` — field-weighted IDF, capped synonym expansion, intent bonus.
  - `scoring.ts` — toolkit affinity, facet affinity, important prior, read/write aspect, deprecated demotion.
  - `router.ts` — `Router.search()` → top 15 compact candidates + `signals[]`; `getRouter()` over the live catalog.
  - `types.ts` — `CompactTool`, `RouterCandidate`, `ParsedQuery`, `RouteResult`.
- Added `test` + `typecheck` scripts and a `tsconfig.json` (the scaffold had neither).

### Findings that changed the design (verified against the live API, not assumed)

1. **SDK `0.2.6` fetches complete catalogs.** `limit: 2000` returns googlesuper 467 + github 893 = **1,360**, canaries present. The `ASSIGNMENT_PLAN.md` risk "0.2.6 may lack APIs we need" is resolved — no bump needed. `limit: 100` truncates alphabetically exactly as documented (github A–C, `GITHUB_LIST_REPOSITORY_ISSUES` absent).
2. **There is no cursor on `getRawComposioTools`.** Completeness rests entirely on over-requesting `limit`, so `catalog.ts` treats "response exactly fills the limit" as a hard error rather than indexing a catalog with silent holes.
3. **`GOOGLESUPER_LIST_FILES` and `GOOGLESUPER_GET_FILE_V2` are deprecated.** `ASSIGNMENT_PLAN.md` §3.3 names both as the prompt-4 chain. The live catalog says use `FIND_FILE`. The plan's stated chain is wrong; the live chain is `FIND_FOLDER` → `FIND_FILE` → `DOWNLOAD_FILE` (all live, all `important`). **Update the plan before building prompt 4.**
4. **Provider hint tags must not be indexed as text.** `important` sits on 359/1,360 tools; indexing it lets a synonym expansion (urgent→important) boost a quarter of the catalog at tag weight. `normalize.ts` lifts hint tags into typed flags and keeps them out of the index.
5. **The pre-work's aspect rule was wrong for this assignment.** Write intent dominating mixed queries demotes exactly the read prerequisites the chains need. Aspect is now `mixed` (no pressure) when both intents appear, and the mismatch penalty is **asymmetric**: read-query→write-tool `×0.4` (wrong and unsafe), write-query→read-tool `×0.85` (usually a prerequisite).

### Bugs found and fixed while measuring (all were silent)

- `BATCH_MODIFY_MESSAGES` ranked **#1** for "find urgent messages in my inbox" (CLAUDE.md names this exact failure). The user's word "messages" hits its *slug* at weight 3 while FETCH_EMAILS earns it only from its description at weight 1 — `×0.8` could not overturn that. Asymmetric aspect fixed it: now #5, with every read tool above it.
- `CREATE_GOOGLE_SHEET1` ranked **#87**: `tokenize` did not split letter/digit boundaries, so `sheet1` was unreachable from "sheet". Now #24 / #3.
- **`make` was a stopword** (inherited from pre-work), so "read all the issues …and **make** a google sheet" — the assignment's own phrasing — parsed as pure read intent and buried the sheet-writing tools at #132/#213. Now `mixed`, `CREATE_GOOGLE_SHEET1` #3.
- Synonyms were looked up only on the raw term, never the stem, so `SYNONYMS["message"]` was unreachable from a query saying "messages".

## Verification Passed

- `bun test` — **38 pass / 0 fail**. Hermetic fixture tests (normalization, aspect, IDF cap, deprecation, explanations, compactness, result compaction) + all 7 router queries against the **live** catalog.
- `bun run typecheck` — **0 errors in my modules**. 6 pre-existing scaffold errors remain (see Known Problems); none introduced.
- Ban grep clean. Secret grep clean (incl. full git history). `.env` untracked.
- Router never sees a full schema: `RouterCandidate` carries `inputFields` (names only); asserted by test.
- `/api/tools` live: **1,360 tools**, `{googlesuper: 467, github: 893}`, canary present.

### The four target prompts, run end-to-end against live accounts

| Prompt | Routed #1 | Executed | Result |
|---|---|---|---|
| "Show my five most recent emails." | `GOOGLESUPER_FETCH_EMAILS` (86.7) | ok, 1.1s | ✅ 5 emails, sender/subject/time/snippet |
| "What events do I have tomorrow?" | `EVENTS_LIST_ALL_CALENDARS` (#2, called) | ok, 1.3s | ✅ resolved "tomorrow"→2026-07-17, reported empty calendar |
| "Show open issues from composiohq/composio." | `GITHUB_LIST_REPOSITORY_ISSUES` (56.7) | **failed 400** | ❌ **GitHub not connected** — routing correct, auth missing |
| "Send an email to me with subject Router Test." | `GOOGLESUPER_SEND_EMAIL` (96.2) | ok, 1.1s | ✅ really sent, message id returned, own address resolved (not fabricated) |

**3/4 pass. #3 is blocked on OAuth, not code**: `connectedAccounts.list({userIds:["candidate"]})` returns only `googlesuper` (one ACTIVE, one EXPIRED) — there is no github account, so Composio 400s. The router ranked the correct tool #1; on failure the model reported the error and asked rather than inventing issues, which is the honesty rule behaving correctly. Needs a human to complete GitHub OAuth in a browser.

## Current Architecture

```
request → extract latest user text + attachment metadata (never bytes)
        → compact catalog index (1,360 tools, metadata only, cached)
        → lexical IDF (slug×3, tag×2, desc×1, field×0.5; expansions capped at IDF 2.2)
        → boosts: toolkit affinity → facet affinity → important → aspect → deprecated
        → top 15 candidates + signals[]
        → stage 2: bounded confirm (gpt-4o-mini, ≤15 in / ≤8 out, cached by
          catalog version, skipped when decisive, falls back to stage 1)
        → bounded selection (8, hard cap 10)
        → lazy full-schema load (selected only, ~2.5k tokens measured)
        → streamText (kimi-k2) → executeTool → compactToolResult → model   ← WE ARE HERE
        → [bulk job runner]                     ← not built
```

Two independent context defences, because they fail differently:
- **Input**: the router decides what the model may *see* — 8 schemas, never 1,360.
- **Output**: `compact.ts` decides what a tool may *return* — no single result can blow the window (5 emails would have been ~130k tokens).

`googlesuper` merges gmail/calendar/drive/sheets under one toolkit slug, so toolkit affinity alone cannot separate "check my inbox" from "make a spreadsheet". **Facets** (`aliases.ts`) restore that: query hints → sub-app, matched against tool slug/tag markers. A new toolkit works with zero facets (toolkit-level affinity only) and improves by adding entries.

## Known Problems

- **🚨 Bun 1.1.8 cannot stream: `TextEncoderStream` and `TextDecoderStream` are both `undefined`** (Node 22 has both; modern Bun does too). AI SDK v4 needs `TextDecoderStream` to parse the model's SSE response — so `streamText` **hangs silently, with no error** — and `TextEncoderStream` for `toDataStreamResponse()`, which throws `Can't find variable: TextEncoderStream` on every `/api/chat` call. This is **pre-existing and environmental**: the scaffold's original chat handler called the same method, so chat has never worked on this machine (consistent with step 0 never having been run). It is why the four prompts were verified through `runTurn` with a process-local polyfill rather than through the browser. **`bun upgrade` is the fix — decide before the UX task**, since nothing in the browser can work until then. `generateText` is unaffected.
- **GitHub is not connected** for user `candidate`, so every github tool 400s. Complete OAuth via the "Connect GitHub" button (or link `https://connect.composio.dev/link/lk_cYlWn0a2LcOJ`, generated 2026-07-16 — may expire). Prompt 3 and the whole GitHub bulk export are blocked until then.
- **Two googlesuper connected accounts exist** (one ACTIVE, one EXPIRED). Execution currently resolves fine, but Composio raises `ComposioMultipleConnectedAccountsError` in some paths — worth pruning the stale one.
- **`src/lib/auth.ts:36` passes `{ userId }` to `connectedAccounts.list()`, but the SDK expects `userIds`.** The filter is silently ignored, so `getConnectedAccounts()` returns accounts for *every* user, not the caller's. Latent scaffold bug, surfaced by the new tsconfig. Not fixed — out of scope for this task, but it sits directly on CLAUDE.md's "user-id consistency" debug step and will bite at auth time.
- 5 more pre-existing scaffold type errors (`connect.ts:10` `.url` on `ConnectionRequest`; `server.ts` 38/67/68/78/84 arg types). Not touched — no unrelated refactors.
- **Cross-toolkit crowding:** "export issues to a spreadsheet" fills the shortlist with ~10 near-duplicate github issue tools, leaving googlesuper only 2 of 15 slots (`CREATE_SPREADSHEET_ROW` scrapes in at #14, `CREATE_GOOGLE_SHEET1` misses at #24). Since stage 2 may only select *from* candidates, a stage-1 miss is unrecoverable. Candidate fix: per-toolkit representation quota when a query hints 2+ toolkits. Not built — not in this task's scope.
- `CREATE_SPREADSHEET_ROW` sits at #60 for prompt 3's full phrasing. Defensible (the query never says "row"), and the bulk job runner writes rows server-side rather than via the agent's tool list — but worth re-checking once stage 2 exists.
- Live-catalog tests need `COMPOSIO_API_KEY` and ~1.4s of network. Deliberate: a fixture would only prove the scorer scores the fixture.
- **An unrequested commit `c1611e6` exists** that I did not author. It contains a mid-progress router snapshot and `_probe.ts` (a throwaway probe script, since deleted in the working tree). No secrets in it. History left alone per CLAUDE.md.

## Next Exact Task

**Unblock the environment, in this order — neither needs code:**
1. `bun upgrade` (Bun 1.1.8 → current), then re-run the four prompts through the browser at :5173. Until this is done nothing streams in the UI.
2. Connect GitHub via the UI, then re-run prompt 3. Routing is already correct; only auth is missing.

**Then: fix stage-1 recall for prerequisites.** Stage 2 is built and works, but it is capped by what stage 1 surfaces, and stage 1 currently misses the prerequisites for assignment prompts 2 and 4 (evidence above). Neither is fixable inside stage 2. Two candidate fixes, both stage 1:

1. **Facet representation quota** — when a query hints 2+ facets/toolkits, reserve slots per facet instead of letting the lexically-richest one take all 15. Fixes the resumes case (drive tools currently crowded out by sheets/write tools) and the previously-logged cross-toolkit crowding.
2. **Surface read prerequisites for write requests** — a write request over a facet very often needs that facet's read tool first (list before download, search before invite). Either soften the read demotion when the request implies enumeration ("all the X in Y"), or seed the pool with the top read tool per hinted facet.
3. The **"with karan"** case needs something beyond vocabulary — an unknown proper noun in a "with/to <name>" position implies a person, hence contacts. Worth a small, explicit rule; it is the assignment's own prompt 2 and cannot work without it.

Re-measure both prompts after each change; the 13-query regression check plus `bun test` should stay green.

Before prompt 4 (resumes): correct `ASSIGNMENT_PLAN.md` §3.3 to the live Drive chain (`FIND_FOLDER` → `FIND_FILE` → `DOWNLOAD_FILE`) — `LIST_FILES`/`GET_FILE_V2` are deprecated.

Also: `/api/tool` and `/api/tool/set` (the scaffold's manual tool picker) are now vestigial — chat ignores them. They stay so the current frontend keeps rendering; the UX task should replace the picker with router step-rows showing `signals[]`.
