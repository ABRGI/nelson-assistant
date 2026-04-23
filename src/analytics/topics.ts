import type { JsonStore } from '../state/types.js';
import type { ChatLogEvent } from '../observability/chatlog.js';
import { logger } from '../observability/logger.js';
import { normalizeQuestion, hashNormalized, getOrEmbed, type EmbeddingCacheStats } from '../state/embedding-cache.js';
import type { TitanEmbedder } from '../agent/embed.js';

// Skip strings matching any of these — dev noise that shouldn't cluster.
const SKIP_PREFIXES = ['debug ', '[debug]', 'test ', '/nelson', '/debug'];

export interface TopicReportCluster {
  id: number;
  size: number; // distinct normalised questions in the cluster
  frequency: number; // sum of hitCount — reflects how often users actually ask these
  representativeQuestion: string; // highest-hitCount member
  sampleQuestions: string[]; // top 5 by hitCount
}

export interface TopicReport {
  generatedAt: string;
  window: { fromIso: string; toIso: string };
  model: string;
  similarityThreshold: number;
  minClusterSize: number;
  totalQuestions: number; // raw count
  uniqueQuestions: number; // after normalise + dedupe
  newEmbeddingsComputed: number;
  cacheHits: number;
  embeddingTokensIn: number;
  clusters: TopicReportCluster[];
  singletons: number; // unique questions that didn't cluster
}

export interface BuildTopicReportOpts {
  fromIso: string;
  toIso: string;
  model: string;
  similarityThreshold?: number; // default 0.78
  minClusterSize?: number; // default 2
}

export interface BuildTopicReportDeps {
  store: JsonStore;
  embedder: TitanEmbedder;
}

// Cosine similarity. Titan v2 returns unit vectors when normalize=true, so
// this is a dot product. Guard against stale non-unit vectors anyway.
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export interface ClusterPoint {
  id: string; // hash
  vector: number[];
  text: string;
  hitCount: number;
}

// Single-linkage agglomerative clustering by cosine similarity threshold.
// O(n²) distance matrix — fine for n up to a few thousand. For the dev chatlog
// at ~15 unique questions/day, this is trivial.
export function agglomerativeCluster(
  points: ClusterPoint[],
  threshold: number,
): number[] {
  const n = points.length;
  const labels: number[] = new Array(n).fill(-1);
  if (n === 0) return labels;
  let nextLabel = 0;

  // Precompute similarities. For each unlabelled point, greedy-grow the
  // cluster by finding any unlabelled neighbour within threshold.
  for (let i = 0; i < n; i++) {
    if (labels[i] !== -1) continue;
    const label = nextLabel++;
    labels[i] = label;
    const queue = [i];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (let j = 0; j < n; j++) {
        if (labels[j] !== -1) continue;
        const sim = cosineSimilarity(points[cur]!.vector, points[j]!.vector);
        if (sim >= threshold) {
          labels[j] = label;
          queue.push(j);
        }
      }
    }
  }
  return labels;
}

interface RawQuestion {
  rawText: string;
}

async function collectQuestions(
  store: JsonStore,
  opts: { fromIso: string; toIso: string },
): Promise<RawQuestion[]> {
  const from = new Date(opts.fromIso);
  const to = new Date(opts.toIso);
  const out: RawQuestion[] = [];
  const keys = await store.listKeys('chatlog/');
  for (const key of keys) {
    const m = key.match(/^chatlog\/(\d{4}-\d{2}-\d{2})\//);
    if (!m) continue;
    const dateOnly = new Date(`${m[1]!}T00:00:00Z`);
    if (dateOnly.getTime() + 24 * 60 * 60_000 < from.getTime()) continue;
    if (dateOnly.getTime() > to.getTime()) continue;
    const rec = await store.getJson<ChatLogEvent>(key).catch(() => null);
    if (!rec) continue;
    const ev = rec.value;
    if (ev.kind !== 'message_received') continue;
    const ts = new Date(ev.eventTs);
    if (ts < from || ts > to) continue;
    const text = (ev.detail as { text?: unknown }).text;
    if (typeof text !== 'string') continue;
    if (SKIP_PREFIXES.some((p) => text.toLowerCase().startsWith(p))) continue;
    out.push({ rawText: text });
  }
  return out;
}

export async function buildTopicReport(
  deps: BuildTopicReportDeps,
  opts: BuildTopicReportOpts,
): Promise<TopicReport> {
  const similarityThreshold = opts.similarityThreshold ?? 0.78;
  const minClusterSize = opts.minClusterSize ?? 2;

  const raws = await collectQuestions(deps.store, opts);
  logger.info({ totalQuestions: raws.length }, 'topic-analysis: collected questions');

  const byHash = new Map<string, { text: string; count: number }>();
  for (const r of raws) {
    const normalised = normalizeQuestion(r.rawText);
    if (normalised.length === 0) continue;
    const h = hashNormalized(normalised);
    const prev = byHash.get(h);
    if (prev) prev.count += 1;
    else byHash.set(h, { text: r.rawText, count: 1 });
  }

  const stats: EmbeddingCacheStats = { hits: 0, misses: 0, tokensIn: 0 };
  const nowIso = new Date().toISOString();
  const points: ClusterPoint[] = [];
  for (const [hash, entry] of byHash) {
    const rec = await getOrEmbed(deps.store, deps.embedder, opts.model, entry.text, nowIso, stats);
    points.push({ id: hash, vector: rec.vector, text: entry.text, hitCount: entry.count });
  }

  const labels = agglomerativeCluster(points, similarityThreshold);
  const buckets = new Map<number, ClusterPoint[]>();
  for (let i = 0; i < points.length; i++) {
    const l = labels[i]!;
    const arr = buckets.get(l) ?? [];
    arr.push(points[i]!);
    buckets.set(l, arr);
  }

  const clusters: TopicReportCluster[] = [];
  let singletons = 0;
  let id = 0;
  for (const [, members] of buckets) {
    if (members.length < minClusterSize) {
      singletons += members.length;
      continue;
    }
    members.sort((a, b) => b.hitCount - a.hitCount);
    clusters.push({
      id: id++,
      size: members.length,
      frequency: members.reduce((n, m) => n + m.hitCount, 0),
      representativeQuestion: members[0]!.text,
      sampleQuestions: members.slice(0, 5).map((m) => m.text),
    });
  }
  clusters.sort((a, b) => b.frequency - a.frequency);
  clusters.forEach((c, i) => { c.id = i; });

  return {
    generatedAt: nowIso,
    window: { fromIso: opts.fromIso, toIso: opts.toIso },
    model: opts.model,
    similarityThreshold,
    minClusterSize,
    totalQuestions: raws.length,
    uniqueQuestions: byHash.size,
    newEmbeddingsComputed: stats.misses,
    cacheHits: stats.hits,
    embeddingTokensIn: stats.tokensIn,
    clusters,
    singletons,
  };
}

export async function saveTopicReport(store: JsonStore, report: TopicReport): Promise<string> {
  const date = report.generatedAt.slice(0, 10);
  const key = `analytics/topics/${date}.json`;
  await store.putJson(key, report);
  return key;
}
