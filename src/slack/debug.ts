// Prefixes that mark a message as part of the dev-time debug channel between
// Sandeep and Claude Code. These messages are short-circuited by the bot's
// event handlers AND filtered out of the classifier / Sonnet history so the
// production model never sees them.
//
// User side:  "debug <anything>"      (case-insensitive, optional colon/dash)
// Bot side:   "[debug] <anything>"    (stable marker on every Claude Code reply)
//
// Keep the markers here so the two directions stay in sync.

export const DEBUG_USER_PREFIX_RE = /^\s*debug\b[\s:,\-—]*(.*)$/is;
export const DEBUG_RESPONSE_PREFIX = '[debug]';

export function isDebugMessageText(text: string): boolean {
  if (!text) return false;
  if (DEBUG_USER_PREFIX_RE.test(text)) return true;
  if (text.trimStart().startsWith(DEBUG_RESPONSE_PREFIX)) return true;
  return false;
}
