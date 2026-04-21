import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SecretVault } from './types.js';

/**
 * Filesystem-backed SecretVault for local development. DO NOT use outside dev —
 * plaintext on disk. Each secret is one file at `<root>/<name>.secret`.
 */
export class FsSecretVault implements SecretVault {
  constructor(private readonly root: string) {}

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async get(name: string): Promise<string | null> {
    try {
      const buf = await readFile(this.pathFor(name));
      return buf.toString('utf-8');
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async put(name: string, value: string): Promise<void> {
    const filePath = this.pathFor(name);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, value, { mode: 0o600 });
  }

  async remove(name: string): Promise<void> {
    try {
      await rm(this.pathFor(name));
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  private pathFor(name: string): string {
    const safe = name.replace(/\.\.+/g, '.').replace(/^\/+/, '');
    return path.join(this.root, `${safe}.secret`);
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'ENOENT';
}
