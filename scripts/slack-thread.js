// Fetch a Slack thread as plain text. Used by the debug-session flow when
// Claude Code picks up a "debug <...>" message from the bot log and needs to
// see the full prior conversation before diagnosing.
//
// Usage:
//   node scripts/slack-thread.js <channel> <thread_ts>
// Uses SLACK_BOT_TOKEN from .env.
require('dotenv').config();
const { WebClient } = require('@slack/web-api');

async function main() {
  const [channel, threadTs] = process.argv.slice(2);
  if (!channel || !threadTs) {
    console.error('usage: node scripts/slack-thread.js <channel> <thread_ts>');
    process.exit(2);
  }
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error('SLACK_BOT_TOKEN not set');
    process.exit(2);
  }
  const slack = new WebClient(token);
  const res = await slack.conversations.replies({ channel, ts: threadTs, limit: 200 });
  const msgs = (res.messages ?? []).filter((m) => 'text' in m && m.text);
  for (const m of msgs) {
    const who = m.bot_id ? 'Nelson' : `user:${m.user ?? '?'}`;
    const ts = m.ts ?? '';
    console.log(`[${ts}] ${who}: ${(m.text ?? '').replace(/\n/g, '\n  ')}`);
  }
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(2); });
