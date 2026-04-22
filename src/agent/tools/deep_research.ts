import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { WorktreePool } from '../../worktree/pool.js';
import { logger } from '../../observability/logger.js';

// Authority boundary: this tool is the ONLY way the agent touches Nelson source
// code on the hot path. It allocates a worktree, performs focused reads / greps,
// and returns the raw excerpts with file:line prefixes — then releases the
// worktree. Cost-intensive by design; main agent should call it sparingly and
// only after the pre-injected knowledge leaves fail to answer the question.

// Schema is a plain object (not refined) so the agent SDK's `tool()` helper
// can read `.shape` off it. We validate the "at least one read/grep" rule
// inside runDeepResearch instead.
export const DeepResearchInputSchema = z.object({
  question: z.string().min(4, 'question: describe exactly what you need to find'),
  project: z.enum([
    'nelson',
    'nelson-user-management-service',
    'nelson-tenant-management-service',
    'nelson-client-configuration',
    'nelson-management-ui',
    'nelson-bui-2.0',
    'omena-mobile-app',
    'omena-service-app',
  ]).default('nelson'),
  branch: z.string().optional(),
  reads: z.array(z.object({
    path: z.string(),
    start_line: z.number().int().positive().optional(),
    max_lines: z.number().int().positive().max(400).default(200),
  })).max(5).default([]),
  greps: z.array(z.object({
    pattern: z.string(),
    path_prefix: z.string().optional(),
    max_matches: z.number().int().positive().max(50).default(20),
  })).max(3).default([]),
});

export interface DeepResearchContext {
  worktrees: WorktreePool;
  defaultBranch: string;
}

export async function runDeepResearch(
  ctx: DeepResearchContext,
  input: z.infer<typeof DeepResearchInputSchema>,
): Promise<{ summary: string }> {
  if (input.reads.length + input.greps.length === 0) {
    return { summary: 'deep_research: must include at least one `reads` or `greps` entry — nothing done.' };
  }
  const branch = input.branch ?? ctx.defaultBranch;
  const lease = await ctx.worktrees.acquire(input.project, branch);
  const out: string[] = [`# deep_research: ${input.question}`, `project=${input.project}  branch=${branch}`, ''];
  try {
    for (const r of input.reads) {
      const abs = path.resolve(lease.dir, r.path);
      if (!abs.startsWith(lease.dir)) {
        out.push(`--- ${r.path} ---`, '(rejected: path escapes worktree)', '');
        continue;
      }
      try {
        const raw = await readFile(abs, 'utf-8');
        const lines = raw.split('\n');
        const start = (r.start_line ?? 1) - 1;
        const slice = lines.slice(Math.max(0, start), start + r.max_lines);
        const numbered = slice.map((l, i) => `${start + i + 1}\t${l}`).join('\n');
        out.push(`--- ${r.path} (lines ${start + 1}..${start + slice.length} of ${lines.length}) ---`);
        out.push(numbered);
        out.push('');
      } catch (err) {
        out.push(`--- ${r.path} ---`, `(read failed: ${(err as Error).message})`, '');
      }
    }
    for (const g of input.greps) {
      const args = ['-n', '-R', '-E', '--include=*.java', '--include=*.ts', '--include=*.tsx', '--include=*.js', '--include=*.sql', '--include=*.yml', '--include=*.yaml', '--include=*.json', '--include=*.md', g.pattern];
      const scope = g.path_prefix ? path.resolve(lease.dir, g.path_prefix) : lease.dir;
      if (!scope.startsWith(lease.dir)) {
        out.push(`--- grep ${JSON.stringify(g)} ---`, '(rejected: path_prefix escapes worktree)', '');
        continue;
      }
      args.push(scope);
      const matches = await runGrep(args, g.max_matches);
      out.push(`--- grep "${g.pattern}"${g.path_prefix ? ` under ${g.path_prefix}` : ''} (${matches.length} matches shown) ---`);
      out.push(...matches);
      out.push('');
    }
  } finally {
    await lease.release().catch((err) => logger.warn({ err }, 'deep_research lease release failed'));
  }
  const summary = out.join('\n');
  logger.info({ project: input.project, reads: input.reads.length, greps: input.greps.length, bytes: summary.length }, 'deep_research complete');
  return { summary };
}

function runGrep(args: string[], maxMatches: number): Promise<string[]> {
  return new Promise((resolve) => {
    const proc = spawn('grep', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    const lines: string[] = [];
    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf-8');
      let nl = buf.indexOf('\n');
      while (nl >= 0 && lines.length < maxMatches) {
        lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
      }
      if (lines.length >= maxMatches) proc.kill('SIGTERM');
    });
    proc.on('close', () => resolve(lines.slice(0, maxMatches)));
    proc.on('error', () => resolve([]));
  });
}
