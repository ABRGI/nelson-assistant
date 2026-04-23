// Shared helper for training / analytics jobs to SIGHUP the running dev
// server after they write new state (decisions, topic reports, etc.) so the
// pipeline reloads in place without a restart. No-op in prod where there is
// no tsx watcher — the ECS task's own restart cycle picks up S3 state on boot.
const { execSync } = require('node:child_process');

function sighupDevServer() {
  let pids = [];
  try {
    const out = execSync("pgrep -f 'tsx.*src/index'", { encoding: 'utf-8' }).trim();
    pids = out.split(/\s+/).filter(Boolean);
  } catch {
    // pgrep exits non-zero when no matches — expected.
  }
  if (pids.length === 0) {
    console.log('(no running tsx dev server — skipping reload)');
    return;
  }
  for (const pid of pids) {
    try {
      process.kill(Number(pid), 'SIGHUP');
      console.log(`→ SIGHUP sent to dev server pid=${pid}`);
    } catch (err) {
      console.log(`(failed to SIGHUP pid=${pid}: ${err.message})`);
    }
  }
}

module.exports = { sighupDevServer };
