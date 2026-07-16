# CLAUDE.md — mini-rube

Build a general local web agent on Composio that **dynamically discovers, selects, and executes** tools from `googlesuper` + `github`. Five required prompts and their variations must work.

The goal is a reusable routing + execution architecture where a new toolkit is a config line — not five special-cased prompts.

**Read in order, once:** `readme.md` (authoritative on requirements) → `ASSIGNMENT_PLAN.md` (architecture) → `WORKLOG.md` (current state) → `TASK_CHECKLIST.md` (what's left) → only files relevant to the current task. This file governs implementation rules. Don't re-read the repo wholesale.

---

## Hard bans

Never use, import, copy, or reimplement under another name:

- `composio.create` · Composio Tool Router · any `COMPOSIO_*` meta-tool
- `COMPOSIO_SEARCH_TOOLS` / `MULTI_EXECUTE_TOOL` / `REMOTE_WORKBENCH` / `REMOTE_BASH_TOOL`
- Composio sandbox sessions (all sandbox paths require `composio.create` — verified)
- The production meta-tool system prompt or response contract
- `pre-work/mini-rube/reference/composio-meta-tools.json`

The router must be independent code over the **public live catalog** (`getRawComposioTools`) + direct execution. `COMPOSIO_API_KEY` / `*_AUTH_CONFIG_ID` env vars are required and fine — the ban is on the meta-tool *system*, not the string.

## Pre-work reuse

At `/Users/mac/Downloads/interview/composio/pre-work/mini-rube`.

**Adapt:** catalog fetching + truncation fix, metadata normalization, lexical retrieval (field-weighted IDF, capped synonym expansion, toolkit affinity, read/write intent, important prior, score explanations), recall@k/MRR eval utils, pagination/retry/concurrency helpers, step-row UI concepts.

**Never port:** the MCP server and its `search_tools`/`execute_tool`/`list_connected` interfaces (they mirror banned meta-tools), the old CLI, web server, auth implementation, frontend, seed/OpenAPI catalogs.

## Preserve the scaffold

The official scaffold is the app shell: Bun server (:3001), Vite+React (:5173), `useChat`, AI SDK `streamText`, Composio client, `AUTH_CONFIGS`, `connectedAccounts.link()` flow, `executeTool`. Extend it; don't replace it with the pre-work app. Don't rewrite working scaffold code unless a requirement demands it.

---

## Verified facts (don't re-derive)

- **1,360 tools live**: `googlesuper` 467, `github` 893. ~800k tokens of schema vs a 500k ceiling → the catalog *cannot* fit. This is why the router exists.
- **`limit` truncates alphabetically.** `getRawComposioTools({toolkits:['github'], limit:100})` returns A–C; `GITHUB_LIST_REPOSITORY_ISSUES` silently vanishes. The scaffold's own `listToolSlugs({limit:500})` is already broken for 1,360 tools. Fetch complete catalogs; verify counts.
- Scaffold hardcodes `USER_ID = "candidate"`. Auth, status, and execution must all use the **same** user id.
- `scaffold.sh` provisions a free **OpenRouter** key; model is `moonshotai/kimi-k2`.
- `executeTool` uses `dangerouslySkipVersionCheck: true` — manual execution otherwise needs the tool's toolkit version.
- Only `dev` and `server` scripts exist in `package.json`. There is no `test`/`typecheck`/`build` script — add them if you want them.

---

## Architecture

```
request → compact catalog index → lexical retrieval → [bounded LLM confirm]
        → ~6-10 tools → lazy full-schema load → AI SDK agent loop → Composio execution

bulk:   agent picks high-level bulk capability → server job runner
        → paginate to completion → bounded batches → incremental sheet writes
        → stream progress → return {processed, succeeded, failed, outputUrl}
```

**Router.** Stage 1 is deterministic lexical scoring over compact metadata (slug, name, description, tags, input-field names, toolkit affinity, read/write intent, important flag; connected status only as a weak tie-break). Synonym expansions must never outweigh the user's own words. Return slug, toolkit, version, score, and explanations. Stage 2 (optional) sends ≤15 compact candidates + the request to a cheap model, returns ≤8 tools with one reason each, selects only from candidates, includes hidden prerequisites, falls back safely on parse failure.

**Hidden prerequisites** the router must cover: contact search → calendar create · sheet create → row insert · drive list → file download · issue list → issue analysis.

**Schemas.** Search compact metadata; load full schemas *only* for selected tools; the model should see ~6–10 schemas per request, never the catalog.

**Never put in the main conversation:** 100 email bodies · 550 issues · 1,000 resume texts · full catalogs · hundreds of schemas · raw batch intermediates.

---

## Prompt-specific rules

**100 emails** — paginate to 100; compact metadata only (sender, subject, timestamp, snippet, labels), not full bodies; deterministic rank first, bounded model triage on candidates; explain *why* each is important; report how many were reviewed.

**Calendar with named contact** — **search contacts first**; never invent an email; use the resolved address internally but **never print the full address**; resolve relative dates in the user's timezone; ask one concise question if time/duration is missing.

**GitHub issues → sheet** — `state=all`; paginate to exhaustion; **exclude pull requests** from issue results; every issue gets a row; write incrementally; assert input count == output rows.

**Drive resumes → sheet** — parse folder id from URL; paginate until every file is found; bounded concurrency; extract name / university / last job; `Unknown` for missing fields; record failures as rows rather than dropping them; include source filename + status; assert file count == row count.

**Email with PDF** — real upload through the UI, show filename, allow removal, validate type/size; handle bytes server-side; convert to the live tool's exact attachment format; never expose local paths; confirm sent only from the tool result.

## Bulk jobs

Paginate to completion · bounded concurrency · retry with backoff · incremental sheet writes · progress callbacks · partial-failure records · final count validation. Start at concurrency 5, transform batches 10–20, sheet appends 50–100. **Every discovered item produces a row or a visible failure record — never silently skipped.** No queue/database/worker infra unless streamed synchronous execution provably fails.

## Execution honesty

Never claim success unless the tool response confirms it. Never fabricate results, recipients, or attendees. Never turn "draft" into "send". Ask for genuinely missing required inputs rather than guessing. Never log or display API keys, tokens, full private emails, raw document text, or local paths.

---

## Scope

Smallest implementation that fully satisfies the assignment. No database, queue, workers, embeddings-before-lexical, multi-user infra, deployment, or design system.

**Cut order:** visual polish → stage-2 reranking → eval breadth → caching → resumable jobs.
**Never cut:** dynamic routing · full catalog access · all issues · all resumes · context-safe bulk · auth · real PDF attachments · reproducible setup.

## Working method

Per task: read only what's relevant → state the smallest change → implement it → run focused verification → report changed files + results → update `WORKLOG.md` → stop. No unrelated refactors.

**When blocked, debug in this order** (don't tune prompts before proving direct execution works):
env vars → client init → user-id consistency → connected-account status → tool exists in full catalog → catalog truncation → toolkit version → **direct tool execution** → argument schema → router ranking → agent selection → result parsing → bulk pagination → UI.

## Verification

Run the narrowest relevant check after each milestone. Before submission: `bun install && bun run dev`, then manually run all five prompts **and one variation of each**. Bulk workflows are tested in ascending order (GitHub 10 → 100 → all; Drive 5 → 25 → 100 → all) — never run the full 1,000-file job before the small ones pass.

Ban check (avoids the `COMPOSIO_API_KEY` false positive):
```bash
grep -RInE 'composio\.create|COMPOSIO_(SEARCH_TOOLS|MULTI_EXECUTE|REMOTE_)|tool-?router' src --exclude-dir=node_modules
```
Secret check:
```bash
grep -RInE 'sk-[A-Za-z0-9_-]{16,}|ak_[A-Za-z0-9]{16,}' . --exclude-dir=node_modules --exclude-dir=.git --exclude='.env*'
```

A task is done when verification passes or the failure is written down — not when the code is written.

## Git

Commit at milestones: scaffold baseline → catalog+router → agent integration → email/calendar/attachment → GitHub bulk → resume bulk → UX+docs → final. Never commit `.env`, keys, tokens, downloaded resumes, uploaded PDFs, or large result files. Don't rewrite history.

## Worklog

After each major task, update `WORKLOG.md`: `## Completed` · `## Verification Passed` · `## Current Architecture` · `## Known Problems` · `## Next Exact Task`. Keep it good enough that a fresh session resumes from CLAUDE.md + readme + plan + worklog + checklist alone.

## Done when

Five prompts + variations work · selection is dynamic · no banned functionality · Google (and GitHub where needed) auth works for a real user · every issue and every resume is in its sheet · bulk data never entered the agent context · attachments are real PDFs · contact privacy respected · setup reproduces from the README · `TASK_CHECKLIST.md` complete or remaining gaps documented honestly.
