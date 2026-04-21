import type { App, RespondFn, SlashCommand } from '@slack/bolt';
import type { UserBindingStore } from '../auth/binding.js';
import type { NonceStore } from '../auth/nonce.js';
import type { JobEnqueuer } from '../queue/inproc.js';
import type { ChatLog } from '../observability/chatlog.js';
import { logger } from '../observability/logger.js';

export interface CommandDeps {
  bindings: UserBindingStore;
  nonces: NonceStore;
  enqueue: JobEnqueuer;
  chatlog: ChatLog;
  authCallbackBaseUrl: string;
}

export function registerCommands(app: App, deps: CommandDeps): void {
  app.command('/nelson', async ({ ack, command, respond }) => {
    await ack();
    await handleAsk(command, respond, deps);
  });

  app.command('/nelson-auth', async ({ ack, command, respond }) => {
    await ack();
    await handleAuth(command, respond, deps);
  });

  app.command('/nelson-help', async ({ ack, respond }) => {
    await ack();
    await respond({
      response_type: 'ephemeral',
      text: [
        '*Nelson Assistant*',
        '`/nelson <question>` — ask Nelson anything. If you\'re not signed in yet, I\'ll reply with a one-time link to sign in once — after that you\'re good.',
        '`/nelson-auth` — (DM only) force a re-auth, e.g. if you want to switch Nelson users or your session has gone stale.',
        '`/nelson-feedback <comment>` — flag a recent reply as wrong or unhelpful. Logged for a human review session.',
        'You can also DM the bot directly — no slash command needed.',
        'Tip: react 👍 / 👎 on any of my replies to teach me which ones were good or bad.',
      ].join('\n'),
    });
  });

  app.command('/nelson-feedback', async ({ ack, command, respond }) => {
    await ack();
    const comment = command.text.trim();
    if (!comment) {
      await respond({
        response_type: 'ephemeral',
        text: 'Add a short note after `/nelson-feedback` about what went wrong. Example: `/nelson-feedback the price was off — I checked MUI and it said €85 not €70`.',
      });
      return;
    }
    deps.chatlog.append({
      kind: 'user_feedback',
      threadTs: command.channel_id,
      channel: command.channel_id,
      slackUserId: command.user_id,
      detail: { source: 'slash_command', sentiment: 'negative', comment },
    });
    logger.info({ slackUserId: command.user_id, comment }, 'user feedback captured via slash command');
    await respond({
      response_type: 'ephemeral',
      text: ':writing_hand: Got it — logged for review. Thanks for the signal.',
    });
  });
}

async function handleAsk(
  command: SlashCommand,
  respond: RespondFn,
  deps: CommandDeps,
): Promise<void> {
  const question = command.text.trim();
  if (!question) {
    await respond({
      response_type: 'ephemeral',
      text: 'Ask me something. Example: `/nelson what hotels am I allowed to see?`',
    });
    return;
  }

  const binding = await deps.bindings.get(command.user_id);
  if (!binding) {
    await issueSignInPrompt(command, respond, deps, 'sign in first');
    return;
  }

  deps.enqueue({
    kind: 'ask',
    source: 'slash',
    channel: command.channel_id,
    userId: command.user_id,
    text: question,
    threadTs: undefined,
    userMessageTs: String(Date.now() / 1000), // slash commands have no message ts; reactions are no-ops
    responseUrl: command.response_url,
  });
}

async function handleAuth(
  command: SlashCommand,
  respond: RespondFn,
  deps: CommandDeps,
): Promise<void> {
  if (command.channel_name !== 'directmessage') {
    await respond({
      response_type: 'ephemeral',
      text: ':warning: For security, `/nelson-auth` only works in a DM with me. Open a DM and try again.',
    });
    return;
  }
  await issueSignInPrompt(command, respond, deps, 're-auth');
}

async function issueSignInPrompt(
  command: SlashCommand,
  respond: RespondFn,
  deps: CommandDeps,
  reason: 'sign in first' | 're-auth',
): Promise<void> {
  try {
    const pending = await deps.nonces.create({ slackUserId: command.user_id });
    const url = buildLoginUrl(deps.authCallbackBaseUrl, pending.nonce);
    const ttlMins = Math.round((pending.expiresAt - pending.createdAt) / 60_000);
    const lead =
      reason === 'sign in first'
        ? ':lock: You need to sign in to Nelson first. Click the button below (valid for ' +
          `${ttlMins} min, single use) — then come back and run your \`/nelson\` again.`
        : `:lock: New Nelson sign-in link (valid ${ttlMins} min, single use).`;
    await respond({
      response_type: 'ephemeral',
      text: lead,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: lead } },
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
              text: 'Enter your Nelson password *on that page only*, never here.',
            },
          ],
        },
      ],
    });
    logger.info({ slackUserId: command.user_id, reason }, 'issued one-time sign-in link');
  } catch (err) {
    logger.error({ err, slackUserId: command.user_id }, 'failed to mint nonce');
    await respond({
      response_type: 'ephemeral',
      text: 'Could not create a sign-in link. Try again in a minute or ping an admin.',
    });
  }
}

function buildLoginUrl(base: string, nonce: string): string {
  const trimmed = base.replace(/\/$/, '');
  return `${trimmed}/auth/login/${encodeURIComponent(nonce)}`;
}
