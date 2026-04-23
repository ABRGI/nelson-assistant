// Write a single decision record to the state store, then SIGHUP the running
// dev server so it reloads decision memory in place.
//
// Called by the /debug and /learning skills once a root-cause fix has been
// applied. Idempotent: the slug is the key; reruns update the record.
//
// Usage:
//   cat decision.json | node scripts/write-decision.js
//   node scripts/write-decision.js path/to/decision.json
//
// Decision JSON must conform to DecisionSchema in src/state/decisions.ts.
// The `schema`, `version`, `created`, `updated`, `related_leaves`,
// `related_commits`, `source_threads` fields are defaulted when omitted.
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('url');
const { sighupDevServer } = require('./_sighup-dev-server.js');

async function readInput() {
  const arg = process.argv[2];
  if (arg) return JSON.parse(fs.readFileSync(arg, 'utf-8'));
  const stdin = fs.readFileSync(0, 'utf-8');
  if (!stdin.trim()) {
    throw new Error('No decision JSON on stdin and no file path given. Pipe JSON or pass a file path.');
  }
  return JSON.parse(stdin);
}

async function main() {
  const raw = await readInput();

  const tsxReq = require('tsx/cjs/api');
  const { FsJsonStore } = tsxReq.require(pathToFileURL(path.resolve('src/state/fs.ts')).href, __filename);
  const { saveDecision } = tsxReq.require(pathToFileURL(path.resolve('src/state/decisions.ts')).href, __filename);

  const stateRoot = process.env.LOCAL_STATE_ROOT ?? './.local-state';
  const store = new FsJsonStore(path.join(stateRoot, 'state'));

  const now = new Date().toISOString();
  const decision = {
    schema: 1,
    version: 1,
    created: now,
    updated: now,
    related_leaves: [],
    related_commits: [],
    source_threads: [],
    ...raw,
  };

  await saveDecision(store, decision);
  console.log(`✓ saved decisions/${decision.slug}.json`);

  sighupDevServer();
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  if (e.issues) console.error(JSON.stringify(e.issues, null, 2));
  process.exit(2);
});
