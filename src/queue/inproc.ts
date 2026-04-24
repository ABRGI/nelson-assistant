import pLimit from 'p-limit';
import { logger } from '../observability/logger.js';

export interface AskJob {
  kind: 'ask';
  source: 'slash' | 'mention' | 'dm' | 'thread-follow-up';
  channel: string;
  userId: string;
  text: string;
  threadTs: string | undefined;
  userMessageTs: string;  // ts of the user's message — used to swap reactions
  responseUrl?: string;
  attachments?: import('../slack/attachments.js').SlackFile[];
}

export type JobEnqueuer = (job: AskJob) => void;

export type JobHandler = (job: AskJob) => Promise<void>;

export type ErrorPoster = (channel: string, threadTs: string | undefined, message: string) => Promise<void>;

export class InProcQueue {
  private readonly limiter: ReturnType<typeof pLimit>;
  private inFlight = 0;

  constructor(
    concurrency: number,
    private readonly postError?: ErrorPoster,
  ) {
    this.limiter = pLimit(concurrency);
  }

  create(handler: JobHandler): JobEnqueuer {
    return (job: AskJob) => {
      this.inFlight++;
      void this.limiter(async () => {
        try {
          await handler(job);
        } catch (err) {
          logger.error({ err, job }, 'job handler threw');
          if (this.postError) {
            await this.postError(
              job.channel,
              job.threadTs,
              `:x: An unexpected error occurred and I couldn't complete your request.\n\`\`\`${(err as Error).message}\`\`\``,
            ).catch(() => undefined);
          }
        } finally {
          this.inFlight--;
        }
      });
    };
  }

  size(): number {
    return this.inFlight;
  }
}
