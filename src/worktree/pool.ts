import { spawn } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../observability/logger.js';

export interface WorktreeLease {
  /** Absolute path to the worktree directory. cwd for the agent. */
  dir: string;
  /** Release the lease so another job can reuse or the pool can evict. */
  release: () => Promise<void>;
}

export interface ProjectRemote {
  project: string;       // short name, e.g. "nelson"
  remoteUrl: string;     // ssh:// or https:// repo URL
}

interface PooledWorktree {
  project: string;
  branch: string;
  dir: string;
  busy: boolean;
  lastUsed: number;
}

/**
 * LRU worktree pool on the workspace root (EFS in prod, /tmp in dev).
 * One bare repo per project under `<root>/.bare/<project>.git`; worktrees under
 * `<root>/work/<project>/<slot>/`. Leases are branch-specific and exclusive.
 */
export class WorktreePool {
  private readonly bareRoot: string;
  private readonly workRoot: string;
  private readonly entries = new Map<string, PooledWorktree>();
  private readonly lockQueue = new Map<string, Promise<void>>();
  private readonly gitEnv: NodeJS.ProcessEnv;

  constructor(
    root: string,
    private readonly remotes: Map<string, ProjectRemote>,
    private readonly maxPerProject = 4,
    sshKeyPath?: string,
  ) {
    // Resolve to absolute so git worktree paths are never relative to the bare repo dir.
    const absRoot = path.resolve(root);
    this.bareRoot = path.join(absRoot, '.bare');
    this.workRoot = path.join(absRoot, 'work');
    this.gitEnv = {
      ...process.env,
      // Trust all directories — needed when EFS is owned by a different UID than the ECS task user.
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: '*',
      ...(sshKeyPath
        ? { GIT_SSH_COMMAND: `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=accept-new -o BatchMode=yes` }
        : {}),
    };
  }

  async init(): Promise<void> {
    await mkdir(this.bareRoot, { recursive: true });
    await mkdir(this.workRoot, { recursive: true });
  }

  async refresh(project?: string): Promise<void> {
    const projects = project ? [project] : [...this.remotes.keys()];
    await Promise.all(
      projects.map((p) =>
        this.serialize(`project:${p}`, async () => {
          await this.ensureBareRepo(p);
          await this.fetchBare(p);
          logger.info({ project: p }, 'repo refreshed');
        }),
      ),
    );
  }

  async acquire(project: string, branch: string): Promise<WorktreeLease> {
    if (!this.remotes.has(project)) {
      throw new Error(`unknown project "${project}"`);
    }
    await this.serialize(`project:${project}`, () => this.ensureBareRepo(project));

    const key = `${project}@${branch}`;
    const slot = await this.serialize(`pool:${project}`, async () => this.allocateSlot(project, branch, key));
    return {
      dir: slot.dir,
      release: async () => {
        await this.serialize(`pool:${project}`, async () => {
          slot.busy = false;
          slot.lastUsed = Date.now();
        });
      },
    };
  }

  private async allocateSlot(
    project: string,
    branch: string,
    key: string,
  ): Promise<PooledWorktree> {
    // Reuse an idle worktree already on this branch.
    for (const entry of this.entries.values()) {
      if (!entry.busy && entry.project === project && entry.branch === branch) {
        entry.busy = true;
        await this.checkoutBranch(entry.dir, branch);
        return entry;
      }
    }
    // Reuse an idle worktree in same project, switch its branch.
    for (const entry of this.entries.values()) {
      if (!entry.busy && entry.project === project) {
        await this.checkoutBranch(entry.dir, branch);
        entry.branch = branch;
        entry.busy = true;
        return entry;
      }
    }
    // Evict least-recent idle if at cap.
    const projectEntries = [...this.entries.values()].filter((e) => e.project === project);
    if (projectEntries.length >= this.maxPerProject) {
      const victim = projectEntries
        .filter((e) => !e.busy)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!victim) {
        throw new Error(`worktree pool exhausted for project ${project}; all ${this.maxPerProject} slots busy`);
      }
      await this.removeWorktree(victim);
    }
    const slotIdx = nextSlotIndex(projectEntries.map((e) => e.dir), this.workRoot, project);
    const dir = path.join(this.workRoot, project, String(slotIdx));
    await mkdir(path.dirname(dir), { recursive: true });
    // Clear anything left over from a prior crashed run — both the on-disk
    // directory and the bare repo's worktree registration for that path.
    await rm(dir, { recursive: true, force: true });
    await this.run('git', ['-C', this.bareDir(project), 'worktree', 'prune']).catch(() => {});
    await this.run('git', ['-C', this.bareDir(project), 'worktree', 'add', '--force', dir, branch]);
    const entry: PooledWorktree = { project, branch, dir, busy: true, lastUsed: Date.now() };
    this.entries.set(`${project}#${slotIdx}`, entry);
    logger.info({ project, branch, dir, key }, 'worktree allocated');
    return entry;
  }

  private async removeWorktree(entry: PooledWorktree): Promise<void> {
    await this.run('git', ['-C', this.bareDir(entry.project), 'worktree', 'remove', '--force', entry.dir]);
    for (const [k, v] of this.entries) if (v === entry) this.entries.delete(k);
  }

  private async ensureBareRepo(project: string): Promise<void> {
    const dir = this.bareDir(project);
    try {
      const s = await stat(dir);
      if (s.isDirectory()) return;
    } catch {
      // not found, clone below
    }
    const remote = this.remotes.get(project);
    if (!remote) throw new Error(`no remote for project ${project}`);
    await mkdir(this.bareRoot, { recursive: true });
    await this.run('git', ['clone', '--bare', remote.remoteUrl, dir]);
    await this.run('git', ['-C', dir, 'remote', 'set-url', '--push', 'origin', 'no-push://read-only']);
    // Wipe any stale worktree directories left on EFS from a previous task so
    // git worktree add starts from a clean slate.
    await rm(path.join(this.workRoot, project), { recursive: true, force: true });
    logger.info({ project, dir }, 'bare repo cloned');
  }

  private async fetchBare(project: string): Promise<void> {
    await this.run('git', ['-C', this.bareDir(project), 'fetch', '--prune', '--tags']);
  }

  private async checkoutBranch(dir: string, branch: string): Promise<void> {
    await this.run('git', ['-C', dir, 'checkout', '-f', branch]);
    await this.run('git', ['-C', dir, 'clean', '-fd']);
  }

  private bareDir(project: string): string {
    return path.join(this.bareRoot, `${project}.git`);
  }

  private async serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.lockQueue.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((r) => (release = r));
    this.lockQueue.set(key, prev.then(() => next));
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.lockQueue.get(key) === prev.then(() => next)) this.lockQueue.delete(key);
    }
  }

  private run(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: this.gitEnv });
      const stderr: Buffer[] = [];
      proc.stderr.on('data', (c) => stderr.push(c as Buffer));
      proc.on('error', reject);
      proc.on('exit', (code) => {
        if (code === 0) return resolve();
        reject(new Error(`${cmd} ${args.join(' ')} failed (${code}): ${Buffer.concat(stderr).toString('utf-8')}`));
      });
    });
  }
}

function nextSlotIndex(existing: string[], workRoot: string, project: string): number {
  const prefix = path.join(workRoot, project) + path.sep;
  const used = new Set(
    existing
      .filter((d) => d.startsWith(prefix))
      .map((d) => Number(d.slice(prefix.length)))
      .filter((n) => Number.isFinite(n)),
  );
  for (let i = 0; i < 1024; i++) if (!used.has(i)) return i;
  throw new Error('worktree slot indices exhausted');
}
