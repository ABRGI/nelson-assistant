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

## Training & analytics (runs locally on this dev VM)

All training-style jobs (topic analysis, bundle-gap mining, `/train`, `/learning`, `/debug`-driven fixes, decision-memory writes) run **only** on this GCP dev VM — never on the deployed ECS task. This is by design: Sandeep keeps eyes on frequency maps, new clusters, and knowledge-graph diffs before anything ships. The future lift to deployed infra is tracked as a late-roadmap task.

Every training job DMs the admin (`ESCALATION_SLACK_USER_ID`) a summary on completion via `scripts/_slack-notify.js#notifyAdmin`. New jobs should follow that pattern.

### Topic analysis (Phase F.1)

Embeds user questions from the chatlog, clusters by cosine similarity, and writes a topics report + a persistent embeddings cache.

- Source: `src/analytics/topics.ts`, `src/state/embedding-cache.ts`, `src/agent/embed.ts`.
- Output: `analytics/topics/<yyyy-mm-dd>.json` (one per run) and `analytics/embeddings/<hash>.json` (one per unique question; dedupe cache across runs).
- Storage: respects `STORAGE_MODE` — `fs` writes under `./.local-state/state/…`, `aws` writes to the S3 bucket in `STATE_BUCKET`.
- Full skill doc: [`.claude/skills/topic-analysis/SKILL.md`](./.claude/skills/topic-analysis/SKILL.md).

**Run manually** (dry run — no persistence, no Slack DM):

```bash
node scripts/run-topic-analysis.js --since=7d
```

**Run full** (persists the report + DMs admin):

```bash
node scripts/run-topic-analysis.js --since=7d --save --notify
```

Flags:
- `--since=<N>h|d` window (default `7d`).
- `--save` persists `analytics/topics/<date>.json`.
- `--notify` DMs `ESCALATION_SLACK_USER_ID` on completion.
- `--similarity-threshold=0..1` (default `0.78`). Lower = broader clusters.
- `--min-cluster-size=<N>` (default `2`).

The canonical cron invocation uses the `/topic-analysis` Claude Code skill so future steps (auto-decision-writing, Slack summaries with richer framing) can layer on without touching cron:

```
0 3 * * * cd /home/sandeep/nelson/nelson-assistant && claude -p "/topic-analysis --save --notify" >> /tmp/nelson-assistant-dev/topic-analysis.log 2>&1
```

### Install the nightly cron entry

On this VM, one-time:

```bash
mkdir -p /tmp/nelson-assistant-dev
( crontab -l 2>/dev/null | grep -v '/topic-analysis' ; \
  echo '0 3 * * * cd /home/sandeep/nelson/nelson-assistant && claude -p "/topic-analysis --save --notify" >> /tmp/nelson-assistant-dev/topic-analysis.log 2>&1' ) | crontab -
crontab -l | grep topic-analysis
```

Verify the first firing:

```bash
tail -f /tmp/nelson-assistant-dev/topic-analysis.log
```

The cron entry inherits the shell's PATH at job-execution time; if `claude` or `node` aren't found, extend crontab with `PATH=/usr/local/bin:/usr/bin:/bin:$HOME/.claude/local` (or wherever your `claude` binary lives — check with `which claude`).

To remove:

```bash
crontab -l | grep -v '/topic-analysis' | crontab -
```

### Inspect outputs

```bash
# Today's cluster report
cat .local-state/state/analytics/topics/$(date +%F).json | jq '.clusters[] | {id, size, frequency, representativeQuestion}'

# Embeddings cache size (one file per unique question)
ls .local-state/state/analytics/embeddings/ | wc -l
```

### S3 vs fs

The `.env` ships with `STORAGE_MODE=fs` and `STATE_BUCKET=nelsonassistant-nelson-assistant-state`. Flip `STORAGE_MODE=aws` to write to the KMS-encrypted S3 bucket (shared with prod). Both the bot and the training CLIs read the same two vars.

- CLI only, one-shot: `STORAGE_MODE=aws node scripts/run-topic-analysis.js --save --notify`
- Persistent: edit `.env` → `STORAGE_MODE=aws`. Next bot restart will also switch to S3 — migrate local state first if you want continuity.

## Production

Built and deployed via the `nelson-assistant-*` CDK stacks in `aws-infrastructure/`. All secrets come from Secrets Manager at boot; workspace is EFS at `/work`; state is S3 (`nelson-assistant-state-<env>`).
