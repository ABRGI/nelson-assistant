import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsJsonStore } from '../src/state/fs.js';
import { NonceStore, isPlausibleNonce } from '../src/auth/nonce.js';

describe('NonceStore', () => {
  let dir: string;
  let store: FsJsonStore;
  let now = 0;
  const tick = (ms: number) => {
    now += ms;
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'nelson-assistant-nonce-'));
    store = new FsJsonStore(dir);
    await store.init();
    now = 1_700_000_000_000;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function make(opts: { ttlMs?: number; maxAttempts?: number } = {}): NonceStore {
    return new NonceStore(store, {
      now: () => now,
      ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
      ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
    });
  }

  it('creates a nonce and retrieves it', async () => {
    const nonces = make({ ttlMs: 60_000 });
    const pending = await nonces.create({ slackUserId: 'U1' });
    expect(pending.nonce.length).toBeGreaterThanOrEqual(20);
    expect(pending.attempts).toBe(0);

    const read = await nonces.get(pending.nonce);
    expect(read?.slackUserId).toBe('U1');
  });

  it('treats expired nonces as missing and deletes them', async () => {
    const nonces = make({ ttlMs: 1_000 });
    const pending = await nonces.create({ slackUserId: 'U1' });
    tick(2_000);
    expect(await nonces.get(pending.nonce)).toBeNull();
    // and it's actually gone from the store
    expect(await store.getJson(`pending-auth/${pending.nonce}.json`)).toBeNull();
  });

  it('invalidates after max attempts', async () => {
    const nonces = make({ ttlMs: 60_000, maxAttempts: 3 });
    const pending = await nonces.create({ slackUserId: 'U1' });
    await nonces.recordAttempt(pending.nonce);
    expect((await nonces.get(pending.nonce))?.attempts).toBe(1);
    await nonces.recordAttempt(pending.nonce);
    await nonces.recordAttempt(pending.nonce);
    // third attempt recorded → attempts === 3 === maxAttempts → get returns null
    expect(await nonces.get(pending.nonce)).toBeNull();
  });

  it('consume removes the nonce', async () => {
    const nonces = make();
    const pending = await nonces.create({ slackUserId: 'U1' });
    await nonces.consume(pending.nonce);
    expect(await nonces.get(pending.nonce)).toBeNull();
  });

  it('rejects obviously malformed nonces without reading storage', async () => {
    const nonces = make();
    expect(await nonces.get('')).toBeNull();
    expect(await nonces.get('short')).toBeNull();
    expect(await nonces.get('has spaces in it which are not allowed')).toBeNull();
  });

  it('recordAttempt on a missing nonce is a no-op', async () => {
    const nonces = make();
    await expect(nonces.recordAttempt('nonexistent_nonce_0000000000')).resolves.toBeUndefined();
  });
});

describe('isPlausibleNonce', () => {
  it('accepts base64url-ish strings of reasonable length', () => {
    expect(isPlausibleNonce('abcdefghijklmnopqrst')).toBe(true);
    expect(isPlausibleNonce('AbC-_ghijk0123456789x')).toBe(true);
  });

  it('rejects short, empty, or bad-character strings', () => {
    expect(isPlausibleNonce('')).toBe(false);
    expect(isPlausibleNonce('short')).toBe(false);
    expect(isPlausibleNonce('has spaces inside this token')).toBe(false);
    expect(isPlausibleNonce('has/slash/inside/token-token')).toBe(false);
  });
});
