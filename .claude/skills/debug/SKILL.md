---
name: debug
description: Handle a "debug <...>" message that Sandeep sent over Slack — pull the thread, diagnose the issue, apply a fix, and reply on the same Slack thread. Works while Claude Code is left running on the dev box with a Monitor tailing the bot log; also usable manually when Sandeep says "run /debug".
---

# /debug

Sandeep uses this channel to drive dev iteration from Slack while travelling. He types `debug <instruction>` in any DM/thread with the Nelson bot; the bot short-circuits (no classifier, no Sonnet) and logs a `debug message received` event. A Claude Code session running on this dev box picks the log event up via its Monitor, opens a debug session, fixes the issue, and replies on the same Slack thread.

This skill only runs in a Claude Code session on the dev machine. It never deploys anything. It never runs in prod. If the bot is running in prod and the user sends `debug ...`, Claude Code only responds if it is actively tailing the prod logs — otherwise the bot just logs the event and nobody picks it up.

## The filtering contract

Two prefixes form a dedicated channel that the bot's classifier + Sonnet NEVER see:
- `debug <...>` — user-side. Short-circuited by `handleDebugPrefix()` in `src/slack/events.ts`.
- `[debug] <...>` — bot-side. Auto-prepended by `scripts/slack-post.js` on every reply.

`loadConversationHistory` filters out any message matching either prefix before handing history to the classifier. That keeps dev-time noise out of the model's context. Do not remove the prefix from slack-post.js.

## When this skill fires

Two triggers:
1. **Automatic**: the Monitor task (tight filter includes `debug message received`) sends a notification. The notification content carries `channel`, `threadTs`, `userMessageTs`, `slackUserId`, `text`, `intent` — everything needed to resume the conversation.
2. **Manual**: Sandeep types `/debug` in a Claude Code session, optionally followed by a channel+ts pointer. Use this when the Monitor isn't running or Sandeep wants to back-fill an earlier debug message.

## 0 · Acknowledge immediately

Before doing anything else, post a one-liner on the Slack thread so Sandeep knows you got the message:

```bash
node scripts/slack-post.js <channel> <threadTs> ":wrench: On it — pulling the thread + logs now."
```

## 1 · Pull the thread

```bash
node scripts/slack-thread.js <channel> <threadTs>
```

Returns every message in the thread (user + bot) with ts prefixes. Read the full thread so you understand what Sandeep is flagging — do NOT assume from the one debug message alone.

## 2 · Pull the relevant logs

The bot log is at `/tmp/nelson-assistant-dev/server.log`. Use Grep to pull the pipeline events around the thread's `threadTs`:

```bash
# all events for this thread
grep '"threadTs":"<threadTs>"' /tmp/nelson-assistant-dev/server.log
# OR classifier / picker / agent lines around the last few minutes
grep -E "haiku classifier|leaf picker|agent run complete|job completed|parse failed|deep_research" /tmp/nelson-assistant-dev/server.log | tail -30
```

Key fields that normally point straight at the failure:
- `haiku classifier` → `type`, `effective_question`, `reply`, `reason`, `historyTurns`
- `leaf picker` → `chose`, `dropped`
- `job completed` → `totalCostUsd`, `numTurns`, `deepResearchCalls`, `lastToolName`
- `haiku classifier JSON parse failed` → `rawOutput`

## 3 · Diagnose + fix

Treat the thread as a mini `/learning` session on a single thread. Walk it from oldest to newest, find the turn that went wrong, decide the failure class (ref `.claude/skills/learning/SKILL.md` step 3), and apply the fix:

- Classifier prompt / schema → `src/agent/classifier.ts`
- Runner system seed → `src/agent/runner.ts`
- Leaf content → `knowledge/nelson/*.yaml` (update `last_db_refresh` when it touches DB-sourced data)
- Picker behaviour → `src/knowledge/picker.ts`
- Pipeline wiring → `src/agent/pipeline.ts`

Apply the fix, then:
```bash
npm run typecheck && npm test
```

Verify the dev server hot-reloaded (tsx watch):
```bash
tail -20 /tmp/nelson-assistant-dev/server.log | grep -E "listening|fatal|error"
```

If the dev server isn't running (or crashed on the reload), start it:
```bash
nohup npm run dev >> /tmp/nelson-assistant-dev/server.log 2>&1 &
```

## 4 · Reply on the Slack thread

Summarise what you changed and what Sandeep should do next. Keep it short — hotel-ops voice, no stack traces, no raw code diffs. Use a HEREDOC so multi-line mrkdwn is clean:

```bash
node scripts/slack-post.js <channel> <threadTs> "$(cat <<'EOF'
:white_check_mark: Fixed.

*Root cause:* <one-line diagnosis>
*Change:* <files touched, one-sentence each>
*Test it:* <concrete retry hint, e.g. "Send the same question again in a fresh thread">

Typecheck clean, tests green, dev server hot-reloaded.
EOF
)"
```

If the fix is more involved (>10 min of work, requires schema changes, new env vars, etc.) post an intermediate status update first so Sandeep sees progress.

## 5 · When to NOT fix and reply instead

Some debug messages are questions, not bug reports. If Sandeep writes `debug what's the current deep_research count for this thread?` — just answer on Slack, no code change. If he writes `debug show me the classifier verdict for my last message` — pull the log + post the relevant fields.

If you cannot safely fix without more context, say so on the thread and ask one clarifying question. Don't guess.

## Authority boundary for this skill

- Dev box only. Never deploys. Never writes to prod infra. Never pushes to remote.
- Edits in `nelson-assistant` are fine (that's the app). Edits in sibling repos are NOT — if the fix requires changes outside nelson-assistant, say so on the thread and stop.
- Reads from Slack via bot token. Posts to Slack thread via bot token. Never sends to DMs Sandeep didn't start.
- The bot log at `/tmp/nelson-assistant-dev/server.log` and chatlog S3 (when available) are the only event sources. Don't go reading mailboxes or other channels.
- This skill does NOT ship in the deployed Docker image. It lives under `.claude/` which is dev-only tooling.
