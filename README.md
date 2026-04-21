# nelson-assistant

Slack-facing AI assistant for Nelson. Runs Claude Code via the [Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) on Amazon Bedrock, executes work inside per-conversation git worktrees on EFS, and answers in Slack threads. Acts on behalf of the asking Slack user by exchanging a stored Nelson refresh token for a fresh Cognito `IdToken` per call, so RBAC is preserved.

See the approved design at `~/.claude/plans/we-are-going-to-tingly-lark.md`.

## Local dev

Ten-minute smoke-test guide: **[SMOKE_TEST.md](./SMOKE_TEST.md)**. Short version:

```bash
cp .env.example .env    # fill in SLACK_* tokens + ESCALATION_SLACK_USER_ID
npm install
npm run dev
```

With `STORAGE_MODE=fs` (default in dev) and `SLACK_APP_TOKEN` set, the bot runs in Socket Mode with JSON state on disk at `./.local-state/` — no S3, no ALB, no ngrok. Bedrock + Cognito use the `nelson` AWS profile via the default credential chain.

## Layout

```
src/
  index.ts              express bootstrap
  config/               env + secrets loader
  slack/                bolt handlers: events, commands, interactive, renderer
  auth/                 binding (S3), clients (registry), cognito (refresh → IdToken)
  state/                S3 JSON store with conditional writes
  agent/                Agent SDK runner + custom tools
  worktree/             LRU git-worktree pool on EFS
  queue/                bounded async job queue
  observability/        logger
```

## Production

Built and deployed via the `nelson-assistant-*` CDK stacks in `aws-infrastructure/`. All secrets come from Secrets Manager at boot; workspace is EFS at `/work`; state is S3 (`nelson-assistant-state-<env>`).
