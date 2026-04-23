// CLI wrapper around src/analytics/topics.ts. Embeds user questions in the
// chatlog window, clusters by cosine similarity, persists the report under
// analytics/topics/<date>.json, and optionally DMs Sandeep with a summary.
//
// Usage:
//   node scripts/run-topic-analysis.js [--since=7d] [--save] [--notify]
//     [--min-cluster-size=2] [--similarity-threshold=0.78]
//
// The --notify flag DMs ESCALATION_SLACK_USER_ID via SLACK_BOT_TOKEN.
require('dotenv').config();
const path = require('path');
const { pathToFileURL } = require('url');

async function main() {
  const args = process.argv.slice(2);
  const since = (args.find((a) => a.startsWith('--since=')) ?? '--since=7d').split('=')[1];
  const save = args.includes('--save');
  const notify = args.includes('--notify');
  const threshold = num(args.find((a) => a.startsWith('--similarity-threshold=')), 0.78);
  const minClusterSize = num(args.find((a) => a.startsWith('--min-cluster-size=')), 2);

  const ms = parseSince(since);
  const from = new Date(Date.now() - ms);
  const to = new Date();

  const tsxReq = require('tsx/cjs/api');
  const { FsJsonStore } = tsxReq.require(pathToFileURL(path.resolve('src/state/fs.ts')).href, __filename);
  const { TitanEmbedder } = tsxReq.require(pathToFileURL(path.resolve('src/agent/embed.ts')).href, __filename);
  const { buildTopicReport, saveTopicReport } = tsxReq.require(pathToFileURL(path.resolve('src/analytics/topics.ts')).href, __filename);
  const { BedrockRuntimeClient } = require('@aws-sdk/client-bedrock-runtime');
  const { fromNodeProviderChain } = require('@aws-sdk/credential-providers');

  const stateRoot = process.env.LOCAL_STATE_ROOT ?? './.local-state';
  const store = new FsJsonStore(path.join(stateRoot, 'state'));

  const region = process.env.AWS_REGION ?? 'eu-central-1';
  const profile = process.env.AWS_PROFILE;
  const client = new BedrockRuntimeClient({
    region,
    ...(profile ? { credentials: fromNodeProviderChain({ profile }) } : {}),
  });
  const modelId = process.env.BEDROCK_EMBEDDING_MODEL_ID ?? 'amazon.titan-embed-text-v2:0';
  const embedder = new TitanEmbedder({ modelId, client });

  const report = await buildTopicReport(
    { store, embedder },
    {
      fromIso: from.toISOString(),
      toIso: to.toISOString(),
      model: modelId,
      similarityThreshold: threshold,
      minClusterSize,
    },
  );

  console.log(JSON.stringify(report, null, 2));

  const top5 = report.clusters.slice(0, 5)
    .map((c, i) => `${i + 1}. ${c.representativeQuestion.slice(0, 80)} (freq=${c.frequency}, size=${c.size})`)
    .join('\n');
  const costUsd = (report.embeddingTokensIn * 0.00000002).toFixed(6);
  const summary = [
    `Topic analysis ${report.window.fromIso.slice(0,10)} → ${report.window.toIso.slice(0,10)}`,
    `Q: ${report.totalQuestions} raw / ${report.uniqueQuestions} unique`,
    `Clusters: ${report.clusters.length} (singletons: ${report.singletons})`,
    `Embeddings: ${report.newEmbeddingsComputed} new / ${report.cacheHits} cached (${report.embeddingTokensIn} tokens, ~$${costUsd})`,
    ``,
    `Top 5:`,
    top5 || '(none)',
  ].join('\n');
  console.error(`\n${summary}`);

  if (save) {
    const key = await saveTopicReport(store, report);
    console.error(`Report saved to ${key}`);
  }

  if (notify) {
    try {
      const { notifyAdmin } = require('./_slack-notify.js');
      await notifyAdmin(`:bar_chart: *Training — topic analysis*\n\`\`\`\n${summary}\n\`\`\``);
      console.error('Slack DM sent to admin.');
    } catch (e) {
      console.error(`Slack notify failed: ${e.message}`);
    }
  }
}

function parseSince(spec) {
  const m = spec.match(/^(\d+)(h|d)$/);
  if (!m) throw new Error(`unparseable --since value: ${spec}`);
  const n = Number(m[1]);
  return m[2] === 'h' ? n * 60 * 60_000 : n * 24 * 60 * 60_000;
}

function num(arg, fallback) {
  if (!arg) return fallback;
  const v = Number(arg.split('=')[1]);
  return Number.isFinite(v) ? v : fallback;
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(2); });
