# Stage 1 — local smoke test

End-to-end test of `nelson-assistant` on your laptop. No AWS infra, no ALB, no CDK. ~15 minutes if the prereqs are already in place.

What you are proving:
1. The bot boots, connects to Slack (Socket Mode), and — on your first `/nelson` — DMs you a one-time sign-in link that binds your Slack user to a Nelson user **via a web form, never via a Slack message**.
2. An ordinary question in Slack ends with the agent hitting Nelson on your behalf and streaming a real answer back into the thread.
3. A destructive-sounding question triggers an escalation that tags you instead of executing.

---

## 0 · Prereqs (one-time)

| Check | Command | Expected |
|---|---|---|
| Node 22+ | `node --version` | `v22.x` or higher |
| AWS profile `nelson` | `AWS_PROFILE=nelson aws sts get-caller-identity` | valid account + ARN |
| Bedrock Claude access | `AWS_PROFILE=nelson aws bedrock list-foundation-models --region eu-west-1 --query 'modelSummaries[?contains(modelId,\`anthropic\`)].modelId'` | Sonnet + Haiku IDs returned |
| Local nelson clone | `ls ~/Documents/nelson/src/nelson/.git` | directory exists |
| Slack workspace | — | one you can install a dev app into |

If Bedrock returns `[]` or an access-denied error, go to AWS Console → Bedrock → **Model access** on the `nelson` account and request access to the Claude Sonnet and Haiku models you configured in `.env`. This usually clears in a minute.

---

## 1 · Install

```bash
cd ~/Documents/nelson/src/nelson-assistant
npm install
```

---

## 2 · Create the Slack app

Full walkthrough: [`slack/README.md`](./slack/README.md). Short version:

1. <https://api.slack.com/apps> → **Create New App → From a manifest** → pick your workspace.
2. Paste the contents of [`slack/app-manifest.yml`](./slack/app-manifest.yml). Create.
3. **Basic Information → App-Level Tokens → Generate** with scope `connections:write`. Copy the `xapp-…` token → `SLACK_APP_TOKEN`.
4. **OAuth & Permissions → Install to Workspace**. Copy the `xoxb-…` token → `SLACK_BOT_TOKEN`.
5. **Basic Information → Signing Secret** → `SLACK_SIGNING_SECRET`.
6. Your own Slack member ID (profile → three-dots → Copy member ID) → `ESCALATION_SLACK_USER_ID`.

---

## 3 · `.env`

```bash
cp .env.example .env
```

Fill in these Slack values:

- `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `ESCALATION_SLACK_USER_ID`

Plus the Nelson global auth values (same for every tenant — one user-management-service instance serves all Nelson tenants):

- `NELSON_USER_MGMT_BASE_URL` — defaults to `https://admin.nelson.management`; both login and refresh-token exchange hit `POST /api/user/login` there
- `NELSON_DISPLAY_NAME` — optional; shown on the sign-in page (defaults to "Nelson")

Leave the rest at defaults:

- `STORAGE_MODE=fs` — JSON under `./.local-state/`
- `AWS_PROFILE=nelson` — Bedrock picks it up via the default credential chain
- `AUTH_CALLBACK_PORT=3100`, `AUTH_CALLBACK_BASE_URL=http://localhost:3100` — bot-hosted login page
- `NELSON_REMOTE_URL=file:///.../nelson` — local clone, no GitHub deploy key

Setting `SLACK_APP_TOKEN` turns on Socket Mode, so you don't need a public HTTPS URL for Slack events.

---

## 4 · Register one tenant

A tenant entry tells the bot which Nelson stack to call. Auth is global (one Cognito pool, shared across every tenant), so the tenant record only carries routing info — no auth endpoints:

```bash
mkdir -p ./.local-state/state/clients
cat > ./.local-state/state/clients/stage.json <<'EOF'
{
  "tenantId": "stage",
  "displayName": "Nelson Staging",
  "nelsonApiBaseUrl": "https://stage-api.your-nelson.example"
}
EOF
```

- `nelsonApiBaseUrl` is what the `nelson_api` agent tool calls once you're signed in.
- Must be reachable from your laptop. If it's inside a private VPC, use a VPN / bastion / SSH tunnel first.

If you register more than one tenant, set `DEFAULT_TENANT_ID` in `.env` to pick which one `/nelson` should route to for Stage 1 (per-query routing from JWT claims is V2).

> Alternative: use `/add-tenant` in this workspace to walk through the fields interactively.

---

## 5 · Start the service

```bash
npm run dev
```

Expected log lines (in this order):

```
config loaded                  storageMode: fs, socketMode: true
client registry loaded         tenants: [ 'stage' ]
slack auth.test ok             selfUserId: U..., team: ...
nelson-assistant listening     port: 3000, authPort: 3100, mode: socket, storage: fs
```

Sanity checks:

```bash
curl -s http://localhost:3000/health   # { "ok": true, "inFlight": 0 }
curl -s http://localhost:3100/health   # { "ok": true }
```

Leave `npm run dev` running in this terminal.

---

## 6 · Ask your first question — sign in inline

In Slack, DM the bot (search `@Nelson Assistant` → Message) or run the slash command anywhere:

```
/nelson what hotels am I allowed to see?
```

The first time you run `/nelson` the bot sees no binding for your Slack user and replies ephemerally with a **Sign in to Nelson** button linking to:

```
http://localhost:3100/auth/login/xP7r...
```

Click the button.

- A small login page opens ("Sign in to Nelson").
- Enter your Nelson username + password **on that page** — not in Slack.
- On submit the page POSTs to Nelson's `/api/user/login` (same endpoint the management UI uses), stores your refresh token encrypted on disk, and shows **"You're linked"**.
- The bot DMs you `:white_check_mark: Linked to *Nelson* as *username*`.
- Now run `/nelson what hotels am I allowed to see?` again — the bot is bound and answers directly.

Link is valid for 10 minutes and 3 attempts. If it expires, just run `/nelson` again — a fresh link is issued automatically. To force a new link (e.g. to switch Nelson users), DM the bot `/nelson-auth`.

**Only if you're testing from a different machine than the bot**: start ngrok (`ngrok http 3100`), set `AUTH_CALLBACK_BASE_URL` in `.env` to the ngrok HTTPS URL, restart `npm run dev`.

Verify the artifacts on disk:

```bash
ls ./.local-state/state/users/            # U<your-slack-id>.json
ls ./.local-state/secrets/nelson-assistant/user/   # U<your-slack-id>.secret
```

---

## 7 · Ask a real question

Slash command in any channel, or DM the bot directly:

```
/nelson what hotels am I allowed to see?
```

Expected flow in the thread:

1. Placeholder reply appears ("thinking…").
2. Progress line updates to `:gear: running nelson_api…` while the agent calls something like `GET /api/management/secure/hotels`.
3. Placeholder is replaced with an answer summarizing the real list, respecting your Nelson RBAC (hotels outside your Cognito claims are filtered out by Nelson itself, not by the bot).

First run will `git clone --bare` the nelson repo to `./.local-state/work/.bare/nelson.git` and `git worktree add` under `./.local-state/work/work/nelson/0`. Subsequent runs reuse the worktree pool.

Try a few more:

```
/nelson list reservations in hotel 7 for next week
/nelson what changed on develop in the nelson repo in the last 3 days?
```

The second question should answer purely via `git_log` without hitting Nelson APIs.

---

## 8 · Force an escalation

```
/nelson delete reservation 12345 now
```

Expected: the agent **refuses to execute**, calls `escalate_to_human`, and posts a message tagging your `ESCALATION_SLACK_USER_ID` with the reason and a permalink to the thread. No destructive call is made.

---

## 9 · Done — what you just proved

- Password never touched Slack: `/nelson` auto-issued a one-time link, form submits to Nelson directly.
- RBAC is preserved: every Nelson call carries *your* JWT.
- The agent respects escalation and does not execute destructive intent.
- State is on disk at `./.local-state/` — wipe it any time to start over, but you will lose your Slack binding and have to re-run `/nelson-auth`.

If you want to iterate, just save and `npm run dev` auto-reloads. Type `/nelson-help` in Slack for the command summary. Run `/nelson-auth` (DM only) if you ever need a fresh sign-in link — e.g. to switch Nelson users.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `slack auth.test failed` on boot | wrong `SLACK_BOT_TOKEN`, or app not installed in the workspace | Reinstall under OAuth & Permissions, copy the fresh `xoxb-…` |
| Slash command does nothing | Socket Mode not connected | Check `SLACK_APP_TOKEN` starts with `xapp-` and has `connections:write` |
| Sign-in link leads to "Link expired" | 10 min TTL passed or 3 failed attempts | Run `/nelson` again — a fresh link is issued automatically |
| Web form submit shows "Login failed" | Wrong Nelson creds, or `NELSON_USER_MGMT_BASE_URL` unreachable | Check you can `curl -sS $NELSON_USER_MGMT_BASE_URL/health` from the laptop |
| "Your Nelson session expired" on `/nelson` | refresh token expired or revoked | Click the new sign-in button the bot posts (auto), or run `/nelson-auth` |
| `AccessDeniedException` from Bedrock on first agent turn | `nelson` profile lacks `bedrock:InvokeModel*` or model not enabled in region | Bedrock → Model access → request Sonnet + Haiku |
| `ENOTFOUND`/timeout calling Nelson API | `nelsonApiBaseUrl` is in a private VPC | Open a tunnel / VPN, or use your public staging URL |
| First `/nelson` never returns | worktree clone of `nelson/` is slow | Watch logs; wait for `git worktree add` to finish once — future asks are instant |
| `git` errors | corrupt local worktree cache | `rm -rf ./.local-state/work` and retry |

If something else is weird, paste the last ~30 lines of `npm run dev` output — the structured logs include tenant, slackUserId, and tool name and make root-causing fast. Tokens and passwords are redacted.
