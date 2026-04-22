import type { WebClient } from '@slack/web-api';
import { logger } from '../observability/logger.js';

// Slack rejects chat.postMessage / chat.update with `msg_too_long` when the
// text exceeds ~40k characters. Keep individual messages well under that so
// block-kit overhead, mrkdwn escaping and emoji expansions don't push us over.
const MAX_CHARS_PER_MESSAGE = 3800;
const CHUNK_CONTINUATION_SUFFIX = '\n\n_(…continued below)_';
const CHUNK_CONTINUATION_PREFIX = '_(…continued from above)_\n\n';

/**
 * Throttled message updater. Agent events fire frequently; Slack rate limits
 * chat.update. Every update call schedules the write; a trailing-edge setTimeout
 * coalesces bursts into <=1 Slack request per `intervalMs`.
 */
export class ThreadProgressMessage {
  private pendingText: string | undefined;
  private flushing = false;
  private lastFlushAt = 0;

  constructor(
    private readonly slack: WebClient,
    private readonly channel: string,
    private readonly ts: string,
    private readonly threadTs: string,
    private readonly intervalMs = 1500,
  ) {}

  static async create(
    slack: WebClient,
    channel: string,
    thread_ts: string,
    initialText: string,
  ): Promise<ThreadProgressMessage> {
    const res = await slack.chat.postMessage({
      channel,
      thread_ts,
      text: initialText,
      mrkdwn: true,
    });
    if (!res.ts) throw new Error('Slack did not return a ts for posted message');
    return new ThreadProgressMessage(slack, channel, res.ts, thread_ts);
  }

  update(text: string): void {
    this.pendingText = text;
    void this.scheduleFlush();
  }

  private async scheduleFlush(): Promise<void> {
    if (this.flushing) return;
    const wait = Math.max(0, this.lastFlushAt + this.intervalMs - Date.now());
    this.flushing = true;
    await new Promise((r) => setTimeout(r, wait));
    const text = this.pendingText;
    this.pendingText = undefined;
    this.flushing = false;
    if (text === undefined) return;
    try {
      // Progress updates during the run are always short ("Reading…",
      // "Thinking…"), so no chunking needed here.
      await this.slack.chat.update({ channel: this.channel, ts: this.ts, text });
      this.lastFlushAt = Date.now();
    } catch (err) {
      logger.warn({ err }, 'chat.update failed');
    }
    if (this.pendingText !== undefined) void this.scheduleFlush();
  }

  async finalize(text: string): Promise<void> {
    this.pendingText = text;
    await this.flushFinal();
  }

  private async flushFinal(): Promise<void> {
    while (this.flushing) await new Promise((r) => setTimeout(r, 50));
    const text = this.pendingText;
    this.pendingText = undefined;
    if (text === undefined) return;
    const chunks = splitForSlack(text);
    const [first, ...rest] = chunks;
    if (!first) return;
    try {
      await this.slack.chat.update({ channel: this.channel, ts: this.ts, text: first });
      this.lastFlushAt = Date.now();
    } catch (err) {
      logger.warn({ err, firstChunkLen: first.length }, 'final chat.update failed');
      return;
    }
    for (const chunk of rest) {
      try {
        await this.slack.chat.postMessage({
          channel: this.channel,
          thread_ts: this.threadTs,
          text: chunk,
          mrkdwn: true,
        });
      } catch (err) {
        logger.warn({ err, chunkLen: chunk.length }, 'continuation chat.postMessage failed');
      }
    }
  }
}

// Split a long reply into <= MAX_CHARS_PER_MESSAGE chunks. Prefer paragraph
// boundaries, then lines, then hard-cut. Adds small "continued" markers so the
// user can see the split.
export function splitForSlack(text: string, max: number = MAX_CHARS_PER_MESSAGE): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let remaining = text;
  // Reserve space for the continuation markers.
  const firstChunkBudget = max - CHUNK_CONTINUATION_SUFFIX.length;
  const midChunkBudget = max - CHUNK_CONTINUATION_SUFFIX.length - CHUNK_CONTINUATION_PREFIX.length;
  const lastChunkBudget = max - CHUNK_CONTINUATION_PREFIX.length;
  let isFirst = true;
  while (remaining.length > 0) {
    const isLast = remaining.length <= (isFirst ? firstChunkBudget : lastChunkBudget);
    const budget = isFirst ? (isLast ? max : firstChunkBudget)
                           : (isLast ? lastChunkBudget : midChunkBudget);
    let cut = Math.min(budget, remaining.length);
    if (cut < remaining.length) {
      const paraBreak = remaining.lastIndexOf('\n\n', cut);
      if (paraBreak > cut * 0.6) cut = paraBreak;
      else {
        const lineBreak = remaining.lastIndexOf('\n', cut);
        if (lineBreak > cut * 0.6) cut = lineBreak;
      }
    }
    let chunk = remaining.slice(0, cut).trimEnd();
    remaining = remaining.slice(cut).trimStart();
    if (!isFirst) chunk = `${CHUNK_CONTINUATION_PREFIX}${chunk}`;
    if (remaining.length > 0) chunk = `${chunk}${CHUNK_CONTINUATION_SUFFIX}`;
    chunks.push(chunk);
    isFirst = false;
  }
  return chunks;
}
