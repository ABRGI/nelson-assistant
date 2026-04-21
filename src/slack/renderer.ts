import type { WebClient } from '@slack/web-api';
import { logger } from '../observability/logger.js';

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
    return new ThreadProgressMessage(slack, channel, res.ts);
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
      await this.slack.chat.update({ channel: this.channel, ts: this.ts, text });
      this.lastFlushAt = Date.now();
    } catch (err) {
      logger.warn({ err }, 'chat.update failed');
    }
    if (this.pendingText !== undefined) void this.scheduleFlush();
  }

  async finalize(text: string): Promise<void> {
    this.pendingText = text;
    await this.flushNow();
  }

  private async flushNow(): Promise<void> {
    while (this.flushing) await new Promise((r) => setTimeout(r, 50));
    const text = this.pendingText;
    this.pendingText = undefined;
    if (text === undefined) return;
    try {
      await this.slack.chat.update({ channel: this.channel, ts: this.ts, text });
      this.lastFlushAt = Date.now();
    } catch (err) {
      logger.warn({ err }, 'final chat.update failed');
    }
  }
}
