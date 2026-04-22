// Post a Slack message to a specific channel + thread. Used by the
// debug-session flow so Claude Code can reply on the same thread the user
// pinged with "debug <...>".
//
// Every message is auto-prefixed with "[debug] " so the bot's history loader
// filters it out of the classifier / Sonnet context. That prefix is the
// contract for the dev-time Sandeep↔Claude-Code channel — do not remove it.
//
// Usage:
//   node scripts/slack-post.js <channel> <thread_ts> "<text>"
//   echo "<text>" | node scripts/slack-post.js <channel> <thread_ts>
// Uses SLACK_BOT_TOKEN from .env.
require('dotenv').config();
const { WebClient } = require('@slack/web-api');

const DEBUG_RESPONSE_PREFIX = '[debug]';

async function main() {
  const [channel, threadTs, ...rest] = process.argv.slice(2);
  if (!channel || !threadTs) {
    console.error('usage: node scripts/slack-post.js <channel> <thread_ts> "<text>"');
    process.exit(2);
  }
  let text = rest.join(' ').trim();
  if (!text && !process.stdin.isTTY) {
    text = await new Promise((resolve) => {
      let buf = '';
      process.stdin.on('data', (c) => (buf += c));
      process.stdin.on('end', () => resolve(buf.trim()));
    });
  }
  if (!text) {
    console.error('no text provided');
    process.exit(2);
  }
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error('SLACK_BOT_TOKEN not set');
    process.exit(2);
  }
  const slack = new WebClient(token);
  const prefixed = text.startsWith(DEBUG_RESPONSE_PREFIX) ? text : `${DEBUG_RESPONSE_PREFIX} ${text}`;
  const res = await slack.chat.postMessage({ channel, thread_ts: threadTs, text: prefixed, mrkdwn: true });
  console.log(JSON.stringify({ ok: res.ok, ts: res.ts, channel }, null, 2));
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(2); });
