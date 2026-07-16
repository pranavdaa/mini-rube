# TASK_CHECKLIST.md

Tick as **verified**, not as written. `[~]` = built but unverified. Log failures in `WORKLOG.md` rather than silently un-ticking.

---

## 0 — Baseline (~15m)

- [ ] `COMPOSIO_API_KEY=... sh scaffold.sh` → `.env` has both auth config ids + OpenRouter key
- [ ] `bun install && bun run dev` — server :3001, vite :5173
- [ ] Connect Google via UI; connection reaches ACTIVE
- [ ] Send one email through chat (scaffold's hardcoded tool) — proves auth + execution before writing any of our code
- [ ] Confirm `@composio/core` has the APIs we need (scaffold pins `^0.2.6`; pre-work used 0.13.1)
- [x] **Early risk probe:** list the Drive resume folder + download 1 PDF. Does it have a text layer, or is it a scan? — verified on the first 5 files: all `application/pdf`, `%PDF-` header, 1 page each, 735–1,063 chars of extracted text (no image-only scans), extraction correct on all 5. No OCR/vision path needed.
- [ ] Commit: scaffold baseline

## 1 — Catalog (~30m)

- [ ] Fetch complete `googlesuper` + `github` catalogs with **no alphabetical truncation**
- [ ] Assert counts ≈ 467 / 893 (1,360 total) — fail loudly if short
- [ ] Normalize per tool: `slug, toolkit, name, description, tags, inputFieldNames, version, important, readonly`
- [ ] Cache compact metadata; **full schemas excluded** from the index
- [ ] Toolkits read from config (adding `slack` = one array entry, zero code changes)
- [ ] Truncation canaries present: `GITHUB_LIST_REPOSITORY_ISSUES`, `GOOGLESUPER_LIST_FILES`

## 2 — Router stage 1 (~45m)

- [ ] Field-weighted lexical scoring over compact metadata
- [ ] Synonym expansion **with IDF cap** (expansions never outrank the user's own words)
- [ ] Toolkit affinity (inbox⇒google, repo/PR⇒github): boost implied, demote others
- [ ] Read/write intent via `readonly` metadata ("read my email" must not surface `BATCH_MODIFY_MESSAGES`)
- [ ] Important-tool prior
- [ ] Returns `slug, toolkit, version, score, signals[]`
- [ ] All five prompts land correct tools in the top ~15

## 3 — Agent integration (~30m)

- [ ] Router output → lazy full-schema load → AI SDK `tools{}` per turn
- [ ] Model sees ~6–10 schemas max — **assert it** — never the catalog
- [ ] `maxSteps` sufficient for multi-step chains (scaffold default 10)
- [ ] **Prompt 1**: last 100 emails → important ones
- [ ] **Prompt 2**: contact resolved first, event created, **full email never shown**
- [x] **Prompt 5**: real PDF attached and sent — verified live via `runTurn`: sent to own address, re-fetched the message, confirmed a real `mini-rube-test.pdf` attachment part (see WORKLOG.MD)
- [ ] Variations of 1/2/5 work (different wording, not the exact text)
- [ ] Commit: dynamic routing

## 4 — Stage 2 + eval (~30m)

- [ ] Bounded LLM confirm: ≤15 candidates in, ≤8 out, one reason each, candidates-only, safe parse fallback
- [ ] Skipped when stage 1 is decisive (latency)
- [ ] Eval harness ported, re-pointed at googlesuper/github
- [ ] ~25 cases incl. variations + multi-step (score capability coverage, not one expected slug)
- [ ] recall@k / MRR recorded → goes in the README

## 5 — Bulk: GitHub (~40m)

- [ ] Paginate `state=all`, `per_page=100` to exhaustion
- [ ] **Pull requests excluded** from issue results
- [ ] Incremental sheet writes (50–100/append), retry on 429
- [ ] Progress streamed to UI
- [ ] Failures recorded as visible rows, never dropped
- [ ] Agent receives only `{processed, succeeded, failed, outputUrl}`
- [ ] Ladder: 10 → 100 → **all (~550)**
- [ ] **Assert: issues fetched == rows written**
- [ ] Commit: GitHub bulk export

## 6 — Bulk: Drive resumes (~45m)

- [x] Folder id parsed from the URL
- [x] Paginate until every file discovered (expect ~1,000) — **1,000 discovered, 0 dropped**
- [x] Bounded concurrency (start 5), retry with backoff — default concurrency 5, withRetry on network failures
- [x] Per-file extract → `{name, university, last_job}` via small isolated model call — resumeCandidateTransform, gpt-4o-mini (OpenRouter)
- [x] `Unknown` for missing fields; source filename + status columns — zero Unknown fields across all 1,000 (100% extraction rate)
- [x] Extraction failures recorded, not dropped — status column is "ok" or "Extraction failed: <reason>"; no silent drops
- [x] Ladder: 5 → 25 → 100 → **all (~1,000)** — 25 ok, 100 ok, 1000 ok
- [x] **Assert: files discovered == rows written** — 1,000 discovered = 1,000 processed = 1,001 rows (incl header) ✓
- [ ] Commit: resume bulk export

## 7 — UX (~45m)

- [ ] Connected-app status + connect buttons (googlesuper, github)
- [ ] "Search Tools" step row → expandable → selected tools with `signals[]`
- [ ] Execution status rows; auth-required states clear
- [ ] Bulk progress (`247 / 1000`) + final sheet link
- [ ] Partial failures surfaced
- [x] PDF upload: filename shown, removable, type/size validated (client pre-check + server-side re-validation in attachments.ts)
- [ ] Never rendered: keys, tokens, full contact emails, raw bodies/resume text, local paths

## 8 — Submission

- [ ] README: problem · architecture · **why 1,360 tools can't fit** · router · lazy schemas · bulk outside context · auth · setup + env vars · how each prompt works · eval numbers · known limitations · future toolkits · pre-work adapted
- [ ] No production-readiness claims; limitations honest
- [ ] Ban grep clean (see CLAUDE.md)
- [ ] Secret grep clean; `.env` not committed
- [ ] Fresh clone → `bun install` → `scaffold.sh` → `bun run dev` reproduces
- [ ] **All five exact prompts + ≥1 variation each, run manually, final pass**
- [ ] `sh upload.sh <email>`

---

# Required Outcomes (final gate)

- [ ] Dynamic tool selection from live Composio catalog
- [ ] No composio.create
- [ ] No Composio Tool Router
- [ ] No COMPOSIO_* meta-tools
- [ ] Google authentication works
- [ ] GitHub authentication works when required
- [ ] Latest 100 emails can be retrieved and triaged
- [ ] Contact can be resolved before calendar creation
- [ ] Full contact email is not shown to the user
- [ ] All open and closed composiohq/composio issues reach a Google Sheet
- [ ] All resumes in the supplied folder reach a Google Sheet
- [x] PDF can be attached to an outgoing email
- [ ] Large datasets never enter the main agent context
- [ ] Similar prompt variations work
- [ ] Application runs locally
- [ ] README explains architecture and product decisions
- [ ] No model with >500k context window
