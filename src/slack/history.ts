import type { WebClient } from '@slack/web-api';
import type { AskJob } from '../queue/inproc.js';
import { logger } from '../observability/logger.js';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface HistoryRequest {
  channel: string;
  source: AskJob['source'];
  threadTs: string | undefined;
  excludeTs?: string;
  limit?: number;
}

export async function loadConversationHistory(
  slack: WebClient,
  req: HistoryRequest,
): Promise<ConversationTurn[]> {
  try {
    const limit = req.limit ?? 20;
    let raw: { bot_id?: string; text?: string; ts?: string; subtype?: string }[];

    if (req.source === 'mention') {
      if (!req.threadTs) return [];
      const res = await slack.conversations.replies({ channel: req.channel, ts: req.threadTs, limit });
      raw = (res.messages ?? []).filter((m) => 'text' in m && m.text);
    } else {
      const res = await slack.conversations.history({ channel: req.channel, limit });
      raw = (res.messages ?? []).filter((m) => !m.subtype && 'text' in m && m.text).reverse();
    }

    return raw
      .filter((m) => m.ts !== req.excludeTs && m.ts !== req.threadTs)
      .map((m) => ({
        role: m.bot_id ? ('assistant' as const) : ('user' as const),
        text: (m.text ?? '').trim(),
      }))
      .filter((t) => t.text.length > 0);
  } catch (err) {
    logger.warn({ err }, 'failed to load conversation history');
    return [];
  }
}

export function roleLabel(turn: ConversationTurn): string {
  return turn.role === 'assistant' ? 'Nelson Assistant' : 'User';
}

export function formatTurns(turns: ConversationTurn[]): string {
  return turns.map((t) => `${roleLabel(t)}: ${t.text}`).join('\n');
}

export function renderHistoryForAgentPrompt(
  turns: ConversationTurn[],
  newMessage: string,
): string {
  if (turns.length === 0) return newMessage;
  return `Previous conversation:\n${formatTurns(turns)}\n\nNew message: ${newMessage}`;
}
