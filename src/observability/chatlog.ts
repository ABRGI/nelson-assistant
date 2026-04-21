import { randomUUID } from 'node:crypto';
import type { JsonStore } from '../state/types.js';
import { logger } from './logger.js';

export type ChatLogEventKind =
  | 'message_received'
  | 'classifier_verdict'
  | 'api_call'
  | 'tool_use'
  | 'agent_reply'
  | 'reaction_swap'
  | 'escalation'
  | 'user_feedback'
  | 'error';

export interface ChatLogEvent {
  eventId: string;
  eventTs: string; // ISO 8601
  kind: ChatLogEventKind;
  threadTs: string;
  channel: string;
  slackUserId: string;
  tenantId?: string;
  detail: Record<string, unknown>;
}

/**
 * Append-only per-thread event log. Each event is one S3 object under
 *   chatlog/<yyyy-mm-dd>/<thread_ts>/<eventTs>-<eventId>.json
 * so Object Lock on the `chatlog/` prefix locks individual events.
 *
 * Never blocks the caller. Errors are logged and swallowed so an S3 outage
 * cannot break the pipeline.
 */
export class ChatLog {
  constructor(
    private readonly store: JsonStore,
    private readonly enabled: boolean,
  ) {}

  append(event: Omit<ChatLogEvent, 'eventId' | 'eventTs'>): void {
    if (!this.enabled) return;
    const full: ChatLogEvent = {
      eventId: randomUUID(),
      eventTs: new Date().toISOString(),
      ...event,
    };
    const date = full.eventTs.slice(0, 10);
    const key = `chatlog/${date}/${full.threadTs}/${full.eventTs}-${full.eventId}.json`;
    void this.store.putJson(key, full).catch((err) => {
      logger.warn({ err, key, kind: full.kind }, 'chatlog write failed');
    });
  }
}
