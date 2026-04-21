# Slack app setup

## One-time: create the Slack app

1. Go to https://api.slack.com/apps → **Create New App** → **From a manifest**.
2. Pick the workspace you want to test in.
3. Paste the contents of [`app-manifest.yml`](./app-manifest.yml). Review and create.
4. On the app page:
   - **Basic Information → App-Level Tokens → Generate Token and Scopes**. Scope: `connections:write`. Copy the `xapp-...` token — that's `SLACK_APP_TOKEN`.
   - **OAuth & Permissions → Install to Workspace**. Copy the `xoxb-...` token — that's `SLACK_BOT_TOKEN`.
   - **Basic Information → App Credentials → Signing Secret** — that's `SLACK_SIGNING_SECRET`. (In Socket Mode it's not used to verify requests, but Bolt still asks for it to boot.)

Put all three into `.env` at the project root.

## Find your Slack user ID (for escalation)

In Slack, click your avatar → **Profile** → the three-dots menu → **Copy member ID**. Put it in `.env` as `ESCALATION_SLACK_USER_ID`.

## Invite the bot

DM the bot (`@Nelson Assistant` in the Slack search bar → Message) or use `/nelson` anywhere. On first use the bot replies with a **Sign in to Nelson** button — click it and enter your Nelson password on that page, never in Slack. After the "Linked" DM, re-run `/nelson` to get your real answer. If you ever need to switch Nelson users or force a new link, DM the bot `/nelson-auth`.
