import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { UserBindingStore } from '../auth/binding.js';
import type { ClientRegistry, ClientRecord } from '../auth/clients.js';
import { CognitoExchanger, RefreshTokenInvalid } from '../auth/cognito.js';
import type { NonceStore } from '../auth/nonce.js';
import type { AskJob, JobHandler } from '../queue/inproc.js';
import type { WorktreePool } from '../worktree/pool.js';
import { logger } from '../observability/logger.js';
import type { ChatLog } from '../observability/chatlog.js';
import { ThreadProgressMessage } from '../slack/renderer.js';
import { loadConversationHistory, renderHistoryForAgentPrompt } from '../slack/history.js';
import type { HaikuClassifier } from './classifier.js';
import { runAgent } from './runner.js';

export interface PipelineDeps {
  app: App;
  bindings: UserBindingStore;
  clients: ClientRegistry;
  cognito: CognitoExchanger;
  nonces: NonceStore;
  worktrees: WorktreePool;
  classifier: HaikuClassifier;
  chatlog: ChatLog;
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
    const logEvent = (kind: Parameters<ChatLog['append']>[0]['kind'], detail: Record<string, unknown>, tenantId?: string): void =>
      deps.chatlog.append({
        kind,
        threadTs,
        channel: job.channel,
        slackUserId: job.userId,
        ...(tenantId ? { tenantId } : {}),
        detail,
      });
    logEvent('message_received', { source: job.source, text: job.text, userMessageTs: job.userMessageTs });

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

    const history = await loadConversationHistory(slack, {
      channel: job.channel,
      source: job.source,
      threadTs: job.threadTs,
      ...(job.threadTs ? { excludeTs: job.threadTs } : {}),
    });

    // Kick off the Cognito refresh alongside the classifier so the ~200-500ms
    // exchange overlaps with Haiku. We discard the result on the conversational
    // branch; refresh tokens are reusable so the "extra" call is harmless.
    const tokensSettled = (async () => deps.cognito.exchangeRefresh(
      job.userId,
      binding.nelsonSub,
      await deps.bindings.readRefreshToken(binding),
    ))().then(
      (t) => ({ ok: true as const, tokens: t }),
      (err: unknown) => ({ ok: false as const, err }),
    );

    const verdict = await deps.classifier.classify(job.text, history);
    logEvent('classifier_verdict', verdict.type === 'conversational'
      ? { type: 'conversational', reply: verdict.reply }
      : { type: 'data_query', ...(verdict.reason ? { reason: verdict.reason } : {}) });
    if (verdict.type === 'conversational') {
      await tokensSettled;
      await slack.chat.postMessage({
        channel: job.channel,
        thread_ts: threadTs,
        text: verdict.reply,
        mrkdwn: true,
      });
      await swapReaction(slack, job, looksLikeQuestion(verdict.reply) ? 'question' : 'white_check_mark');
      logEvent('agent_reply', { path: 'conversational', reply: verdict.reply });
      logger.info({ slackUserId: job.userId, reason: 'conversational' }, 'job completed (no agent run)');
      return;
    }

    // Create the progress message immediately on the data-query branch so the
    // user sees motion during token refresh + worktree checkout (worktree is
    // cold + slow on the first query after an ECS task restart — easily 60s).
    const progress = await ThreadProgressMessage.create(
      slack,
      job.channel,
      threadTs,
      ':thinking_face: On it…',
    );

    let tenant: ClientRecord;
    try {
      tenant = deps.resolveTenant();
    } catch (err) {
      await swapReaction(slack, job, 'x');
      await progress.finalize(`:x: ${(err as Error).message}`);
      return;
    }

    progress.update(':key: Checking your Nelson session…');
    const tokenResult = await tokensSettled;
    if (!tokenResult.ok) {
      const err = tokenResult.err;
      if (err instanceof RefreshTokenInvalid) {
        logger.info({ slackUserId: job.userId }, 'refresh token rejected, prompting re-auth');
        await swapReaction(slack, job, 'question');
        await progress.finalize('Your Nelson session expired.');
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
      await progress.finalize(`I couldn't refresh your Nelson session: ${(err as Error).message}`);
      return;
    }
    const tokens = tokenResult.tokens;

    const question = renderHistoryForAgentPrompt(history, job.text);

    progress.update(':package: Setting up your workspace…');
    const lease = await deps.worktrees.acquire(deps.defaultProject, deps.defaultBranch);
    progress.update(':brain: Thinking through your question…');
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
                progress.update(describeToolActivity(block.name, block.input));
                logEvent('tool_use', { name: block.name, input: block.input }, tenant.tenantId);
                if (block.name === 'mcp__nelson__escalate_to_human') {
                  escalated = true;
                  logEvent('escalation', { reason: 'agent_invoked_tool', input: block.input }, tenant.tenantId);
                }
              }
            }
          }
        },
      });
      const finalText = result.finalText?.trim() || 'Done.';
      await progress.finalize(finalText);
      const needsInput = escalated || looksLikeQuestion(finalText);
      await swapReaction(slack, job, needsInput ? 'question' : 'white_check_mark');
      logEvent('agent_reply', {
        path: 'data_query',
        reply: finalText,
        lastToolName,
        stopReason: result.stopReason,
        sessionId: result.sessionId,
        needsInput,
      }, tenant.tenantId);
      logger.info(
        { tenantId: tenant.tenantId, project: deps.defaultProject, lastToolName, stopReason: result.stopReason },
        'job completed',
      );
      await deps.bindings.markUsed(job.userId).catch(() => undefined);
    } catch (err) {
      logger.error({ err }, 'agent run failed');
      await swapReaction(slack, job, 'x');
      logEvent('error', { stage: 'agent_run', message: (err as Error).message }, tenant.tenantId);
      await progress.finalize(
        `:x: Something went wrong and I couldn't complete your request.\n\`\`\`${(err as Error).message}\`\`\`\nPlease contact <@${deps.escalationSlackUserId}> for help.`,
      );
    } finally {
      await lease.release();
    }
  };
}

const TOOL_LABELS: Record<string, string> = {
  mcp__nelson__escalate_to_human: ':raising_hand: Looping in a human teammate…',
  mcp__nelson__git_log: ':mag: Checking recent code changes…',
  mcp__nelson__psql: ':floppy_disk: Querying the Nelson database…',
  Read: ':books: Checking the Nelson documentation…',
  Grep: ':books: Checking the Nelson documentation…',
  Glob: ':books: Checking the Nelson documentation…',
  Task: ':brain: Working through the next step…',
  Bash: ':hammer_and_wrench: Running a check…',
};

const NELSON_API_PATH_LABELS: Array<[RegExp, string]> = [
  [/\/availability/, 'Checking availability'],
  [/\/prices/, 'Looking up pricing'],
  [/\/reservations\/arrivals/, "Checking today's arrivals"],
  [/\/reservations/, 'Looking up reservations'],
  [/\/hotels/, 'Looking up hotels'],
  [/\/rooms/, 'Looking up rooms'],
  [/\/(guests|customers)/, 'Looking up guests'],
  [/\/reports/, 'Fetching a report'],
  [/\/config/, 'Reading configuration'],
];

function describeToolActivity(toolName: string, input: unknown): string {
  if (toolName === 'mcp__nelson__nelson_api') {
    const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const method = typeof i['method'] === 'string' ? i['method'] : 'GET';
    const path = typeof i['path'] === 'string' ? i['path'] : '';
    const matched = NELSON_API_PATH_LABELS.find(([re]) => re.test(path.toLowerCase()));
    const label = matched ? matched[1] : 'Calling the Nelson API';
    return `:satellite_antenna: ${label} (${method} ${path})`;
  }
  return TOOL_LABELS[toolName] ?? ':hourglass_flowing_sand: Working on it…';
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
