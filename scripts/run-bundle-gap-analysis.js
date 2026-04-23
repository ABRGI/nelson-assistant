// CLI wrapper around src/analytics/bundle-gap.ts. Runs a rollup over the
// chatlog in the fs store (dev) or the S3 store (prod — point config at S3
// via STORAGE_MODE=s3) and prints the report + optionally persists it.
//
// Usage:
//   node scripts/run-bundle-gap-analysis.js [--since=24h|7d|30d] [--save]
require('dotenv').config();
const path = require('path');
const { pathToFileURL } = require('url');

async function main() {
  const args = process.argv.slice(2);
  const since = (args.find((a) => a.startsWith('--since=')) ?? '--since=24h').split('=')[1];
  const save = args.includes('--save');

  const ms = parseSince(since);
  const from = new Date(Date.now() - ms);
  const to = new Date();

  // Dynamic import the ESM module from the CJS script.
  const fsStoreUrl = pathToFileURL(path.resolve('src/state/fs.ts')).href;
  const tsxReq = require('tsx/cjs/api');
  const { FsJsonStore } = tsxReq.require(fsStoreUrl, __filename);
  const { buildBundleGapReport, saveBundleGapReport } = tsxReq.require(pathToFileURL(path.resolve('src/analytics/bundle-gap.ts')).href, __filename);

  const stateRoot = process.env.LOCAL_STATE_ROOT ?? './.local-state';
  const store = new FsJsonStore(path.join(stateRoot, 'state'));

  const report = await buildBundleGapReport(store, { fromIso: from.toISOString(), toIso: to.toISOString() });
  console.log(JSON.stringify(report, null, 2));

  console.error(`\nSummary: ${report.totalThreads} threads, ${report.flaggedThreads.length} flagged, ${report.deepResearchSummary.totalTriggers} deep_research triggers, $${report.costSummary.totalUsd.toFixed(2)} total cost.`);

  if (save) {
    const key = await saveBundleGapReport(store, report);
    console.error(`Report saved to ${key}`);
  }
}

function parseSince(spec) {
  const m = spec.match(/^(\d+)(h|d)$/);
  if (!m) throw new Error(`unparseable --since value: ${spec}`);
  const n = Number(m[1]);
  return m[2] === 'h' ? n * 60 * 60_000 : n * 24 * 60 * 60_000;
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(2); });
