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
| Thread state in S3 (`threads/<ts>.json`) | ⬜ todo | long threads lose context after bot restart |
| Chat-log + confidence + feedback + learning-session loop | ⬇ see next section | replaces plain "audit log"; 4-phase plan |
| File uploads from Slack (`file_share` subtype) | ⬜ todo | download via bot token, save to worktree, pass path in prompt |
| Deferred agent tools (`psql`, `download_report`, `playwright`) | ⬜ todo | unit-testable, no Slack needed |
| `@mentions` in channels | ⬜ untested | handler wired; bot needs to be invited to a channel to verify |
| Horizontal scale (`desiredCount >= 2`) | ⬜ untested | EFS + S3 state safe in theory, untested in practice |
| Multi-tenant per-query routing from JWT claims | ⬜ todo | Stage 1 uses `DEFAULT_TENANT_ID` |
| Native Nelson SSO (replace custom sign-in page) | ⬜ todo | coordinate with `nelson-user-management-service` owner |

Legend: ✅ done · ⏳ in progress · ⏸ blocked on external · ⬜ todo

**Known API bugs (Nelson side, not this service)**:
`/api/management/secure/reservations/arrivals` returns 500 (`hotel is null`); pagination on the main reservations search appears broken (agent told to use `totalCount` with `dateMode=EXACT`).

---

## Chat-log + confidence + feedback + learning loop (4-phase plan)

Goal: every answer is traceable, scored, and correctable. Dissatisfied answers queue up for a Sandeep-led review session (here in Claude Code, not Slack) that fixes the knowledge graph or the code.

**Phase A — chat log** (self-contained, ship first).
Every pipeline event appended to S3: `chatlog/<yyyy-mm-dd>/<thread_ts>/<ts>-<eventId>.json`. Events: `message_received`, `classifier_verdict`, `api_call`, `tool_use`, `agent_reply`, `reaction_swap`, `escalation`, `error`. Object Lock on the `chatlog/` prefix. Non-blocking (errors logged and swallowed).

**Phase B — confidence scoring**.
After each data-query reply, a cheap Haiku scoring call returns a 1-10 confidence score plus optional hedging flags (uncertain about: occupancy defaults, hotel pick, field interpretation). Stored on the `agent_reply` chat-log event. Shown in Slack as a small italic footer when <7/10.

**Phase C — feedback capture**.
Three sources: (1) 👎 / 👍 reaction on the bot's reply → `user_feedback` event; (2) `/nelson-feedback <comment>` slash command → same event kind with `comment`; (3) heuristic: a user's next turn containing "wrong", "not right", "hmm no", etc. → auto-flag. All written to the chat log.

**Phase D — learning-session mode**.
Invoked as a Claude Code session (here, not Slack) via a new `/learning` skill. Pulls flagged sessions from S3, walks each (user ask → bot reply → where it went wrong), proposes knowledge-graph or code fixes, Sandeep reviews + merges. The fix flows back to prod through the normal commit → `/refresh` pipeline. The learning session itself must not happen over Slack.

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
- **2026-04-22** — Cost redesign: the hot path no longer allocates a worktree or lets Sonnet roam the Nelson source. Knowledge is now consolidated in `nelson-assistant/knowledge/` (65 leaves, ~224 KB, shipped in the Docker image). At boot, `src/knowledge/loader.ts` loads every yaml into memory; per question a cheap Haiku "leaf picker" (`src/knowledge/picker.ts`) returns 1–3 relevant leaf paths, which `src/knowledge/inject.ts` renders into a PRIMARY-grounded-source block appended to Sonnet's system prompt. Source-read tools (`Read`, `Grep`, `Glob`, `Bash(git *)`) were removed from the runner allowlist; the only way back into the source tree is the new `mcp__nelson__deep_research` tool (`src/agent/tools/deep_research.ts`) which acquires a worktree, performs ≤5 reads / ≤3 greps, and releases — used as an EXPENSIVE fallback, not the default. `src/config/env.ts` gained per-role model ids (`BEDROCK_CLASSIFIER_MODEL_ID`, `BEDROCK_LEAF_PICKER_MODEL_ID`, `BEDROCK_CONFIDENCE_MODEL_ID`) so helper roles can swap to cheaper models independently. New `.claude/skills/train/` codifies release-branch-only reads (`origin/main` for omena-service-app, `origin/master` for everyone else; reads via `git show` / `git ls-tree`, no checkout). Goal: Sonnet bill down from ~$15/day on 15 queries to ≤$10/day / ~$300–400/month for 20 queries/day. Typecheck clean, 34/34 tests green. Dev server loads the 65-leaf bundle at startup.
