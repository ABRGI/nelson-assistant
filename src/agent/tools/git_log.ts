import { spawn } from 'node:child_process';
import { z } from 'zod';

export const GitLogInputSchema = z.object({
  branch: z.string().min(1).default('HEAD'),
  limit: z.number().int().positive().max(50).default(10),
});
export type GitLogInput = z.infer<typeof GitLogInputSchema>;

export interface GitLogEntry {
  sha: string;
  author: string;
  date: string;
  subject: string;
}

export async function gitLog(cwd: string, input: GitLogInput): Promise<GitLogEntry[]> {
  const parsed = GitLogInputSchema.parse(input);
  const format = '%H%x1f%an%x1f%aI%x1f%s';
  const stdout = await run(
    'git',
    ['-C', cwd, 'log', '--no-merges', `--max-count=${parsed.limit}`, `--pretty=format:${format}`, parsed.branch],
  );
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, author, date, subject] = line.split('\x1f');
      return {
        sha: sha ?? '',
        author: author ?? '',
        date: date ?? '',
        subject: subject ?? '',
      };
    });
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on('data', (c) => out.push(c as Buffer));
    proc.stderr.on('data', (c) => err.push(c as Buffer));
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) return resolve(Buffer.concat(out).toString('utf-8'));
      reject(new Error(`${cmd} ${args.join(' ')} (${code}): ${Buffer.concat(err).toString('utf-8')}`));
    });
  });
}
