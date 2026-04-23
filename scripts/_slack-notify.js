// Shared helper for training / analytics jobs to DM the admin (Sandeep by
// default — ESCALATION_SLACK_USER_ID). Used by run-topic-analysis.js and
// any future job that updates frequency maps or training data.
//
// Usage (as a module):
//   const { notifyAdmin } = require('./_slack-notify.js');
//   await notifyAdmin('Topic analysis done: ...');
require('dotenv').config();
const { WebClient } = require('@slack/web-api');

async function notifyAdmin(text) {
  const token = process.env.SLACK_BOT_TOKEN;
  const userId = process.env.ESCALATION_SLACK_USER_ID;
  if (!token) throw new Error('SLACK_BOT_TOKEN not set');
  if (!userId) throw new Error('ESCALATION_SLACK_USER_ID not set');

  const slack = new WebClient(token);
  const im = await slack.conversations.open({ users: userId });
  if (!im.ok || !im.channel || !im.channel.id) {
    throw new Error(`conversations.open failed: ${JSON.stringify(im)}`);
  }
  const res = await slack.chat.postMessage({
    channel: im.channel.id,
    text,
    mrkdwn: true,
  });
  if (!res.ok) throw new Error(`chat.postMessage failed: ${JSON.stringify(res)}`);
  return { channel: im.channel.id, ts: res.ts };
}

module.exports = { notifyAdmin };
