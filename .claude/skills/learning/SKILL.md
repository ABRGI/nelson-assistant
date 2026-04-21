---
name: learning
description: Run a Nelson Assistant learning session — pull flagged chat-log events from S3 (low confidence scores, user feedback, escalations), walk Sandeep through each failure, propose a knowledge-graph or code fix, and apply it. Never runs over Slack; only in a Claude Code session like this one.
---

# /learning

Reviews Nelson Assistant's flagged chat-log events and turns them into concrete graph / code fixes. This is the Phase D loop in the chat-log → confidence → feedback → learning program.

**Hard rule:** this skill only runs in a Claude Code session (like this one), **never over Slack**. Slack is where the bot answers questions; the learning session is where Sandeep and I review where it got things wrong and fix the source.

## 0 · Inputs

Ask (use sensible defaults — don't over-prompt):

1. **Window**: last `24h`, `7d`, `30d`, or a date range. Default `24h`.
2. **Filters**: any of `low_confidence` (score <7), `user_feedback` (👎 reaction, slash command, or heuristic match), `escalation`, `error`. Default: all of them.
3. **Max threads to review this session**: default 10. Quality > quantity.

## 1 · Pull flagged events

The chat log lives in the state bucket under `chatlog/<yyyy-mm-dd>/<thread_ts>/<eventTs>-<eventId>.json`.

```bash
AWS_PROFILE=nelson aws s3 ls s3://nelsonassistant-nelson-assistant-state/chatlog/<yyyy-mm-dd>/ --recursive --region eu-central-1
```

Fetch files for the window. For each thread directory, read all event files and materialise the thread timeline in memory:

- `message_received` → user's question
- `classifier_verdict` → conversational vs data_query + reason
- `tool_use` / `api_call` → what the agent did
- `agent_reply` → final text + confidence{score, hedges} + toolsUsed
- `user_feedback` → sentiment + source + optional comment
- `escalation` / `error` → anything that derailed

Filter: keep threads where any of these is true:
- `agent_reply.confidence.score < 7`
- any `user_feedback` event with sentiment=`negative`
- any `escalation` event not originating from a destructive-intent match (those are intended escalations, not failures)
- any `error` event

Sort flagged threads by worst-first: lowest score, then most recent negative feedback, then error count. Cap at `max threads` from Step 0.

## 2 · Walk each flagged thread with Sandeep

For each flagged thread in the list, print a concise summary block:

```
=== Thread <thread_ts> in <channel> — flagged reason(s): <low_confidence score=2/10, user_feedback: negative reaction> ===
User: <question>
Classifier: <data_query | conversational>  (<durationMs> ms)
Tools used: <compact list or 'none'>
Reply (truncated): <first 400 chars>
Hedges: <comma-separated>
Feedback: <sentiment + source + comment if present>
```

Ask Sandeep one of: `fix` / `skip` / `revisit` / `stop`.

- **fix** → proceed to Step 3 for this thread.
- **skip** → move to the next thread, note it in the end-of-session summary.
- **revisit** → queue it for the next learning session.
- **stop** → jump to Step 5.

## 3 · Propose a fix

For the current thread, read the assistant's reply carefully and identify the failure mode:

- **Hallucinated citation** (no tool_use → Read of the cited file): tighten the runner system prompt OR add a business-rules.yaml entry that makes the answer unambiguous.
- **Wrong endpoint chosen** (agent hit legacy path, graph has the new one): update the relevant `tasks.yaml` entry to mark the old path as deprecated + add a bugs.yaml entry for the 405.
- **Wrong hotel identifier** (label↔id mix-up): update `hotel-identity.yaml` with the specific endpoint that was misused.
- **Missing business rule**: add a new entry under the right category in `business-rules.yaml` with source_file + line range. Verify by Reading the actual code.
- **Policy enforcement confusion** (user expected X; Nelson enforces Y): update the rule in `business-rules.yaml` AND add a support-playbooks.yaml entry with the recognise_phrases + reply_template.
- **Prompt-level anti-pattern** (e.g. Sonnet still skipping graph): tighten the runner system prompt.
- **Response-shape misread** (agent reported wrong field): update `response-shapes.yaml` with the specific field path.

Propose **ONE** concrete diff per thread. Show it in a ```diff``` block, plus which repo + branch it lands on (nelson → develop, or nelson-assistant → main). Explain in one sentence why this fix prevents the failure class, not just the specific instance.

Ask: `apply` / `modify` / `drop`. Never apply without explicit ack.

## 4 · Apply

On `apply`:
- For graph changes: edit the target `.claude/knowledge/**.yaml` file in the relevant repo (nelson usually).
- For prompt/code changes: edit `nelson-assistant/src/agent/runner.ts` or `nelson-assistant/src/agent/classifier.ts`.
- Typecheck + tests (`npm run typecheck && npm test` in nelson-assistant).
- Commit with author `sandeepbaynes <sandeep.baynes@gmail.com>` and a message that references the thread_ts: `"Learning-session fix for thread <thread_ts>: <one-line summary>"`. Do not push. Sandeep pushes at end of session.

Record in the session log (a running in-memory list): `{threadTs, failureClass, fix, fileTouched, status: applied|modified|dropped}`.

## 5 · End-of-session summary

At `stop` or after the queue is empty:

- Print the session log (threads touched, fixes applied, fixes dropped, threads skipped/revisited).
- Stage and show `git status` + `git diff --stat` across nelson-assistant. If any graph repo was touched, note "commits in <repo>: need to push to develop".
- Remind Sandeep: push happens from his machine, on the release branch conventions (`/refresh-knowledge-graph` skill captures the rule).
- Offer to update ROADMAP.md with a one-line entry for today's learning session.

## Authority boundary for this skill

- Read chat-log events from S3 freely.
- Edit `.claude/knowledge/**` and nelson-assistant source code ONLY after Sandeep's explicit `apply` for each fix.
- Never push. Never call Nelson APIs. Never write to the chat log (that's the bot's job).
- Do NOT run the learning session over Slack. If invoked from a non-Claude-Code context, refuse.
