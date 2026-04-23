---
name: topic-analysis
description: Run the nightly topic-analysis job — embed user questions from the chatlog, cluster by cosine similarity, persist the report, and DM Sandeep with a summary. Runs on the GCP dev VM (never on the deployed ECS task). Triggered by cron or manually.
---

# /topic-analysis

Computes the Topics report: unique user questions in the chatlog → Titan v2 embeddings (persistent dedupe cache) → agglomerative clustering → `analytics/topics/<date>.json`. Surfaces the top-K clusters by frequency so `/train` can elevate them into Sonnet's pre-injection budget (Phase F.2).

**Hard rule**: runs only on the GCP dev VM (or successor dev machine), never on the deployed ECS task. See `.tasks/ROADMAP.md` for the "lift training to deployed" future task.

## Triggers

1. **Automatic (nightly cron)**: `0 3 * * * cd /home/sandeep/nelson/nelson-assistant && claude -p "/topic-analysis --save --notify" >> /tmp/nelson-assistant-dev/topic-analysis.log 2>&1`
2. **Manual**: Sandeep types `/topic-analysis` (or `run /topic-analysis`) in any Claude Code session. Default args are `--save --notify` to match the cron path.

## What to do

1. Invoke the CLI with all the args the user passed, defaulting to `--since=7d --save --notify` when unspecified:

   ```bash
   node scripts/run-topic-analysis.js --since=7d --save --notify
   ```

   Options:
   - `--since=<N>h|d` — window (default `7d`).
   - `--save` — persist `analytics/topics/<date>.json`. Always pass for real runs.
   - `--notify` — DM Sandeep (ESCALATION_SLACK_USER_ID) with a summary. Always pass for real runs.
   - `--similarity-threshold=<0..1>` — default `0.78`. Lower = broader clusters.
   - `--min-cluster-size=<N>` — default `2`. Anything smaller is a singleton.

2. The CLI writes the full JSON to stdout and a summary to stderr. Capture stderr for the Slack DM (already done when `--notify` is set).

3. After the run, log one short paragraph to this Claude Code session: cluster count, top-5 clusters (representative question + frequency + size), new-embeddings computed, tokens/cost. If `--save` landed a new report, show the key.

4. **Do not apply fixes** in this skill. Phase F.1 is report-only. If a cluster looks worth acting on (e.g. a common question the bundle answers poorly), Sandeep runs `/learning` separately.

## Prod vs dev storage

- **Dev** (default on this VM): writes to `./.local-state/state/analytics/topics/<date>.json`.
- **Prod-visible runs**: set `STORAGE_MODE=aws STATE_BUCKET=nelsonassistant-nelson-assistant-state AWS_PROFILE=nelson` in the cron env so the report lands in the KMS-encrypted bucket the ECS task reads from. Phase F.2 will use the S3 report to pre-inject cluster hints.

## Slack notification shape

The `--notify` flag sends a DM (not a channel post, not a thread reply) to `ESCALATION_SLACK_USER_ID` with the stderr summary block. Shape:

```
:bar_chart: *Training — topic analysis*
```
```
Topic analysis 2026-04-16 → 2026-04-23
Q: 99 raw / 42 unique
Clusters: 6 (singletons: 8)
Embeddings: 7 new / 35 cached (640 tokens, ~$0.000013)

Top 5:
1. arrivals today at HKI2 (freq=14, size=4)
...
```

If the DM send fails, print the error to stderr but do not throw — the report is already saved.

## Verification steps (for a new session setting this up)

1. `cat .local-state/state/analytics/topics/<today>.json | jq '.clusters[].representativeQuestion'` — spot-check cluster reps.
2. `ls .local-state/state/analytics/embeddings/ | wc -l` — one file per unique question.
3. Re-run within a few minutes: stderr should show `Embeddings: 0 new / <N> cached` (full cache hit).

## Authority boundary

- Reads chatlog + writes analytics + embeddings. No code edits. No deploys. No Nelson API calls.
- Writes Slack notifications via `ESCALATION_SLACK_USER_ID` DM. Never to channels.
- Does NOT ship inside the deployed Docker image — this skill lives under `.claude/` (dev-only tooling).
