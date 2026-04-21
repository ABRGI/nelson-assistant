Stage 1 ready (global-auth + single `/nelson` command). Typecheck clean, 20/20 tests green.

  What you do next (15 min):
  1. Create the Slack app — paste slack/app-manifest.yml at api.slack.com/apps (From a manifest). Grab SLACK_APP_TOKEN (xapp-), SLACK_BOT_TOKEN (xoxb-), SLACK_SIGNING_SECRET, and your own Slack user ID.
  2. cp .env.example .env. Fill in:
     - The 4 Slack values from step 1.
     - NELSON_USER_MGMT_BASE_URL defaults to https://admin.nelson.management — both login and refresh-token exchange hit POST /api/user/login there. Override only if targeting a different user-management deployment.
     - NELSON_DISPLAY_NAME (optional, shown on the sign-in page).
     Leave AUTH_CALLBACK_BASE_URL=http://localhost:3100 and AWS_PROFILE=nelson as-is.
  3. Drop one ./.local-state/state/clients/<tenant>.json with just routing info: `{ tenantId, displayName, nelsonApiBaseUrl }`. No per-tenant auth fields — auth is global now. Template at SMOKE_TEST.md §4. If you register more than one tenant, set DEFAULT_TENANT_ID in .env.
  4. npm install && npm run dev — confirm "nelson-assistant listening  port: 3000, authPort: 3100, mode: socket".
  5. DM the bot /nelson what hotels can I see? — since you're unbound the bot posts an ephemeral "Sign in to Nelson" button linking to http://localhost:3100/auth/login/<nonce> (10 min TTL, 3 attempts). Click it, enter Nelson creds on that page (never in Slack). Expect a ":white_check_mark: Linked to *Nelson* as ..." DM back.
  6. Re-run /nelson what hotels can I see? → should stream a real answer from Nelson.
  7. /nelson delete reservation 12345 now → should escalate and tag you, not execute.

  What changed this round:
  - Auth is global: dropped `userManagementBaseUrl` / `cognitoUserPoolId` / `cognitoClientId` from ClientRecord; they now come from NELSON_* env vars in src/config/env.ts and are passed once into CognitoExchanger at boot.
  - /nelson-ask renamed to /nelson (src/slack/commands.ts + manifest + docs). First use auto-issues a sign-in button in the thread; no separate /nelson-auth call needed up-front.
  - /nelson-auth kept as a DM-only re-auth command (e.g. switch Nelson users); no longer takes a tenant argument.
  - src/agent/pipeline.ts now catches RefreshTokenInvalid on token refresh and auto-posts a fresh sign-in button instead of a cryptic error.
  - Tenant selection for Stage 1: buildTenantResolver in src/index.ts picks DEFAULT_TENANT_ID, or the sole registered tenant, or errors at call-time. Per-query routing from JWT claims is V2.
  - UserBinding and PendingAuth dropped tenantId — bindings are now global.
  - test/cognito.test.ts + test/nonce.test.ts updated for the new schemas (8 + 3 tests, all green).

  Remote testing (another machine, not your laptop): ngrok http 3100, set AUTH_CALLBACK_BASE_URL=<ngrok https url> in .env, restart.

  Most likely breakage: NELSON_USER_MGMT_BASE_URL or nelsonApiBaseUrl unreachable from your laptop (private VPC — use a tunnel), or Bedrock model access not granted on the nelson profile.
