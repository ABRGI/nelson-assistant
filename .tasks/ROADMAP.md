# Nelson Assistant — running roadmap

Single source of truth for "what state is this project in, what's next, and what has already shipped". Update this doc at the end of every working session so a new Claude Code session can resume from here without re-deriving context.

- **Approved design**: `~/.claude/plans/we-are-going-to-tingly-lark.md`
- **Smoke-test procedure**: [`../SMOKE_TEST.md`](../SMOKE_TEST.md)
- **Prior stage snapshot**: [`stage1.md`](./stage1.md)

---

## Status at a glance

| Area | State | Notes |
|---|---|---|
| Stage 1 — code (global auth, `/nelson`, auto-issued link) | ✅ done (2026-04-17) | typecheck clean, 20/20 tests green |
| Stage 1 — local smoke test | ⏸ blocked | waiting on IT admin to approve Slack app install |
| Stage 2 — CDK stacks (hub VPC, peering, service) | ⬜ todo | biggest remaining gap for production |
| Deferred agent tools (`psql`, `download_report`, `playwright`) | ⬜ todo | unit-testable, no Slack needed |
| Thread state in S3 + audit log | ⬜ todo | fits behind existing `JsonStore` |
| Haiku pre-processor / classifier | ⬜ todo | V2 |

Legend: ✅ done · ⏳ in progress · ⏸ blocked on external · ⬜ todo

---

## Resume instructions (for a fresh Claude session)

1. Read this doc top to bottom.
2. Skim the **completion log** at the bottom for the last one or two entries.
3. Pick the first non-done, non-blocked row in the status table and continue.
4. When a chunk is done, update the status table **and** append a log entry at the bottom.

---

## Stage 1 — local smoke test (code done, external blocker)

Code shipped, tests green. Runtime verification blocked on IT admin approving the Slack app installation (`/nelson` slash command needs the bot installed in the workspace). When unblocked, follow [`../SMOKE_TEST.md`](../SMOKE_TEST.md).

What the user does at that point (abridged — full steps in SMOKE_TEST.md):
- Install the approved app in the workspace → copy `SLACK_BOT_TOKEN` + `SLACK_SIGNING_SECRET` + `SLACK_APP_TOKEN` into `.env`.
- `NELSON_USER_MGMT_BASE_URL` defaults to `https://admin.nelson.management` (refresh flow reuses `/api/user/login` — no Cognito SDK creds needed).
- Drop one `./.local-state/state/clients/<tenant>.json` with `{ tenantId, displayName, nelsonApiBaseUrl }`.
- `npm run dev` → DM `/nelson <question>` → click the Sign in button → re-run `/nelson`.

---

## Stage 2 — CDK stacks (todo)

Target: `aws-infrastructure/lib/nelson-assistant/`, three focused stacks so client peerings can be added without redeploying the whole thing.

- [ ] `nelson-assistant-vpc-stack.ts` — hub VPC (1 public subnet/AZ, no NAT), VPC endpoints (Secrets Manager, Bedrock Runtime, ECR×2, Logs, STS, S3 gateway)
- [ ] `nelson-assistant-peering-stack.ts` — per-client VPC peering + routes + the RDS VPC peering
- [ ] `nelson-assistant-service-stack.ts` — ALB, ECR repo, ECS Fargate service, task role (least privilege), KMS CMK, S3 state bucket (versioned, SSE-KMS, Object Lock on `audit/`), Route53 A-record
- [ ] Wire into `aws-infrastructure/bin/aws-infrastructure.ts`
- [ ] Add `nelsonassistant.*` keys to `aws-infrastructure/config/*.json` (hub CIDR + client registry)
- [ ] `cdk diff` against a staging config; iterate until clean

Reference patterns to copy:
- ALB + listeners + target groups — `aws-infrastructure/lib/saas-infrastructure-stack.ts:193-318`
- ECS cluster + service — same file `:338-417`
- Secrets injection — `aws-infrastructure/lib/user-management-service/nelson-user-management-service-stack.ts:81-99`
- VPC construction — `aws-infrastructure/lib/vpc-infrastructure-stack.ts:21-38`

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
