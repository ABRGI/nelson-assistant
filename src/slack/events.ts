import type { App } from '@slack/bolt';
import type { JobEnqueuer } from '../queue/inproc.js';
import type { ChatLog } from '../observability/chatlog.js';
import { logger } from '../observability/logger.js';

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
    if (message.subtype || message.channel_type !== 'im') return;
    if (!('text' in message) || !message.text) return;
    const text = message.text.trim();
    if (!text) return;
    if (text.startsWith('/')) return;
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
      const res = await client.conversations.replies({ channel: event.item.channel, ts: event.item.ts, limit: 1 });
      const msg = res.messages?.[0];
      isBotReply = !!msg?.bot_id && msg.user === selfUserId;
      replyText = msg?.text ?? '';
    } catch (err) {
      logger.debug({ err }, 'failed to load reaction target message');
    }
    if (!isBotReply) return;

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
