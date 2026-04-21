# Nelson Assistant

Slack-facing AI assistant for Nelson. Runs Claude Code via the Agent SDK on Amazon Bedrock, operates inside per-conversation git worktrees on EFS, and calls Nelson APIs on behalf of the asking Slack user (per-user Cognito JWT → preserved RBAC).

- **Approved plan**: `~/.claude/plans/we-are-going-to-tingly-lark.md`
- **Local smoke-test guide**: [`../SMOKE_TEST.md`](../SMOKE_TEST.md)
- **Slack app setup**: [`../slack/README.md`](../slack/README.md)

## Architecture (one-paragraph)

Stateless TS + Express + `@slack/bolt` service. Single hub VPC peered to every client's Nelson VPC + the shared RDS VPC, so one deployment serves all tenants. **Auth is global**: one `nelson-user-management-service` at `NELSON_USER_MGMT_BASE_URL` handles both password login and refresh-token exchange via `POST /api/user/login` (refresh branches when the body carries `refreshtoken` + the user's Cognito `sub`). The resulting JWT is trusted by every tenant's Nelson API, so user bindings carry no tenant. Per-Slack-user binding stores `{ nelsonSub, refreshToken }` (refresh token in Secrets Manager, binding metadata in the state store). `nelson_api` attaches the fresh `IdToken` to every Nelson HTTP request — Nelson's existing RBAC does the rest. The tenant registry only carries routing info (`nelsonApiBaseUrl`); Stage 1 picks a tenant via `DEFAULT_TENANT_ID`, V2 routes per-query from JWT claims. Conversation state and client registry live in a KMS-encrypted S3 bucket; git worktrees live on EFS. Bedrock Sonnet is the agent model; Haiku is reserved for a prompt pre-processor (V2).

## Layout

```
src/
  index.ts              express/socket-mode bootstrap, storage + receiver selection
  config/env.ts         boot config + runtime secret loader (Zod-validated)
  state/
    types.ts            JsonStore interface + ConditionFailedError
    s3.ts               AWS S3 impl
    fs.ts               local filesystem impl (dev only)
  secrets/
    types.ts            SecretVault interface
    aws.ts              AWS Secrets Manager impl
    fs.ts               local filesystem impl (dev only)
  auth/
    clients.ts          tenant registry loaded from clients/*.json
    binding.ts          slack-user → nelson-user binding + refresh token vault
    cognito.ts          refresh-token → IdToken exchange + JWT claim decoding
  slack/
    commands.ts         /nelson, /nelson-auth (DM re-auth), /nelson-help
    events.ts           app_mention + DM handler
    renderer.ts         throttled chat.update for streaming agent progress
  worktree/pool.ts      LRU git worktree pool on EFS (safe parallel branches)
  agent/
    runner.ts           @anthropic-ai/claude-agent-sdk query() + MCP tool wiring
    pipeline.ts         end-to-end job handler: bind → refresh → worktree → run → reply
    tools/              nelson_api, escalate, git_log
  queue/inproc.ts       p-limit-backed bounded queue
  observability/logger.ts   pino, with token/password redaction
test/                   vitest — pure logic only
slack/app-manifest.yml  paste into api.slack.com/apps
SMOKE_TEST.md           10-minute local test guide
Dockerfile              node:22-slim + git + psql + playwright/chromium
```

## Dev workflow

```bash
npm install
cp .env.example .env                 # fill in SLACK_* + ESCALATION_SLACK_USER_ID
npm run dev                          # socket mode + fs stores, no S3/SM needed
npm run typecheck                    # strict TS
npm test                             # vitest
```

Full local smoke procedure in [`../SMOKE_TEST.md`](../SMOKE_TEST.md).

In development:
- `STORAGE_MODE=fs` writes JSON state at `./.local-state/state/` and secrets at `./.local-state/secrets/` — no AWS state services needed.
- `SLACK_APP_TOKEN` triggers Socket Mode — no ngrok, no ALB.
- `AWS_PROFILE=nelson` is respected by Bedrock + Cognito + S3 via the default credential chain.

## Conventions

- **Runtime**: Node 22+, ESM (`.js` import extensions in TS source).
- **TS strictness**: `strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`. Do not loosen without a good reason.
- **Validation**: Zod at every trust boundary (env, tool inputs, S3 payloads, JWT claims). Export both the schema and the inferred type.
- **Logging**: always via `src/observability/logger.ts`. Never `console.log`. Redaction list already covers `*.token`, `*.password`, `SecretString`, etc. — extend it when you introduce new sensitive fields.
- **Errors**: throw typed errors; don't swallow. `ConditionFailedError` is the only retry-on-race signal — everything else propagates.
- **Comments**: only for non-obvious *why*. No narrative comments. No emojis except in user-facing Slack messages.
- **Scope discipline**: new code lands behind the same interface abstractions as existing code (`JsonStore`, `SecretVault`). Don't import `S3Client` or `SecretsManagerClient` from consumer code.

## Adding a new Agent tool

Use `/add-tool` (slash-command skill in `.claude/skills/add-tool/`). Manually:
1. Create `src/agent/tools/<name>.ts` exporting a Zod input schema + an async handler taking a context object.
2. Register it in `src/agent/runner.ts` inside `mcpServers.nelson.instance.tools` via the `tool()` helper.
3. Allowlist it as `mcp__nelson__<name>` in `allowedTools`.
4. Add a unit test for the pure logic.
5. Document the tool's authority boundary (what it can / cannot access) at the top of the file.

Reference: `src/agent/tools/nelson_api.ts`.

## Adding a new tenant (client)

Use `/add-tenant`. Manually:
1. Add `clients/<tenantId>.json` (schema: `ClientRecordSchema` in `src/auth/clients.ts`) to the state store — filesystem in dev, S3 in prod.
2. When CDK peering stack exists: register the tenant's VPC id + CIDR + route table + SG in the peering config and redeploy `nelson-assistant-peering-stack`.
3. Restart the service (or SIGHUP, once implemented) to reload the registry cache.

## Subagents available here

- **`nelson-architecture-expert`** — delegates reads across `~/Documents/nelson/src/*` (19 sibling projects). Use for "how does X work in Nelson?" / "where does Y live?" questions without pulling file contents into the main conversation.
- **`agent-sdk-specialist`** — knows `@anthropic-ai/claude-agent-sdk` API surface: tools, MCP, permission modes, session resume, streaming events. Use when touching `src/agent/`.

## Slash-command skills

- **`/smoke-test`** — runs the local end-to-end test procedure: checks prereqs, kicks off `npm run dev`, guides through the Slack DM flow.
- **`/add-tenant`** — collects tenant details and writes `clients/<tenantId>.json`.
- **`/add-tool`** — scaffolds a new Agent SDK tool and wires it into the runner.

## Known gaps (intentionally deferred)

- CDK stacks in `aws-infrastructure/` (hub VPC, peering, service) — not yet written.
- Playwright, `download_report`, `psql` tools — V2.
- Haiku pre-processor / classifier — V2.
- Thread state persistence in S3 (`threads/<ts>.json`) — not yet; history lives only in Slack.
- Audit log (`audit/*.jsonl`) — not yet.
- Per-task credential caching, metrics export, circuit breakers — V2+.

## External references

- Agent SDK: <https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript>
- Slack Bolt: <https://tools.slack.dev/bolt-js>
- Nelson core docs: `~/Documents/nelson/src/nelson/.claude/CLAUDE.md` and `~/Documents/nelson/src/nelson/docs/`
- This workspace's plan + memory: `~/.claude/plans/we-are-going-to-tingly-lark.md`, `~/.claude/projects/-home-sandeepbaynes-Documents-nelson-src-nelson-assistant/memory/MEMORY.md`
