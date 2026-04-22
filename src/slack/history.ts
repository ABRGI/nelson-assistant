import type { WebClient } from '@slack/web-api';
import type { AskJob } from '../queue/inproc.js';
import { logger } from '../observability/logger.js';
import { isDebugMessageText } from './debug.js';

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
    // Default fetches the full thread. Slack's conversations.replies caps at
    // 1000 per page; 200 covers essentially every support thread while keeping
    // token cost bounded. Callers can override if they want something else.
    const limit = req.limit ?? 200;
    let raw: { bot_id?: string; text?: string; ts?: string; subtype?: string }[];

    if (req.threadTs) {
      // Scope history to just this thread — works for both mentions and DMs.
      // Using conversations.history for DMs used to pull the entire channel
      // back to forever, leaking hours-old unrelated questions into the
      // classifier and polluting context.
      const res = await slack.conversations.replies({ channel: req.channel, ts: req.threadTs, limit });
      raw = (res.messages ?? []).filter((m) => 'text' in m && m.text);
    } else {
      // No thread context (very first top-level DM, no replies yet). Pull the
      // most recent channel messages as a best-effort fallback.
      const res = await slack.conversations.history({ channel: req.channel, limit });
      raw = (res.messages ?? []).filter((m) => !m.subtype && 'text' in m && m.text).reverse();
    }

    return raw
      .filter((m) => m.ts !== req.excludeTs)
      .map((m) => ({
        role: m.bot_id ? ('assistant' as const) : ('user' as const),
        text: (m.text ?? '').trim(),
      }))
      // Drop debug-channel messages — they're Sandeep ↔ Claude Code dev
      // conversation, not user ↔ bot, and the classifier/Sonnet must never
      // see them.
      .filter((t) => t.text.length > 0 && !isDebugMessageText(t.text));
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
