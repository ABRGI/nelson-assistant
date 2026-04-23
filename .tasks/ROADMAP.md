# Nelson Assistant — running roadmap

Single source of truth for "what state is this project in, what's next, and what has already shipped". Update this doc at the end of every working session so a new Claude Code session can resume from here without re-deriving context.

- **Approved design**: `~/.claude/plans/we-are-going-to-tingly-lark.md`
- **Smoke-test procedure**: [`../SMOKE_TEST.md`](../SMOKE_TEST.md)
- **Prior stage snapshot**: [`stage1.md`](./stage1.md)

---

## Status at a glance

| Area | State | Notes |
|---|---|---|
| Stage 1 — code (global auth, `/nelson`, auto-issued link) | ✅ done (2026-04-17) | typecheck clean, tests green |
| Stage 1 — local smoke test | ✅ done (2026-04-21) | verified end-to-end from this GCP dev VM (socket mode) |
| Stage 2 — CDK stacks (vpc, hosted-zone, peering, service) | ✅ done (2026-04-21) | 4 stacks in `infra/lib/`, deployed to `459045743560` eu-central-1 |
| Production deploy | ✅ done (2026-04-21) | ECS Fargate + ALB at `assistant.nelson.management`; currently scaled to 0 while iterating locally |
| Haiku pre-classifier | ✅ done (2026-04-21) | data-query vs conversational; token-exchange runs in parallel; ephemeral prompt cache |
| Thread state in S3 (`threads/<ts>.json`) | ✅ done (2026-04-22) | `src/state/thread-state.ts` — scope/reservations/metric cuts/tools/cost persist per thread; loads at pipeline start, saves at end; 19 tests green |
| Chat-log + confidence + feedback + learning-session loop | ⬇ see next section | replaces plain "audit log"; 6-phase plan (A-F) |
| Per-session `deep_research` cap (max 1 call / sessionId) | ✅ done (2026-04-22) | closure counter in runner; second call returns a REJECTED text telling the model to answer from what it has or escalate |
| Bedrock cost/token capture end-to-end (Sonnet + Haiku helper roles) | ✅ done (2026-04-22) | SDK `total_cost_usd`/`modelUsage`/`num_turns`/`duration_ms` captured in runner; helper-role usage via shared `bedrock-usage.ts` — all written to `agent_reply`/`classifier_verdict`/`tool_use` chatlog events |
| Response-format HARD rules (no SQL/code to user, default breakdown, clarify on ambiguity) | ✅ done (2026-04-22) | encoded in `knowledge/nelson/output-format.yaml` + runner system prompt |
| Bundle-gap fixes observed during smoke test | ✅ done (2026-04-22) | `kpis.yaml` (KPI-to-endpoint guide + YoY worked example), `support-playbooks.yaml` (member email → escalate immediately, no deep_research), `nelson-bui-2.0/docs-map.yaml` (component-location hints) |
| `mcp__nelson__psql` MCP tool (node-pg, SELECT-only, schema-qualified) | ✅ done (2026-04-22) | replaces `Bash(psql:*)` — works on any environment without the psql binary |
| Reservation identifier routing by shape (9/10 digits vs UUID) | ✅ done (2026-04-22) | DB-verified via `scripts/reservation-formats.js`, HARD rule in runner + `endpoints/reservations.yaml` |
| OTB / pace correctness + `canonical_sql.otb_at_snapshot` | ✅ done (2026-04-22) | validated against Sales Forecast Daily report (62 vs 63 RN, 1-row edge case) |
| Dev-time debug channel (`debug <...>` / `[debug]`) | ✅ done (2026-04-22) | bot short-circuits; Monitor picks up; `scripts/slack-{thread,post}.js` helpers; file_share filter fix |
| Classifier full-thread context + promise coercion | ✅ done (2026-04-22) | no trim, `conversations.replies` scoped, past + future promise patterns rerouted to data_query |
| Slack reply hardening (chunking + mrkdwn) | ✅ done (2026-04-22) | `splitForSlack` for >3800 chars; full mrkdwn cheatsheet in runner seed |
| Analytics on chatlog (slow queries, deep_research triggers → leaf-gap list) | ✅ done (2026-04-23) | `src/analytics/bundle-gap.ts` — aggregates per-thread cost/tools/confidence/feedback, flags by threshold, persists to `analytics/bundle-gaps/<date>.json`. CLI at `scripts/run-bundle-gap-analysis.js`. 9 tests green. `/learning` skill updated to consume the pre-computed report. |
| Question similarity + frequency clustering | ⬜ Phase F | after Phase E — embeds + cluster + elevate top-K to pre-injection |
| dateMode selection HARD rule (ARRIVAL vs EXACT vs STAY vs CREATED) | ✅ done (2026-04-22) | `endpoints/reservations.yaml#dateMode_semantics` + runner seed — DB-verified user-phrasing → mode map; query-param logging on `nelson_api` tool |
| Decision memory (`decisions/<topic-slug>.json`) | ⬜ Phase E follow-on | distil fixes from `/debug` + `/learning` into indexed records the picker can consult before re-diagnosing |
| File uploads from Slack (`file_share` subtype) | ⬜ todo | download via bot token, save to worktree, pass path in prompt |
| Deferred agent tools (`psql`, `download_report`, `playwright`) | ⬜ todo | unit-testable, no Slack needed |
| `@mentions` in channels | ⬜ untested | handler wired; bot needs to be invited to a channel to verify |
| Horizontal scale (`desiredCount >= 2`) | ⬜ untested | EFS + S3 state safe in theory, untested in practice |
| Multi-tenant per-query routing from JWT claims | ⬜ todo | Stage 1 uses `DEFAULT_TENANT_ID` |
| Native Nelson SSO (replace custom sign-in page) | ⬜ todo | coordinate with `nelson-user-management-service` owner |

Legend: ✅ done · ⏳ in progress · ⏸ blocked on external · ⬜ todo

**Known API bugs (Nelson side, not this service)**:
`/api/management/secure/reservations/arrivals` returns 500 (`hotel is null`) — workaround is `/reservations?dateMode=ARRIVAL` (not EXACT; see `endpoints/reservations.yaml#dateMode_semantics`). Pagination cursor on the main reservations search is flaky — agent uses `totalCount=true` + narrow date windows.

---

## Chat-log + confidence + feedback + learning loop (6-phase plan)

Goal: every answer is traceable, scored, correctable, **and mined for priorities**. Dissatisfied answers queue up for a Sandeep-led review session (here in Claude Code, not Slack) that fixes the knowledge graph or the code. On top of that, the chatlog itself becomes a signal source: slow queries and `deep_research` triggers pinpoint the knowledge gaps; similarity + frequency clustering tells us which topics deserve the most pre-injection budget.

**Phase A — chat log** (self-contained, ship first).
Every pipeline event appended to S3: `chatlog/<yyyy-mm-dd>/<thread_ts>/<ts>-<eventId>.json`. Events: `message_received`, `classifier_verdict`, `api_call`, `tool_use`, `agent_reply`, `reaction_swap`, `escalation`, `error`. Object Lock on the `chatlog/` prefix. Non-blocking (errors logged and swallowed).

**Phase B — confidence scoring**.
After each data-query reply, a cheap Haiku scoring call returns a 1-10 confidence score plus optional hedging flags (uncertain about: occupancy defaults, hotel pick, field interpretation). Stored on the `agent_reply` chat-log event. Shown in Slack as a small italic footer when <7/10.

**Phase C — feedback capture**.
Three sources: (1) 👎 / 👍 reaction on the bot's reply → `user_feedback` event; (2) `/nelson-feedback <comment>` slash command → same event kind with `comment`; (3) heuristic: a user's next turn containing "wrong", "not right", "hmm no", etc. → auto-flag. All written to the chat log.

**Phase D — learning-session mode**.
Invoked as a Claude Code session (here, not Slack) via a new `/learning` skill. Pulls flagged sessions from S3, walks each (user ask → bot reply → where it went wrong), proposes knowledge-graph or code fixes, Sandeep reviews + merges. The fix flows back to prod through the normal commit → `/refresh` pipeline. The learning session itself must not happen over Slack.

**Phase E — chatlog analytics (bundle-gap mining)**.
Every chat is already tracked. A scheduled analytics pass (nightly or weekly) reads the chatlog and emits a **bundle-gap report**: questions where `deep_research` was called, questions where total latency > 20s, questions with confidence < 7, questions that escalated. Each entry links to the exact leaf(s) the picker chose + what deep_research greped for. The `/train` skill consumes this report so that the next knowledge refresh closes the most-hit gaps first. Intent: over time, `deep_research` usage should drop toward zero as the bundle absorbs what the source tree was answering.

**Phase F — question similarity + frequency clustering**.
Embed each user question (cheap Bedrock Titan or sentence-transformer), cluster by cosine similarity, and compute per-cluster frequency. Output: ranked list of "topics" (e.g. "pricing lookup single hotel", "arrivals for a date", "member account edit"). High-frequency clusters get elevated: bigger pre-injection budget, priority ordering in the picker catalogue, possibly cached answers. Low-frequency clusters can be pruned from the hot bundle to keep Sonnet's prompt tight. Publishes a Topics dashboard (json in S3 at first, later a UI) so we can see which topics are actually load-bearing. Must stay privacy-aware: only the clustered question text + counts leave the bot; no per-user identifying material.

---

## Agent knowledge graph (in-flight — 2026-04-21)

Each repo the agent touches gets a compact `.claude/knowledge/` graph: small entry-point (`knowledge.yaml`) + leaf files loaded on demand. Committed per-repo, refreshed during releases (no runtime refetch). System prompt in `src/agent/runner.ts` points at the entry point.

**Repos in scope** (deploy keys already installed, worktree-cloneable):

1. `nelson-assistant` (this repo, template)
2. `nelson`
3. `nelson-client-configuration`
4. `nelson-user-management-service`
5. `omena-mobile-app`
6. `nelson-management-ui`
7. `nelson-bui-2.0`
8. `omena-service-app`
9. `nelson-tenant-management-service`

**Awareness-only** (no deploy key, agent can't pull at runtime — get a one-paragraph entry in a shared `ecosystem.yaml` node under `nelson-assistant/.claude/knowledge/`, sourced from the local clones at `/home/sandeep/nelson/`):

- `CDP`
- `nelson-short-links-service`
- `nprice-core`
- `nprice-integration`
- `omena-wordpress`

---

## Resume instructions (for a fresh Claude session)

1. Read this doc top to bottom.
2. Skim the **completion log** at the bottom for the last one or two entries.
3. Pick the first non-done, non-blocked row in the status table and continue.
4. When a chunk is done, update the status table **and** append a log entry at the bottom.

---

## Deployed infra (Stage 1 + Stage 2 — done)

Running in AWS `459045743560` (eu-central-1):
- ECS Fargate service `NelsonAssistant-nelson-assistant` (1 task when active; currently scaled to 0 during local dev)
- ALB at `https://assistant.nelson.management`
- Slack app `Nelson Assistant` (bot `U0ATXEL94SJ` in `Digitalist Group` workspace)
- Log group `/ecs/NelsonAssistant-nelson-assistant`
- State bucket `nelsonassistant-nelson-assistant-state` (KMS-encrypted)
- Runtime secret `nelson-assistant/runtime` (Slack creds + tokenEncryptionKey + idHashKey + githubDeployKey)
- Tenant registry in DynamoDB `nelson-tenants`, default `DEFAULT_TENANT_ID=9b0703a5-48ae-46ef-9bf4-790c521e0586` (Prod Omena)

CDK stacks under `infra/lib/`:
- `nelson-assistant-hosted-zone-stack.ts`
- `nelson-assistant-vpc-stack.ts`
- `nelson-assistant-peering-stack.ts` (empty until client VPCs are added)
- `nelson-assistant-service-stack.ts` — ALB + ECS + EFS + S3 + task role

Deploy: `AWS_PROFILE=nelson CDK_DEPLOY_ACCOUNT=459045743560 npx cdk deploy NelsonAssistantNelsonAssistantService --require-approval never`.
Image update: `docker build` → ECR push → `aws ecs update-service --force-new-deployment`.

## Local dev loop (socket mode from GCP dev VM)

Confirmed working end-to-end from the remote dev instance:
1. `npm run dev` with `SLACK_APP_TOKEN` set → bot runs in socket mode, no ALB needed.
2. SSH-tunnel `3100` from your laptop so the sign-in page is reachable (`AUTH_CALLBACK_BASE_URL=http://localhost:3100`).
3. Scale ECS service to 0 while iterating locally (otherwise Slack socket events round-robin between prod and local).

Re-enable production after local work: `aws ecs update-service --cluster NelsonAssistant-nelson-assistant --service NelsonAssistant-nelson-assistant --desired-count 1 --region eu-central-1`.

---

## Deferred (V2+)

- **Agent tools**: `playwright.visual_compare`, `download_report`, `psql.query` (read-only, search_path forced per session)
- **Haiku pre-processor** — structured-prompt classifier + intent detection
- **Thread state persistence** — `threads/<thread_ts>.json` in S3 with `If-Match` for concurrent writes
- **Audit log** — `audit/<yyyy-mm-dd>/<conversation_id>.jsonl` under Object Lock
- **Per-task credential caching, metrics export, circuit breakers**
- **Multi-tenant per-query routing** from JWT claims (currently Stage 1 uses `DEFAULT_TENANT_ID`). The Nelson tenant model is `tenant(UUID, name) → environments[] → hotels[]`; environment UUIDs appear in the JWT `environmentids` claim. Source of truth is the `nelson-tenants` DynamoDB table in `eu-central-1`.
- **Task-role IAM policy for Nelson AWS reads** — the ECS task (and the equivalent dev EC2/VM when we deploy one) will run under a role that grants **read-only** access to Nelson AWS resources: `dynamodb:GetItem/Query/Scan` on `nelson-tenants` (so tenants/environments/hotels can be discovered at runtime instead of being mirrored into `clients/*.json`), plus the existing `bedrock:InvokeModel*`, `secretsmanager:GetSecretValue`, and state-bucket S3 perms. Write access stays off. Document this alongside the `nelson-assistant-service-stack.ts` task role when that gets written.
- **Replace the custom local sign-in page with native Nelson SSO** — Stage 1 ships a bot-hosted `/auth?token=…` page where the user types their Nelson username + password; the backend calls `POST /api/user/login` and stores the refresh token. Acceptable for localhost but wrong for production: passwords should never leave the canonical Nelson login surface. Post-deploy target: the Slack "Sign in" button opens `https://admin.nelson.management/...` (real Nelson login UI) with a state/redirect parameter; after successful login, Nelson redirects back to `nelson-assistant.<domain>/auth/callback` with either an auth code or a scoped refresh token; the bot stores it and resumes the Slack flow. Needs a small addition on the `nelson-user-management-service` side (OAuth-style authorize + callback, or a signed redirect handoff) — coordinate with the Nelson auth owner before designing. Until then, the custom page is the MVP fallback.

---

## Completion log

Append-only. Newest last.

- **2026-04-17** — Stage 1 code complete. `/nelson-ask` → `/nelson`, auto-issued sign-in button, global Nelson auth (no per-tenant auth fields), `buildTenantResolver` for Stage 1 tenant picking, `RefreshTokenInvalid` auto-reprompt. Typecheck clean, 20/20 tests green. Docs updated (SMOKE_TEST.md, stage1.md, manifest, skills, CLAUDE.md).
- **2026-04-19** — Slack app creation blocked by IT admin approval for install. Created this consolidated running doc (`.tasks/ROADMAP.md`).
- **2026-04-20** — GCP worker plan separated out of this roadmap: it's cross-project dev infra, not Nelson-specific. Moved to `~/Documents/nelson/src/GCP_CLAUDE_WORKER.md` with Terraform IaC.
- **2026-04-21** — Stage 2 CDK + production deploy done earlier in the week (see `.tasks/HANDOVER.md` for details). This session: brought back socket mode on the GCP dev VM (scaled ECS to 0, installed AWS CLI, fixed `PORT`/`AUTH_CALLBACK_BASE_URL` port mismatch, verified full DM → auth → Nelson API loop). Replaced `:gear: running Grep…` raw-tool progress messages with domain-aware, hotel-ops-friendly phrasing in `src/agent/pipeline.ts` (`describeToolActivity` + `describeNelsonApiCall`). Next: Haiku pre-classifier to skip worktree allocation on conversational follow-ups.
- **2026-04-21 (later)** — Haiku pre-classifier shipped (`src/agent/classifier.ts` + `src/slack/history.ts` + pipeline gate; 8 parsing tests added). Then built the `.claude/knowledge/` graph system: agent reads a per-repo YAML graph at runtime instead of hunting through narrative docs. Committed: `nelson/` (24 leaves — tasks, hotel-identity, enums, bugs, security-prefixes, endpoints/*, db + db/*, kpis, diagnostics, response-shapes, support-playbooks, cross-repo-content, code-paths, authority-boundary, output-format, modules) and `nelson-assistant/` (10 leaves — stack, flow, agent-tools, storage, deploys, slack, dev-loop, conventions, gotchas, ecosystem, observability). Iterated via Q&A in-session, picking up gaps on: ADR/RevPAR/Occupancy KPIs, PDF-receipt glyph errors, move-payment-between-reservations pattern, change-member-email, BeonX XML archive, Booking.com OTA failures, BUI breakfast-description content ownership, CloudWatch log-group map. New session rules: **read-only + escalate-only** (bot never writes), **cite sources + flag assumptions** on every factual Slack reply, **build graphs from release branch only** (main/master, never develop). Memory entries saved under `~/.claude/projects/-home-sandeep-nelson-nelson-assistant/memory/`. Built `/refresh-knowledge-graph` skill so the graph can be re-synced with a single slash command next time.
- **2026-04-21 (later²)** — Scaffolded graphs for the remaining 7 in-scope repos from release branch: `nelson-user-management-service` (5 leaves: entry, flow, endpoints, cognito, deploys, gotchas), `nelson-tenant-management-service` (3 leaves: entry, endpoints, data, deploys), `nelson-client-configuration` (3 leaves: entry, layout, content-files, dev-and-deploy), `nelson-management-ui` (5 leaves: entry, stack, portals-and-routes, api-patterns, i18n, deploys), `nelson-bui-2.0` (4 leaves: entry, stack, docs-map, i18n, deploys), `omena-mobile-app` (2 leaves: entry, stack, envs-and-build), `omena-service-app` (2 leaves: entry, stack, envs-and-build). 38 total files across all 9 repos. Ready for user to commit per-repo (each must land on the release branch: master for most, main for omena-service-app).
- **2026-04-22 (later)** — Post-smoke-test hardening: (1) `mcp__nelson__deep_research` hard-capped at 1 call per job via a closure counter inside `runAgent` — the observation session caught Q10 triggering 3 calls / 44KB of source reads; the second call now returns a REJECTED message telling the model to answer from what it has or escalate. (2) End-to-end Bedrock cost tracking: Sonnet SDK result carries `total_cost_usd`, `modelUsage` per model id, `num_turns`, `duration_ms`, `duration_api_ms`, and the deep_research counter; helper roles (classifier, leaf picker, confidence) refactored to a shared `src/observability/bedrock-usage.ts` that parses `usage` from the Bedrock response body. All of it flows into chatlog `agent_reply` / `classifier_verdict` / `tool_use` events so a future analytics pass (Phase E) can aggregate $/thread / $/tenant / $/day without new instrumentation. (3) Three HARD response-format rules encoded in `knowledge/nelson/output-format.yaml` + `src/agent/runner.ts`: never paste SQL/code to the user (cite concepts), default-break-down quantitative replies by hotel × channel × room-type × date scope (created today vs arriving today vs staying tonight), and ask one clarifying question on ambiguity instead of silently picking an interpretation. (4) Bundle gaps observed during the smoke test closed: `kpis.yaml` now has a `how_to_answer_a_kpi_question_end_to_end` section pointing to the sales-forecast-daily-data JSON endpoint with the −364d YoY flow + worked example; `support-playbooks.yaml#change_member_email` now tells the agent to escalate immediately, do NOT read CRM state, do NOT call deep_research; `nelson-bui-2.0/docs-map.yaml` gained a `component_location_hints` directory map so "where does X live in BUI?" questions answer from the leaf instead of triggering a source-tree walk. (5) Reaction handler fixed to find the reacted-to message in the thread (was incorrectly reading only index [0] of `conversations.replies`). Typecheck clean, 34/34 tests green.
- **2026-04-23** — Doc + training pass before the first multi-commit push. Re-ran the `/train` DB refresh scripts (`scripts/db-dump.js` + `scripts/reservation-formats.js`) and confirmed: hotel roster, enum lists (reservation.state/booking_channel/change_type/product.type), and identifier shape invariants (9-digit codes, 36-char UUIDs, 10-digit OTA refs across all channels) are unchanged from yesterday. Bumped `last_db_refresh: 2026-04-23` in `enums.yaml` + `tenant-hotels.yaml`. OTB validator still 11/11 within tolerance, 8/11 exact. Fixed stale references from the doc-review: `knowledge/nelson/tasks.yaml` + `knowledge/nelson/db/queries.yaml` were using non-existent DB columns (`r.start_date`, `r.end_date`, `r.code`, `r.channel`, `r.created_ts`) and an enum value (`CHECK_IN_INCOMPLETE`) the DB doesn't have — rewrote to use the actual `nelson.reservation` columns (`check_in`, `check_out`, `reservation_code`, `booking_channel`, `confirmed`) with `state = 'CONFIRMED'`. Fixed `knowledge/nelson/diagnostics.yaml` still recommending `dateMode=EXACT` for the broken-arrivals workaround — now `dateMode=ARRIVAL` with a pointer to `endpoints/reservations.yaml#dateMode_semantics`. Ticked scenarios A1–A6 + G1/G2/G4 as passed in `.tasks/STRESS_TEST_SCENARIOS.md`. Added `.test_data/` and `.tasks/taskprompt.txt` to `.gitignore` so production XLSX reports never get committed. Typecheck clean, 53/53 tests green. Ready to push the 13-commit accumulation from the dev session.
- **2026-04-22 (later³)** — Big day on the debug-session loop. While Sandeep tested OTB/KPI queries from Slack the bot exposed several real bugs, all fixed through the `debug` channel and walked end-to-end:
  - **New MCP tool `mcp__nelson__psql`** (`src/agent/tools/psql.ts`). Native node-pg, SSL-forced, SELECT/WITH/EXPLAIN/SHOW only with syntactic guard. 100 rows default / 500 max, 15s timeout. Replaces the unreliable `Bash(psql:*)` allow-entry (psql binary wasn't installed on the dev VM, so the old wiring silently failed and Sonnet fell back to the HTTP API every time). Pool built once per process via `buildPsqlPool`, passed through `RunAgentArgs.psqlPool`.
  - **DB-verified reservation-identifier routing.** Pulled the real identifier shapes from `nelson.reservation` via `scripts/reservation-formats.js`: `reservation_code` is *exactly 9 digits* on every channel, `uuid` is 36-char standard, `booking_channel_reservation_id` is *exactly 10 digits* for BOOKINGCOM + EXPEDIA only. Encoded as `identifiers` + `how_to_route_a_user_supplied_identifier` in `knowledge/nelson/endpoints/reservations.yaml`, plus a HARD routing rule in the runner seed: 9-digit → psql first, 10-digit → psql for OTA ref first, UUID → API first. Stops Sonnet from concluding "reservation does not exist" after a single fuzzy `?code=` miss.
  - **OTB / pace / "same time last year" correctness rewrite** (`knowledge/nelson/kpis.yaml`). Root-caused three compounding bugs from real OTB questions: (a) Sonnet added EXTRA_BED to the room-night count, inflating RN by the number of extra beds — `revenue sums ACCOMMODATION+EXTRA_BED, Room Nights counts ACCOMMODATION only`. (b) `net_price()` failed because observer_user's search_path excludes `nelson` — schema-qualified as `nelson.net_price(price, vat_percentage)`. (c) Sonnet returned the CURRENT total for last-year's stay date and called it OTB, instead of the equivalent-snapshot OTB. Added a new `canonical_sql.otb_at_snapshot` that filters on `li.confirmed <= snapshot` + cancel-state-as-of-snapshot; validated against the Sales Forecast Daily report (5 of 6 per-channel rows match exactly; NELSON-direct is off by 1 row / €52, an edge case on the cancel-timestamp boundary). New `otb_and_sales_forecast` section with forbidden-patterns + never_do list. `kpis.yaml` header `when_to_load` expanded so the picker surfaces it on OTB / pace / YoY / "same time last year" phrasings — previously it was missing and Sonnet improvised with bad SQL.
  - **Dev-time debug channel** (`src/slack/debug.ts`, `.claude/skills/debug/SKILL.md`). Sandeep types `debug <anything>` in Slack → bot short-circuits the pipeline, logs a structured `debug message received` event, reacts `:construction:` on the user's message. A Monitor running in the parallel Claude Code session picks up the log line, fetches the thread via `scripts/slack-thread.js`, diagnoses, applies the fix, and replies on the same thread via `scripts/slack-post.js` with the mandatory `[debug]` prefix. Both `debug <...>` (user) and `[debug] <...>` (bot) are filtered out of `loadConversationHistory` so the classifier / Sonnet never see them. Fixed a filter bug: DM messages with `subtype: file_share` (image uploads) were being dropped before the debug check — now `file_share` flows through so debug-with-screenshot works.
  - **Classifier: no unkeepable promises, past-tense or future-tense.** Multiple loops caught: Haiku replied "Let me run the corrected query…" (future-tense — promised work it can't do); another time it replied "I've flagged reservation 717463067 for ops to review…" (past-tense — claimed an escalation that never happened). Prompt now has explicit FORBIDDEN lists for both tenses, plus a `coercePromisesToDataQuery` guard in `src/agent/pipeline.ts` that scans the classifier's conversational reply for any of those phrases and reroutes to `data_query` with the reply as the `effective_question` — so even if Haiku slips, Sonnet actually runs.
  - **Full-thread context.** Dropped the `CLASSIFIER_HISTORY_TURNS=8` trim; bumped Slack fetch limit 20→200. DM history now uses `conversations.replies` on `threadTs` whenever set (previously it pulled the entire DM channel, so by turn 3 the classifier was drowning in hours-old unrelated test messages). Fixed `excludeTs` to be `userMessageTs` (was `threadTs`, which was stripping the user's original question on thread-reply turns).
  - **Classifier schema extended** with `needs_clarification` verdict (the ask-hotel path) and `data_query.effective_question` (the reconstruction path for follow-ups, scope-changes, corrections, multi-message builds, references). Prompt rewritten as a conversational-flow reader: "walk the whole thread, figure out what the user wants right now, reconstruct the complete question when the latest message isn't self-contained". Tenant-hotel roster + ambiguous cities baked into the Haiku system prompt so "which hotel?" clarifications list the live 10-hotel Omena roster inline; city-ambiguous phrasings (Helsinki, Turku) narrow to the labels mapped under that city.
  - **Slack reply hardening.** Added `splitForSlack` in `src/slack/renderer.ts` so Sonnet replies >3800 chars auto-chunk with "continued above/below" markers (fixes real `msg_too_long` drops). Elevated the Slack-mrkdwn rendering rule in the runner seed with a full cheatsheet: `*single*` bold, NO `**double**`, NO Markdown pipe tables (`| col |`), `<url|label>` links not `[label](url)`, emoji names work, headings as `*bold*` lines not `#`. Sonnet tone rules added: no thinking-out-loud ("Let me check the data…"), no repetition, one answer per reply.
  - **Bundle is now 253 KB across 66 leaves** (up from 224 KB / 65). Typecheck clean, 34/34 tests green throughout. All of today's progress captured via Sandeep-driven `debug` messages on Slack — the loop worked: fix → reload → retry → confirm.
- **2026-04-22** — Cost redesign: the hot path no longer allocates a worktree or lets Sonnet roam the Nelson source. Knowledge is now consolidated in `nelson-assistant/knowledge/` (65 leaves, ~224 KB, shipped in the Docker image). At boot, `src/knowledge/loader.ts` loads every yaml into memory; per question a cheap Haiku "leaf picker" (`src/knowledge/picker.ts`) returns 1–3 relevant leaf paths, which `src/knowledge/inject.ts` renders into a PRIMARY-grounded-source block appended to Sonnet's system prompt. Source-read tools (`Read`, `Grep`, `Glob`, `Bash(git *)`) were removed from the runner allowlist; the only way back into the source tree is the new `mcp__nelson__deep_research` tool (`src/agent/tools/deep_research.ts`) which acquires a worktree, performs ≤5 reads / ≤3 greps, and releases — used as an EXPENSIVE fallback, not the default. `src/config/env.ts` gained per-role model ids (`BEDROCK_CLASSIFIER_MODEL_ID`, `BEDROCK_LEAF_PICKER_MODEL_ID`, `BEDROCK_CONFIDENCE_MODEL_ID`) so helper roles can swap to cheaper models independently. New `.claude/skills/train/` codifies release-branch-only reads (`origin/main` for omena-service-app, `origin/master` for everyone else; reads via `git show` / `git ls-tree`, no checkout). Goal: Sonnet bill down from ~$15/day on 15 queries to ≤$10/day / ~$300–400/month for 20 queries/day. Typecheck clean, 34/34 tests green. Dev server loads the 65-leaf bundle at startup.
