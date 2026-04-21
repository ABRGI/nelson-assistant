# Nelson Assistant — Session Handover

Date: 2026-04-21
Repo: https://github.com/ABRGI/nelson-assistant (main)

## Deployed state

Running in AWS `459045743560` (eu-central-1):
- ECS Fargate service `NelsonAssistant-nelson-assistant` (1 task, desiredCount=1)
- ALB at `https://assistant.nelson.management`
- Slack app `Nelson Assistant` (bot user `U0ATXEL94SJ` in `Digitalist Group` workspace)
- Log group `/ecs/NelsonAssistant-nelson-assistant`
- State bucket `nelsonassistant-nelson-assistant-state` (KMS-encrypted)
- Runtime secret `nelson-assistant/runtime` (Slack creds + tokenEncryptionKey + idHashKey + githubDeployKey)

Bot is functional in DM mode. Auth flow (`/nelson-auth` → web login at `assistant.nelson.management/auth/login/<nonce>`) works. Refresh tokens stored AES-256-GCM encrypted in S3 at `users/<hmac(slackUserId)>.json`. Nelson API calls go through the user's fresh IdToken.

## What changed this session

1. **Refresh token storage**: moved from Secrets Manager (per-user) to KMS-encrypted S3 with app-level AES-256-GCM (`src/crypto/token-cipher.ts`). S3 filenames are HMAC-SHA256 hashed so Slack user IDs aren't exposed.
2. **Tenant registry**: reads from `nelson-tenants` DynamoDB table (eu-central-1) via `@aws-sdk/lib-dynamodb` DocumentClient. `nelsonApiBaseUrl = sitehost + "/api"`. Tenant IDs are environment UUIDs.
3. **`DEFAULT_TENANT_ID`**: set to `9b0703a5-48ae-46ef-9bf4-790c521e0586` (Prod Omena).
4. **ALB health check**: fixed path from `/status` to `/health`. Registered `/health` and `/ready` on Express app *before* passing it to Bolt's `ExpressReceiver` (otherwise Bolt's router shadows them).
5. **Auth page**: moved from port 3100 to port 3000 (same Express instance as Bolt) so ALB can reach it.
6. **GitHub deploy key**: ed25519 key generated, private key in `runtime` secret under `githubDeployKey`, public key added to 8 ABRGI repos (listed in `src/index.ts` `KNOWN_REMOTES`). Written to `/tmp/nelson-assistant-deploy.pem` at startup; `GIT_SSH_COMMAND` set in `WorktreePool.gitEnv`.
7. **Git safe.directory**: set via `GIT_CONFIG_COUNT/KEY_0/VALUE_0` env vars (EFS mount owned by different UID than ECS task).
8. **Push poisoning**: after bare clone, `git remote set-url --push origin no-push://read-only` so accidental pushes fail.
9. **No auto-fetch**: `acquire` no longer fetches; only clones if missing. New `GET /refresh?project=X` endpoint triggers fetch manually.
10. **`checkoutBranch`** simplified to `checkout -f` + `clean -fd` — no `reset --hard origin/<branch>` (fails on bare-clone because remote tracking refs aren't created).
11. **Error bubbling**: all pipeline + queue errors now post to Slack with a mention of `ESCALATION_SLACK_USER_ID`.
12. **Reaction swaps on user message**: ⏳ → ✅ success, ❌ error, ❓ needs-input (escalate_to_human tool OR final text ends with `?`).
13. **Conversation history**: DMs use `conversations.history` (last 20 msgs), mentions use `conversations.replies`.
14. **System prompt**: instructs agent to read `docs/12-api-reference.md` in the worktree before making API calls, and to respond as a hotel ops colleague (not a developer). No hardcoded endpoints.

## Infra layout

- `infra/` — CDK app. 3 stacks: HostedZone, Vpc, Service (peering stack exists but empty until we add client VPCs).
- Deploy: `AWS_PROFILE=nelson CDK_DEPLOY_ACCOUNT=459045743560 npx cdk deploy NelsonAssistantNelsonAssistantService --require-approval never`
- Image tag: uses `:latest`. Update flow: `docker build` → push to ECR → `aws ecs update-service --force-new-deployment`.

## Known gaps / pending

From `.claude/CLAUDE.md` "Known gaps":
- **Haiku pre-classifier** — would skip worktree allocation for purely conversational follow-ups (every message currently allocates a worktree even for "where did you get this info?"). Biggest remaining wart.
- **Thread state in S3** (`threads/<ts>.json`) — conversation context only lives in Slack today. After bot restart, long threads lose context.
- **Audit log** (`audit/*.jsonl`) — not written.
- **Playwright tool, psql tool wiring, download_report** — V2.
- **@mentions in channels** — manifest declares `app_mention`; handler is wired but the bot must be invited to a channel to receive them. DMs only tested so far.
- **File uploads from Slack** — not implemented. `file_share` subtype is ignored. Would need to: detect subtype, download with bot token, save to worktree/EFS, pass path in prompt.
- **`desiredCount >= 2`** — single task today; EFS-backed worktrees + S3 state means horizontal scale is safe but untested.
- **Additional tenants** — only Prod Omena wired in; multi-tenant routing from JWT claims is V2.
- **Nelson API bugs**: `/api/management/secure/reservations/arrivals` returns 500 (`hotel is null`), pagination on the search endpoint seems broken. Agent was told to use `totalCount` on the main reservations search with `dateMode=EXACT`.

## Key files

| File | What it does |
|---|---|
| `src/index.ts` | Bootstrap: config, stores, tenants, worktrees, Slack, queue, routes |
| `src/config/env.ts` | Zod-validated boot env + runtime secret loader |
| `src/crypto/token-cipher.ts` | AES-256-GCM encrypt/decrypt + HMAC-SHA256 id hash |
| `src/auth/clients.ts` | `ClientRegistry` — scans `nelson-tenants` DynamoDB |
| `src/auth/binding.ts` | `UserBindingStore` — slack user ↔ nelson sub, refresh token in encrypted S3 |
| `src/auth/cognito.ts` | `POST /api/user/login` refresh-token exchange |
| `src/auth/web.ts` | Custom sign-in page (HTML/CSS/JS + form POST) |
| `src/slack/commands.ts` | `/nelson`, `/nelson-auth`, `/nelson-help` |
| `src/slack/events.ts` | `app_mention` + DM `message` handlers (passes `userMessageTs` for reactions) |
| `src/agent/runner.ts` | Agent SDK `query()` — system prompt, MCP tools, Bedrock model id |
| `src/agent/pipeline.ts` | Full job lifecycle: bind → refresh token → worktree → agent → reactions |
| `src/agent/tools/nelson_api.ts` | The only HTTP client the agent gets. Fixed base URL + user IdToken. |
| `src/agent/tools/escalate.ts` | Posts in-thread tagging the escalation user |
| `src/agent/tools/git_log.ts` | Read-only git log |
| `src/worktree/pool.ts` | LRU pool on EFS. One bare repo per project, worktrees per branch. |
| `src/queue/inproc.ts` | `p-limit`-backed bounded job queue, catches handler crashes, posts error to Slack |
| `infra/lib/nelson-assistant-service-stack.ts` | ALB + ECS + EFS + S3 + task role (incl. DynamoDB scan perm) |

## Secrets (reminder)

Do **not** commit:
- `.env` (in `.gitignore`)
- `.local-state/` (in `.gitignore`)
- Any private key

`.env.example` has `TOKEN_ENCRYPTION_KEY=` and `ID_HASH_KEY=` as blank — generate with `openssl rand -base64 32` for local dev, or fetch the prod values from `nelson-assistant/runtime` if you need them to match.

## Useful commands

```bash
# Local dev (Socket Mode, fs stores)
npm run dev

# Deploy new image
docker build -t nelson-assistant .
docker tag nelson-assistant:latest 459045743560.dkr.ecr.eu-central-1.amazonaws.com/nelsonassistant-nelson-assistant:latest
docker push 459045743560.dkr.ecr.eu-central-1.amazonaws.com/nelsonassistant-nelson-assistant:latest
AWS_PROFILE=nelson aws ecs update-service --cluster NelsonAssistant-nelson-assistant --service NelsonAssistant-nelson-assistant --force-new-deployment --region eu-central-1

# Tail live logs
AWS_PROFILE=nelson aws logs tail /ecs/NelsonAssistant-nelson-assistant --follow --region eu-central-1

# Trigger repo refresh (fetches all configured remotes)
curl https://assistant.nelson.management/refresh
curl https://assistant.nelson.management/refresh?project=nelson-management-ui
```
