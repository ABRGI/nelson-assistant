import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { UserBindingStore } from '../auth/binding.js';
import type { ClientRegistry, ClientRecord } from '../auth/clients.js';
import { CognitoExchanger, RefreshTokenInvalid } from '../auth/cognito.js';
import type { NonceStore } from '../auth/nonce.js';
import type { AskJob, JobHandler } from '../queue/inproc.js';
import type { WorktreePool } from '../worktree/pool.js';
import { logger } from '../observability/logger.js';
import { ThreadProgressMessage } from '../slack/renderer.js';
import { runAgent } from './runner.js';

export interface PipelineDeps {
  app: App;
  bindings: UserBindingStore;
  clients: ClientRegistry;
  cognito: CognitoExchanger;
  nonces: NonceStore;
  worktrees: WorktreePool;
  defaultProject: string;
  defaultBranch: string;
  sonnetModelId: string;
  psqlReadOnlyUrl?: string;
  escalationSlackUserId: string;
  authCallbackBaseUrl: string;
  resolveTenant: () => ClientRecord;
}

export function makeHandler(deps: PipelineDeps): JobHandler {
  return async (job: AskJob) => {
    const slack = deps.app.client;
    const threadTs = job.threadTs ?? (await postRoot(deps.app, job)).ts;

    const binding = await deps.bindings.get(job.userId);
    if (!binding) {
      await swapReaction(slack, job, 'question');
      await postSignInPrompt(
        deps,
        job.channel,
        threadTs,
        job.userId,
        "You're not signed in to Nelson yet.",
      );
      return;
    }

    let tenant: ClientRecord;
    try {
      tenant = deps.resolveTenant();
    } catch (err) {
      await swapReaction(slack, job, 'x');
      await slack.chat.postMessage({
        channel: job.channel,
        thread_ts: threadTs,
        text: `:x: ${(err as Error).message}`,
      });
      return;
    }

    let tokens;
    try {
      const refreshToken = await deps.bindings.readRefreshToken(binding);
      tokens = await deps.cognito.exchangeRefresh(job.userId, binding.nelsonSub, refreshToken);
    } catch (err) {
      if (err instanceof RefreshTokenInvalid) {
        logger.info({ slackUserId: job.userId }, 'refresh token rejected, prompting re-auth');
        await swapReaction(slack, job, 'question');
        await postSignInPrompt(
          deps,
          job.channel,
          threadTs,
          job.userId,
          'Your Nelson session expired. Sign in again to continue.',
        );
        return;
      }
      logger.warn({ err, slackUserId: job.userId }, 'token exchange failed');
      await swapReaction(slack, job, 'x');
      await slack.chat.postMessage({
        channel: job.channel,
        thread_ts: threadTs,
        text: `I couldn't refresh your Nelson session: ${(err as Error).message}`,
      });
      return;
    }

    const progress = await ThreadProgressMessage.create(
      slack,
      job.channel,
      threadTs,
      ':thinking_face: On it…',
    );

    const question = await buildQuestion(slack, job);

    const lease = await deps.worktrees.acquire(deps.defaultProject, deps.defaultBranch);
    try {
      let lastToolName: string | undefined;
      let escalated = false;
      const result = await runAgent({
        cwd: lease.dir,
        project: deps.defaultProject,
        tenant,
        tokens,
        askerSlackUserId: job.userId,
        question,
        channel: job.channel,
        threadTs,
        slack,
        escalationSlackUserId: deps.escalationSlackUserId,
        sonnetModelId: deps.sonnetModelId,
        ...(deps.psqlReadOnlyUrl ? { psqlReadOnlyUrl: deps.psqlReadOnlyUrl } : {}),
        onEvent: (event) => {
          if (event.type === 'assistant') {
            for (const block of event.message.content) {
              if (block.type === 'tool_use') {
                lastToolName = block.name;
                progress.update(`:gear: running \`${block.name}\`…`);
                if (block.name === 'mcp__nelson__escalate_to_human') escalated = true;
              }
            }
          }
        },
      });
      const finalText = result.finalText?.trim() || 'Done.';
      await progress.finalize(finalText);
      const needsInput = escalated || looksLikeQuestion(finalText);
      await swapReaction(slack, job, needsInput ? 'question' : 'white_check_mark');
      logger.info(
        { tenantId: tenant.tenantId, project: deps.defaultProject, lastToolName, stopReason: result.stopReason },
        'job completed',
      );
      await deps.bindings.markUsed(job.userId).catch(() => undefined);
    } catch (err) {
      logger.error({ err }, 'agent run failed');
      await swapReaction(slack, job, 'x');
      await progress.finalize(
        `:x: Something went wrong and I couldn't complete your request.\n\`\`\`${(err as Error).message}\`\`\`\nPlease contact <@${deps.escalationSlackUserId}> for help.`,
      );
    } finally {
      await lease.release();
    }
  };
}

function looksLikeQuestion(text: string): boolean {
  const trimmed = text.trim().replace(/[`*_~]+$/, '').trimEnd();
  return trimmed.endsWith('?');
}

async function swapReaction(slack: WebClient, job: AskJob, next: string): Promise<void> {
  try {
    await slack.reactions.remove({ channel: job.channel, timestamp: job.userMessageTs, name: 'hourglass_flowing_sand' });
  } catch { /* already removed or never added */ }
  try {
    await slack.reactions.add({ channel: job.channel, timestamp: job.userMessageTs, name: next });
  } catch (err) {
    logger.debug({ err }, 'failed to add outcome reaction');
  }
}

async function buildQuestion(slack: WebClient, job: AskJob): Promise<string> {
  try {
    let msgs: { bot_id?: string; text?: string; ts?: string }[];

    if (job.source === 'dm') {
      // DMs: load channel history (newest first → reverse for chronological order)
      const res = await slack.conversations.history({
        channel: job.channel,
        limit: 20,
      });
      msgs = (res.messages ?? [])
        .filter((m) => !m.subtype && 'text' in m && m.text && m.ts !== job.threadTs)
        .reverse();
    } else {
      // Mentions in channels: load thread replies
      if (!job.threadTs) return job.text;
      const res = await slack.conversations.replies({
        channel: job.channel,
        ts: job.threadTs,
        limit: 20,
      });
      msgs = (res.messages ?? []).filter(
        (m) => m.ts !== job.threadTs && 'text' in m && m.text,
      );
    }

    if (!msgs.length) return job.text;
    const history = msgs
      .map((m) => {
        const role = m.bot_id ? 'Nelson Assistant' : 'User';
        return `${role}: ${m.text}`;
      })
      .join('\n');
    return `Previous conversation:\n${history}\n\nNew message: ${job.text}`;
  } catch (err) {
    logger.warn({ err }, 'failed to load conversation history');
    return job.text;
  }
}

async function postRoot(app: App, job: AskJob): Promise<{ ts: string }> {
  const res = await app.client.chat.postMessage({
    channel: job.channel,
    text: `<@${job.userId}> asked: ${job.text}`,
  });
  if (!res.ts) throw new Error('Slack did not return a ts for root message');
  return { ts: res.ts };
}

async function postSignInPrompt(
  deps: Pick<PipelineDeps, 'app' | 'nonces' | 'authCallbackBaseUrl'>,
  channel: string,
  threadTs: string,
  slackUserId: string,
  lead: string,
): Promise<void> {
  try {
    const pending = await deps.nonces.create({ slackUserId });
    const url = `${deps.authCallbackBaseUrl.replace(/\/$/, '')}/auth/login/${encodeURIComponent(pending.nonce)}`;
    const ttlMins = Math.round((pending.expiresAt - pending.createdAt) / 60_000);
    const text = `${lead} Click to sign in (valid ${ttlMins} min, single use): ${url}`;
    await deps.app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `${lead} Link valid for ${ttlMins} min, single use.` } },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Sign in to Nelson' },
              style: 'primary',
              url,
              action_id: 'nelson_auth_link',
            },
          ],
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: 'Enter your Nelson password *on that page only*, never here. Ask again after you see the "Linked" DM.',
            },
          ],
        },
      ],
    });
  } catch (err) {
    logger.error({ err, slackUserId }, 'failed to post sign-in prompt');
    await deps.app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: 'You need to sign in, but I could not create a link. Try again in a minute.',
    });
  }
}
