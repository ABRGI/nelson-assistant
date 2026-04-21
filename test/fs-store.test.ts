import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsJsonStore } from '../src/state/fs.js';
import { ConditionFailedError } from '../src/state/types.js';

describe('FsJsonStore', () => {
  let dir: string;
  let store: FsJsonStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'nelson-assistant-fs-'));
    store = new FsJsonStore(dir);
    await store.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null for missing keys', async () => {
    expect(await store.getJson('users/missing.json')).toBeNull();
  });

  it('round-trips JSON with an ETag', async () => {
    await store.putJson('users/u1.json', { a: 1 });
    const read = await store.getJson<{ a: number }>('users/u1.json');
    expect(read?.value).toEqual({ a: 1 });
    expect(read?.etag).toMatch(/^[0-9a-f]{32}$/);
  });

  it('honors ifNoneMatch=* (create-only)', async () => {
    await store.putJson('x.json', { v: 1 }, { ifNoneMatch: '*' });
    await expect(store.putJson('x.json', { v: 2 }, { ifNoneMatch: '*' })).rejects.toBeInstanceOf(
      ConditionFailedError,
    );
  });

  it('honors ifMatch=<etag>', async () => {
    await store.putJson('x.json', { v: 1 });
    const rec = await store.getJson<{ v: number }>('x.json');
    await store.putJson('x.json', { v: 2 }, { ifMatch: rec!.etag });
    await expect(
      store.putJson('x.json', { v: 3 }, { ifMatch: 'wrong-etag' }),
    ).rejects.toBeInstanceOf(ConditionFailedError);
  });

  it('updateJson retries on a racing write', async () => {
    let mutateCalls = 0;
    const result = store.updateJson<{ v: number }>(
      'x.json',
      () => ({ v: 0 }),
      (cur) => {
        mutateCalls++;
        if (mutateCalls === 1) {
          // simulate a racing writer changing the file between read and write
          void store.putJson('x.json', { v: 99 });
        }
        return { v: (cur.v ?? 0) + 1 };
      },
    );
    await expect(result).resolves.toEqual({ v: 100 });
    expect(mutateCalls).toBeGreaterThanOrEqual(2);
  });

  it('listKeys returns files under a prefix', async () => {
    await store.putJson('clients/acme.json', { tenantId: 'acme' });
    await store.putJson('clients/beta.json', { tenantId: 'beta' });
    await store.putJson('users/u1.json', { slackUserId: 'u1' });
    const keys = (await store.listKeys('clients/')).sort();
    expect(keys).toEqual(['clients/acme.json', 'clients/beta.json']);
  });

  it('deleteJson is idempotent', async () => {
    await store.putJson('x.json', { v: 1 });
    await store.deleteJson('x.json');
    await store.deleteJson('x.json'); // second call must not throw
    expect(await store.getJson('x.json')).toBeNull();
  });
});
