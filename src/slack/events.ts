import type { App } from '@slack/bolt';
import type { JobEnqueuer } from '../queue/inproc.js';
import { logger } from '../observability/logger.js';

export function registerEvents(app: App, enqueue: JobEnqueuer, selfUserId: string | undefined): void {
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
    // Skip if it looks like a slash command echo
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
}

function stripMention(text: string, selfUserId: string | undefined): string {
  if (!selfUserId) return text.trim();
  const mention = `<@${selfUserId}>`;
  return text.replace(mention, '').trim();
}
