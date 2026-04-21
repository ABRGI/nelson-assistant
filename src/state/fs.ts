import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ConditionFailedError,
  type JsonRecord,
  type JsonStore,
} from './types.js';
import { logger } from '../observability/logger.js';

/**
 * Filesystem-backed JsonStore for local development. Keys are paths under `root`;
 * ETag is the sha-256 hash of the serialized contents. Conditional writes are
 * coordinated via an in-process per-key mutex; sufficient for a single-process
 * dev runner.
 */
export class FsJsonStore implements JsonStore {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async getJson<T>(key: string): Promise<JsonRecord<T> | null> {
    const filePath = this.pathFor(key);
    try {
      const buf = await readFile(filePath);
      const value = JSON.parse(buf.toString('utf-8')) as T;
      return { value, etag: hash(buf) };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async putJson<T>(
    key: string,
    value: T,
    opts?: { ifMatch?: string; ifNoneMatch?: string },
  ): Promise<{ etag: string }> {
    return this.withLock(key, async () => {
      const filePath = this.pathFor(key);
      let currentEtag: string | undefined;
      try {
        const buf = await readFile(filePath);
        currentEtag = hash(buf);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      if (opts?.ifNoneMatch === '*' && currentEtag) {
        throw new ConditionFailedError(filePath);
      }
      if (opts?.ifMatch && opts.ifMatch !== currentEtag) {
        throw new ConditionFailedError(filePath);
      }
      const body = Buffer.from(JSON.stringify(value, null, 2), 'utf-8');
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, body);
      return { etag: hash(body) };
    });
  }

  async updateJson<T>(
    key: string,
    initial: () => T,
    mutate: (current: T) => T,
    retries = 3,
  ): Promise<T> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const existing = await this.getJson<T>(key);
      const next = mutate(existing?.value ?? initial());
      try {
        await this.putJson<T>(
          key,
          next,
          existing ? { ifMatch: existing.etag } : { ifNoneMatch: '*' },
        );
        return next;
      } catch (err) {
        if (err instanceof ConditionFailedError && attempt < retries) {
          logger.debug({ key, attempt }, 'fs conditional write lost race, retrying');
          continue;
        }
        throw err;
      }
    }
    throw new Error(`exhausted retries updating ${key}`);
  }

  async listKeys(prefix: string): Promise<string[]> {
    const out: string[] = [];
    const dir = path.join(this.root, prefix);
    try {
      const top = await stat(dir);
      if (top.isDirectory()) await walk(dir, this.root, out);
      else if (top.isFile()) out.push(path.relative(this.root, dir));
    } catch (err) {
      if (isNotFound(err)) return out;
      throw err;
    }
    return out;
  }

  async deleteJson(key: string): Promise<void> {
    const filePath = this.pathFor(key);
    try {
      await rm(filePath);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  private pathFor(key: string): string {
    const safe = key.replace(/\.\.+/g, '.').replace(/^\/+/, '');
    return path.join(this.root, safe);
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((r) => (release = r));
    const chained = prev.then(() => next);
    this.locks.set(key, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === chained) this.locks.delete(key);
    }
  }
}

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, root, out);
    else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
  }
}

function hash(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 32);
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'ENOENT';
}
