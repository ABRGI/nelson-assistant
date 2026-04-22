import type { App } from '@slack/bolt';
import type { JobEnqueuer } from '../queue/inproc.js';
import type { ChatLog } from '../observability/chatlog.js';
import { logger } from '../observability/logger.js';
import { DEBUG_USER_PREFIX_RE } from './debug.js';

const THUMB_REACTIONS = new Set([
  '+1', 'thumbsup', 'thumbs_up',          // 👍 variants
  '-1', 'thumbsdown', 'thumbs_down',      // 👎 variants
  'white_check_mark',                      // ✅ (also used by bot's own swap — filtered out below)
  'x',                                     // ❌
]);

function thumbSentiment(name: string): 'positive' | 'negative' | null {
  if (['+1', 'thumbsup', 'thumbs_up', 'white_check_mark'].includes(name)) return 'positive';
  if (['-1', 'thumbsdown', 'thumbs_down', 'x'].includes(name)) return 'negative';
  return null;
}

export function registerEvents(
  app: App,
  enqueue: JobEnqueuer,
  selfUserId: string | undefined,
  chatlog: ChatLog,
): void {
  app.event('app_mention', async ({ event, client }) => {
    const text = stripMention(event.text, selfUserId);
    if (!text) return;
    if (await handleDebugPrefix(client, {
      channel: event.channel,
      threadTs: event.thread_ts ?? event.ts,
      userMessageTs: event.ts,
      userId: event.user ?? 'unknown',
      text,
    })) return;
    enqueue({
      kind: 'ask',
      source: 'mention',
      channel: event.channel,
      userId: event.user ?? 'unknown',
      text,
      threadTs: event.thread_ts ?? event.ts,
      userMessageTs: event.ts,
    });
    try {
      await client.reactions.add({ channel: event.channel, timestamp: event.ts, name: 'hourglass_flowing_sand' });
    } catch (err) {
      logger.debug({ err }, 'failed to add reaction');
    }
  });

  app.message(async ({ message, client }) => {
    if (message.channel_type !== 'im') return;
    // file_share is the subtype Slack uses when a user uploads an image /
    // attachment alongside their message. We still want the text portion to
    // reach the debug-prefix handler so a `debug ... <image>` message doesn't
    // get silently dropped. Other subtypes (message_changed, bot_message,
    // channel_join, etc.) are ignored as before.
    if (message.subtype && message.subtype !== 'file_share') return;
    if (!('text' in message) || !message.text) return;
    const text = message.text.trim();
    if (!text) return;
    if (text.startsWith('/')) return;
    if (await handleDebugPrefix(client, {
      channel: message.channel,
      threadTs: message.thread_ts ?? message.ts,
      userMessageTs: message.ts,
      userId: message.user ?? 'unknown',
      text,
    })) return;
    // For now, file_share messages that are NOT debug-prefixed fall through
    // without hitting the agent — the agent can't see file contents yet.
    if (message.subtype === 'file_share') return;
    enqueue({
      kind: 'ask',
      source: 'dm',
      channel: message.channel,
      userId: message.user ?? 'unknown',
      text,
      threadTs: message.thread_ts ?? message.ts,
      userMessageTs: message.ts,
    });
    try {
      await client.reactions.add({ channel: message.channel, timestamp: message.ts, name: 'hourglass_flowing_sand' });
    } catch (err) {
      logger.debug({ err }, 'failed to add reaction');
    }
  });

  // Human feedback via thumbs up/down on a bot reply. Only react to thumbs
  // placed on messages authored by THIS bot — ignore other reactions and the
  // bot's own reaction-swaps on user messages.
  app.event('reaction_added', async ({ event, client }) => {
    if (event.user === selfUserId) return;
    const name = event.reaction;
    if (!THUMB_REACTIONS.has(name)) return;
    const sentiment = thumbSentiment(name);
    if (!sentiment) return;
    if (event.item.type !== 'message' || !('ts' in event.item) || !('channel' in event.item)) return;

    let isBotReply = false;
    let replyText = '';
    try {
      const res = await client.conversations.history({
        channel: event.item.channel,
        latest: event.item.ts,
        oldest: event.item.ts,
        inclusive: true,
        limit: 1,
      });
      const msg = res.messages?.[0];
      isBotReply = !!msg?.bot_id && msg.user === selfUserId;
      replyText = msg?.text ?? '';
    } catch (err) {
      logger.debug({ err }, 'failed to load reaction target message');
    }
    if (!isBotReply) {
      logger.debug({ user: event.user, reaction: name, targetTs: event.item.ts }, 'reaction ignored — not on bot reply');
      return;
    }

    chatlog.append({
      kind: 'user_feedback',
      threadTs: ('thread_ts' in event.item && typeof event.item.thread_ts === 'string')
        ? event.item.thread_ts
        : event.item.ts,
      channel: event.item.channel,
      slackUserId: event.user,
      detail: {
        source: 'reaction',
        sentiment,
        reaction: name,
        targetTs: event.item.ts,
        targetSnippet: replyText.slice(0, 200),
      },
    });
    logger.info({ sentiment, reaction: name, user: event.user }, 'user feedback captured via reaction');
  });
}

function stripMention(text: string, selfUserId: string | undefined): string {
  if (!selfUserId) return text.trim();
  const mention = `<@${selfUserId}>`;
  return text.replace(mention, '').trim();
}

// "debug <anything>" (case-insensitive, with optional colon / dash after the
// word) short-circuits the bot's normal pipeline. The message is logged as a
// structured event so a Claude Code session monitoring the log can pick it up
// and reply on the thread. The bot itself never tries to answer a debug
// message — it is a channel between Sandeep and the dev-time Claude Code
// agent, not a user query. See src/slack/debug.ts for the shared markers.

interface DebugHandlerInput {
  channel: string;
  threadTs: string;
  userMessageTs: string;
  userId: string;
  text: string;
}

async function handleDebugPrefix(client: import('@slack/web-api').WebClient, input: DebugHandlerInput): Promise<boolean> {
  const match = input.text.match(DEBUG_USER_PREFIX_RE);
  if (!match) return false;
  const intent = (match[1] ?? '').trim();
  logger.info(
    {
      channel: input.channel,
      threadTs: input.threadTs,
      userMessageTs: input.userMessageTs,
      slackUserId: input.userId,
      text: input.text,
      intent,
    },
    'debug message received',
  );
  try {
    await client.reactions.add({ channel: input.channel, timestamp: input.userMessageTs, name: 'construction' });
  } catch (err) {
    logger.debug({ err }, 'failed to add debug reaction');
  }
  return true;
}
