---
name: smoke-test
description: Walk through the nelson-assistant Stage-1 local smoke test step by step — verify prereqs, kick off the dev server, guide through the Slack DM flow, diagnose any failure.
---

# /smoke-test

Guide the user through a local end-to-end smoke test of `nelson-assistant`. Authoritative procedure lives in `SMOKE_TEST.md` in the project root; defer to it when in doubt.

## Phase 1 — Prereqs (quick checks)

Run these in parallel:

```bash
node --version                                                   # expect v22+
AWS_PROFILE=nelson aws sts get-caller-identity                   # expect valid account/arn
AWS_PROFILE=nelson aws bedrock list-foundation-models --region eu-west-1 --query 'modelSummaries[?contains(modelId,`anthropic`)].modelId'
ls ~/Documents/nelson/src/nelson/.git >/dev/null                 # local nelson clone
test -f .env && echo "env: ok" || echo "env: missing"
```

If any fail, stop and resolve before going further. Common fixes:
- Bedrock model not returned → the `nelson` AWS account doesn't have model access in that region. Have the user request access for the Claude Sonnet model configured in `.env` via AWS console → Bedrock → Model access.
- No `.env` → copy from `.env.example` and fill in SLACK_* tokens + ESCALATION_SLACK_USER_ID. `NELSON_USER_MGMT_BASE_URL` defaults to `https://admin.nelson.management` — both login and refresh hit `POST /api/user/login` there, so no Cognito SDK creds are needed. Point at `slack/README.md` for the Slack app creation steps.

## Phase 2 — Tenant registry

Confirm at least one tenant file exists:

```bash
ls .local-state/state/clients/*.json 2>/dev/null || echo "no tenants registered"
```

If none, offer to run `/add-tenant` — ask for tenantId, displayName, and the private `nelsonApiBaseUrl`. Auth details are global env vars now, not per-tenant. If more than one tenant exists, make sure `DEFAULT_TENANT_ID` is set in `.env` before starting the service.

## Phase 3 — Code sanity

```bash
npm install                         # only if node_modules missing or package.json changed
npm run typecheck
npm test
```

Both must pass. If typecheck fails, fix before going further. If a test fails, that's a regression — investigate, don't ignore.

## Phase 4 — Start the service

Run `npm run dev` in the background (Bash `run_in_background: true`). Wait until you see the log line `nelson-assistant listening`. Report back to the user with the observed `mode` (should be `socket`) and `storage` (should be `fs`).

If it crashes, parse the error:
- `STATE_BUCKET is required when STORAGE_MODE=aws` → `STORAGE_MODE=fs` missing from `.env`.
- `slack auth.test failed` → SLACK_BOT_TOKEN wrong, or app not installed in workspace.
- `AccessDeniedException` on Bedrock at first agent call → model access, see Phase 1.

## Phase 5 — Walk the user through Slack

Tell the user to (in order):

1. Run the single command:
   ```
   /nelson what hotels am I allowed to see?
   ```
   On a first-time user the bot replies ephemerally with a **Sign in to Nelson** button (one-time URL, valid 10 min, 3 attempts). Tell the user to click it and enter their Nelson password on that page — *never* in Slack. On success they get a DM "Linked to *Nelson* …" and can re-run `/nelson`. If they need to share a machine, suggest `ngrok http 3100` and update `AUTH_CALLBACK_BASE_URL` in `.env`.

2. Second run (now bound) gets the real answer:
   ```
   /nelson what hotels am I allowed to see?
   ```
   Expect a placeholder → progress updates (`:gear: running nelson_api…`) → final answer.

3. Force an escalation (proves the safety path):
   ```
   /nelson delete reservation 12345 now
   ```
   Expect an `@<ESCALATION_SLACK_USER_ID>` tag and no destructive action.

4. (Optional) If the user wants to switch Nelson users or test re-auth, DM `/nelson-auth` to get a fresh sign-in link.

## Phase 6 — Report

Summarize for the user: what worked, what didn't, latency of the first real answer, any surprises. Close by asking whether to proceed to Stage 2 (AWS-backed dev) or add missing capability (e.g., more tools, thread persistence).

## If the user hits a red flag

- Never suggest `rm -rf .local-state` as a first response — state is usually recoverable and may contain the user binding they just made.
- Do not re-run `/nelson-auth` unless the user confirms they want to replace the current binding. (`/nelson` itself auto-issues a fresh link when the session has expired — no manual step usually needed.)
- If a Nelson API call returns 401/403, the refresh token likely expired — the bot should detect this and post a sign-in button automatically; if it doesn't, suggest `/nelson-auth`.
