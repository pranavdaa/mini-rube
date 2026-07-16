# Work Log

_Updated: 2026-07-16, before hour 0. No application code written yet._

## Completed

- Read `readme.md`, the full scaffold source, and Composio docs/SDK.
- Wrote `ASSIGNMENT_PLAN.md` (architecture + constraint analysis), `CLAUDE.md` (implementation rules), `TASK_CHECKLIST.md` (build path + final gate).
- **Verified against the live Composio API:** `googlesuper` = 467 tools, `github` = 893 → **1,360 total ≈ 800k tokens of schema vs a 500k ceiling.** The catalog cannot fit in context; this is the thesis of the submission.
- **Verified the tool chain for all five prompts exists:** `GOOGLESUPER_FETCH_EMAILS` · `GOOGLESUPER_SEARCH_PEOPLE` + `GOOGLESUPER_CREATE_EVENT` · `GITHUB_LIST_REPOSITORY_ISSUES` + `GOOGLESUPER_CREATE_GOOGLE_SHEET1` + `GOOGLESUPER_CREATE_SPREADSHEET_ROW` · `GOOGLESUPER_LIST_FILES` + `GOOGLESUPER_DOWNLOAD_FILE` · `GOOGLESUPER_SEND_EMAIL`.
- **Established that Composio's sandbox is unusable here** — banned three ways: remote sandbox is reachable only via `COMPOSIO_REMOTE_WORKBENCH` (meta-tool ban); every sandbox needs a session via `composio.create()` (banned); local sandbox routes through the Tool Router (banned). Conclusion: build our own server-side job runner — which is what the assignment is actually asking for.

## Verification Passed

_None yet — no code written. `scaffold.sh` has not been run._

## Current Architecture

Planned (see `ASSIGNMENT_PLAN.md` §4), not yet built:

```
request → compact catalog index (1,360 tools, metadata only)
        → lexical retrieval (stage 1) → [bounded LLM confirm (stage 2)]
        → ~6-10 tools → lazy full-schema load → AI SDK streamText → Composio execution

bulk:   agent picks high-level bulk capability → server-side job runner
        → paginate to completion → bounded batches → incremental sheet writes
        → stream progress → agent sees only {processed, succeeded, failed, outputUrl}
```

Scaffold stays the shell: Bun :3001, Vite+React :5173, `useChat`, AI SDK `streamText`, `connectedAccounts.link()` auth, `executeTool`.

## Known Problems

- **Scaffold's `listToolSlugs({limit: 500})` is already broken** — `limit` truncates alphabetically against a 1,360-tool catalog, so `GITHUB_LIST_REPOSITORY_ISSUES` silently doesn't exist. Fix in step 1.
- **Unknown: do the resume PDFs have a text layer?** If they're scans, extraction needs OCR/vision and the design changes. **Probe in step 0** — largest schedule risk.
- **Unknown: `@composio/core@^0.2.6`** (scaffold pin) may lack APIs the pre-work used at 0.13.1. Verify in step 0.
- Drive folder is third-party-owned; permissions for list/download unproven.
- 1,000 downloads + 1,000 extractions + sheet appends will hit rate limits — needs bounded concurrency and 429 backoff.
- `kimi-k2` tool-calling reliability for multi-step chains unproven; `maxSteps: 10` may be low for prompt 2's chain.

## Next Exact Task

**Checklist step 0 — Baseline.** Run `COMPOSIO_API_KEY=... sh scaffold.sh`, then `bun run dev`, connect Google in the UI, and send one email via the scaffold's hardcoded `GOOGLESUPER_SEND_EMAIL` to prove auth + execution work before writing any of our own code. In the same pass run both risk probes: (a) list the Drive resume folder and download one PDF to check for a text layer; (b) confirm the pinned SDK version exposes the catalog APIs we need.
