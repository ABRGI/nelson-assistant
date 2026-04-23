import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FsJsonStore } from '../src/state/fs.js';
import type { TopicReport, TopicReportCluster } from '../src/analytics/topics.js';
import {
  loadLatestTopicReport,
  matchTopicHints,
  renderTopicHintsForPrompt,
} from '../src/state/topic-hints.js';

function cluster(over: Partial<TopicReportCluster> = {}): TopicReportCluster {
  return {
    id: over.id ?? 0,
    size: over.size ?? 2,
    frequency: over.frequency ?? 3,
    representativeQuestion: over.representativeQuestion ?? 'arrivals today at HKI2',
    sampleQuestions: over.sampleQuestions ?? ['arrivals today at HKI2', 'arrivals today HKI1'],
  };
}

function report(over: Partial<TopicReport> = {}): TopicReport {
  return {
    generatedAt: over.generatedAt ?? '2026-04-23T03:00:00.000Z',
    window: over.window ?? { fromIso: '2026-04-16T00:00:00.000Z', toIso: '2026-04-23T00:00:00.000Z' },
    model: 'm', similarityThreshold: 0.78, minClusterSize: 2,
    totalQuestions: 0, uniqueQuestions: 0,
    newEmbeddingsComputed: 0, cacheHits: 0, embeddingTokensIn: 0,
    clusters: over.clusters ?? [],
    singletons: 0,
  };
}

describe('loadLatestTopicReport', () => {
  let dir: string;
  let store: FsJsonStore;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'topic-hints-'));
    store = new FsJsonStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when no reports exist', async () => {
    expect(await loadLatestTopicReport(store)).toBeNull();
  });

  it('returns the lexicographically-largest key (= newest date)', async () => {
    await store.putJson('analytics/topics/2026-04-20.json', report({ generatedAt: '2026-04-20T03:00:00.000Z' }));
    await store.putJson('analytics/topics/2026-04-22.json', report({ generatedAt: '2026-04-22T03:00:00.000Z' }));
    await store.putJson('analytics/topics/2026-04-21.json', report({ generatedAt: '2026-04-21T03:00:00.000Z' }));
    const loaded = await loadLatestTopicReport(store);
    expect(loaded?.generatedAt).toBe('2026-04-22T03:00:00.000Z');
  });
});

describe('matchTopicHints', () => {
  it('returns empty when report is null', () => {
    expect(matchTopicHints('anything', null)).toEqual([]);
  });

  it('returns empty when the question does not match any sample', () => {
    const r = report({ clusters: [cluster({ sampleQuestions: ['advance invoice for X'] })] });
    expect(matchTopicHints('How many reservations today?', r)).toEqual([]);
  });

  it('matches when the question contains a sample as substring', () => {
    const r = report({ clusters: [cluster({ id: 42, sampleQuestions: ['arrivals today at HKI2'] })] });
    const out = matchTopicHints('Can you tell me arrivals today at HKI2?', r);
    expect(out).toHaveLength(1);
    expect(out[0]!.cluster.id).toBe(42);
  });

  it('matches when a sample contains the normalised question (short follow-up)', () => {
    const r = report({ clusters: [cluster({ id: 7, sampleQuestions: ['arrivals today at HKI2'] })] });
    const out = matchTopicHints('HKI2', r);
    expect(out).toHaveLength(1);
    expect(out[0]!.cluster.id).toBe(7);
  });

  it('ranks higher-frequency clusters first and caps at maxMatches', () => {
    const r = report({
      clusters: [
        cluster({ id: 1, frequency: 3, sampleQuestions: ['foo'] }),
        cluster({ id: 2, frequency: 10, sampleQuestions: ['foo'] }),
        cluster({ id: 3, frequency: 5, sampleQuestions: ['foo'] }),
      ],
    });
    const out = matchTopicHints('foo', r, { maxMatches: 2 });
    expect(out.map((m) => m.cluster.id)).toEqual([2, 3]);
  });
});

describe('renderTopicHintsForPrompt', () => {
  it('returns undefined when there are no matches', () => {
    expect(renderTopicHintsForPrompt([])).toBeUndefined();
  });

  it('wraps matches in COMMON TOPIC MATCH markers with frequency + samples', () => {
    const c = cluster({ id: 3, frequency: 8, size: 4, representativeQuestion: 'arrivals today at HKI2', sampleQuestions: ['arrivals today HKI1', 'who is arriving'] });
    const out = renderTopicHintsForPrompt([{ cluster: c, matchedPhrase: 'arrivals today at HKI2' }]) ?? '';
    expect(out).toContain('COMMON TOPIC MATCH');
    expect(out).toContain('cluster 3');
    expect(out).toContain('asked 8×');
    expect(out).toContain('arrivals today HKI1');
  });
});
