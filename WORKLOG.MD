# Work Log

_Updated: 2026-07-16, after checklist step 1–3 (catalog + router stage 1 + agent integration)._

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
        → [stage 2: bounded LLM confirm]        ← not built; stage 1 feeds the model directly
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

**Then checklist step 4 — stage 2 (bounded LLM confirm)**: ≤15 candidates in, ≤8 out, one reason each, selects only from candidates, safe parse fallback, skipped when stage 1 is decisive. This is also where the cross-toolkit crowding below should be addressed, since stage 2 can only pick from what stage 1 surfaces.

Before prompt 4 (resumes): correct `ASSIGNMENT_PLAN.md` §3.3 to the live Drive chain (`FIND_FOLDER` → `FIND_FILE` → `DOWNLOAD_FILE`) — `LIST_FILES`/`GET_FILE_V2` are deprecated.

Also: `/api/tool` and `/api/tool/set` (the scaffold's manual tool picker) are now vestigial — chat ignores them. They stay so the current frontend keeps rendering; the UX task should replace the picker with router step-rows showing `signals[]`.
