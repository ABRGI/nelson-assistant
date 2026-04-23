import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FsJsonStore } from '../src/state/fs.js';
import {
  cosineSimilarity,
  agglomerativeCluster,
  buildTopicReport,
  saveTopicReport,
  type ClusterPoint,
} from '../src/analytics/topics.js';
import {
  normalizeQuestion,
  hashNormalized,
  getOrEmbed,
  type EmbeddingCacheStats,
} from '../src/state/embedding-cache.js';
import type { TitanEmbedder, TitanEmbedResult } from '../src/agent/embed.js';

// Fake embedder that returns deterministic unit vectors based on a seed map.
// Every call bumps its invocation counter so tests can assert cache hits.
class FakeEmbedder {
  public calls = 0;
  constructor(private readonly vecForText: Map<string, number[]>) {}
  dimensions = 4;
  async embed(text: string): Promise<TitanEmbedResult> {
    this.calls += 1;
    const v = this.vecForText.get(text) ?? [1, 0, 0, 0];
    return { vector: v, usage: { inputTokens: Math.max(1, text.length), outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } };
  }
}

function unit(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n === 0 ? v : v.map((x) => x / n);
}

describe('cosineSimilarity', () => {
  it('returns 1 for identical unit vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });
  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
  });
  it('returns 0 for mismatched dimensions', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(0);
  });
});

describe('agglomerativeCluster', () => {
  it('groups close points together', () => {
    const pts: ClusterPoint[] = [
      { id: 'a', vector: unit([1, 0, 0, 0]), text: 'a', hitCount: 1 },
      { id: 'b', vector: unit([0.95, 0.1, 0, 0]), text: 'b', hitCount: 1 },
      { id: 'c', vector: unit([0, 1, 0, 0]), text: 'c', hitCount: 1 },
    ];
    const labels = agglomerativeCluster(pts, 0.78);
    expect(labels[0]).toBe(labels[1]); // a + b together
    expect(labels[0]).not.toBe(labels[2]); // c separate
  });

  it('returns separate labels when nothing is similar enough', () => {
    const pts: ClusterPoint[] = [
      { id: 'a', vector: unit([1, 0, 0, 0]), text: 'a', hitCount: 1 },
      { id: 'b', vector: unit([0, 1, 0, 0]), text: 'b', hitCount: 1 },
      { id: 'c', vector: unit([0, 0, 1, 0]), text: 'c', hitCount: 1 },
    ];
    const labels = agglomerativeCluster(pts, 0.78);
    expect(new Set(labels).size).toBe(3);
  });

  it('returns empty labels on empty input', () => {
    expect(agglomerativeCluster([], 0.78)).toEqual([]);
  });
});

describe('normalizeQuestion + hashNormalized', () => {
  it('lowercases, trims and collapses whitespace', () => {
    expect(normalizeQuestion('  Arrivals TODAY?  ')).toBe('arrivals today');
    expect(normalizeQuestion('Room\tnights  for  HKI2')).toBe('room nights for hki2');
  });
  it('produces the same hash for case / punctuation variants', () => {
    const h1 = hashNormalized(normalizeQuestion('Arrivals today?'));
    const h2 = hashNormalized(normalizeQuestion('arrivals today'));
    const h3 = hashNormalized(normalizeQuestion('  ARRIVALS TODAY  '));
    expect(h1).toBe(h2);
    expect(h1).toBe(h3);
  });
  it('produces different hashes for different questions', () => {
    expect(hashNormalized(normalizeQuestion('arrivals today'))).not.toBe(
      hashNormalized(normalizeQuestion('arrivals tomorrow')),
    );
  });
});

describe('getOrEmbed caching', () => {
  let dir: string;
  let store: FsJsonStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'embed-cache-'));
    store = new FsJsonStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('calls the embedder once and serves subsequent requests from cache', async () => {
    const embedder = new FakeEmbedder(new Map([['arrivals today', unit([1, 0, 0, 0])]]));
    const stats: EmbeddingCacheStats = { hits: 0, misses: 0, tokensIn: 0 };
    const now = '2026-04-23T03:00:00.000Z';
    const r1 = await getOrEmbed(store, embedder as unknown as TitanEmbedder, 'fake-model', 'arrivals today', now, stats);
    expect(embedder.calls).toBe(1);
    expect(stats.misses).toBe(1);
    expect(r1.hitCount).toBe(1);

    const later = '2026-04-24T03:00:00.000Z';
    const r2 = await getOrEmbed(store, embedder as unknown as TitanEmbedder, 'fake-model', 'arrivals today', later, stats);
    expect(embedder.calls).toBe(1); // cache hit
    expect(stats.hits).toBe(1);
    expect(r2.hitCount).toBe(2); // bumped
    expect(r2.lastSeenIso).toBe(later);
  });

  it('recomputes when the cached record used a different model id', async () => {
    const embedder = new FakeEmbedder(new Map([['q', unit([1, 0, 0, 0])]]));
    const stats: EmbeddingCacheStats = { hits: 0, misses: 0, tokensIn: 0 };
    const now = '2026-04-23T03:00:00.000Z';
    await getOrEmbed(store, embedder as unknown as TitanEmbedder, 'model-a', 'q', now, stats);
    expect(embedder.calls).toBe(1);
    await getOrEmbed(store, embedder as unknown as TitanEmbedder, 'model-b', 'q', now, stats);
    expect(embedder.calls).toBe(2); // different model → miss
  });
});

describe('buildTopicReport end-to-end on a seeded chatlog', () => {
  let dir: string;
  let store: FsJsonStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'topic-'));
    store = new FsJsonStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeEvent(text: string, ts: string, id: string) {
    return {
      eventId: id,
      eventTs: ts,
      kind: 'message_received',
      threadTs: `t-${id}`,
      channel: 'C1',
      slackUserId: 'U1',
      tenantId: 'tenant-a',
      detail: { text, source: 'dm', userMessageTs: ts },
    };
  }

  it('clusters similar questions and ranks by frequency', async () => {
    const day = '2026-04-22';
    const events = [
      makeEvent('arrivals today at HKI2', `${day}T09:00:00.000Z`, 'e1'),
      makeEvent('arrivals today HKI1', `${day}T10:00:00.000Z`, 'e2'),
      makeEvent('arrivals today at HKI2', `${day}T11:00:00.000Z`, 'e3'), // duplicate — will share a cache entry
      makeEvent('OTB for next weekend', `${day}T12:00:00.000Z`, 'e4'),
      makeEvent('debug fix the prompt', `${day}T12:30:00.000Z`, 'e5'), // should be skipped
    ];
    for (const ev of events) {
      const key = `chatlog/${day}/${ev.threadTs}/${ev.eventTs}-${ev.eventId}.json`;
      await store.putJson(key, ev);
    }

    // Keys are the NORMALISED text — getOrEmbed passes the lowercased /
    // trimmed form to the embedder so reruns hit the same cache key.
    const vectors = new Map([
      ['arrivals today at hki2', unit([1, 0.1, 0, 0])],
      ['arrivals today hki1', unit([0.95, 0.2, 0, 0])],
      ['otb for next weekend', unit([0, 0, 1, 0])],
    ]);
    const embedder = new FakeEmbedder(vectors);

    const report = await buildTopicReport(
      { store, embedder: embedder as unknown as TitanEmbedder },
      {
        fromIso: `${day}T00:00:00.000Z`,
        toIso: `${day}T23:59:59.000Z`,
        model: 'fake-model',
        similarityThreshold: 0.78,
        minClusterSize: 2,
      },
    );

    expect(report.totalQuestions).toBe(4); // debug-prefixed event filtered out
    expect(report.uniqueQuestions).toBe(3); // 'arrivals today at HKI2' dedupes
    // Only 3 unique embeddings: one cluster of the two arrivals variants, plus OTB singleton
    expect(embedder.calls).toBe(3);
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0]!.size).toBe(2);
    expect(report.clusters[0]!.frequency).toBe(3); // 2 + 1 hitCount
    expect(report.singletons).toBe(1);
  });

  it('saveTopicReport writes to analytics/topics/<date>.json', async () => {
    const r = {
      generatedAt: '2026-04-22T03:00:00.000Z',
      window: { fromIso: '2026-04-15T00:00:00.000Z', toIso: '2026-04-22T00:00:00.000Z' },
      model: 'x', similarityThreshold: 0.78, minClusterSize: 2,
      totalQuestions: 0, uniqueQuestions: 0,
      newEmbeddingsComputed: 0, cacheHits: 0, embeddingTokensIn: 0,
      clusters: [], singletons: 0,
    };
    const key = await saveTopicReport(store, r);
    expect(key).toBe('analytics/topics/2026-04-22.json');
    const rec = await store.getJson(key);
    expect(rec).not.toBeNull();
  });
});
