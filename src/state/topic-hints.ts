import type { JsonStore } from './types.js';
import type { TopicReport, TopicReportCluster } from '../analytics/topics.js';
import { normalizeQuestion } from './embedding-cache.js';
import { logger } from '../observability/logger.js';

// Load the most recent topics report so the pipeline can surface cluster
// hints per turn. Picks the lexicographically-largest date key — since keys
// are `analytics/topics/YYYY-MM-DD.json`, that is the newest report.
export async function loadLatestTopicReport(store: JsonStore): Promise<TopicReport | null> {
  const keys = await store.listKeys('analytics/topics/');
  if (keys.length === 0) return null;
  keys.sort();
  const latestKey = keys[keys.length - 1]!;
  const rec = await store.getJson<TopicReport>(latestKey).catch((err) => {
    logger.warn({ err, key: latestKey }, 'topic report load failed');
    return null;
  });
  return rec ? rec.value : null;
}

export interface TopicHintMatch {
  cluster: TopicReportCluster;
  matchedPhrase: string;
}

// Substring match on the normalised question text against each cluster's
// sampleQuestions + representativeQuestion. Returns at most `maxMatches`
// clusters, ranked by cluster frequency (most-asked first).
export function matchTopicHints(
  question: string,
  report: TopicReport | null,
  opts: { maxMatches?: number } = {},
): TopicHintMatch[] {
  if (!report || report.clusters.length === 0) return [];
  const maxMatches = opts.maxMatches ?? 2;
  const q = normalizeQuestion(question);
  if (q.length === 0) return [];

  const matches: TopicHintMatch[] = [];
  for (const cluster of report.clusters) {
    const candidates = [cluster.representativeQuestion, ...cluster.sampleQuestions];
    let best: string | undefined;
    for (const cand of candidates) {
      const n = normalizeQuestion(cand);
      if (n.length === 0) continue;
      // Match both ways: question contains sample fragment OR sample contains question fragment.
      // That covers short follow-up fragments like "HKI2?" matching a cluster of fuller questions.
      if (q.includes(n) || n.includes(q)) {
        if (!best || n.length > best.length) best = cand;
      }
    }
    if (best) matches.push({ cluster, matchedPhrase: best });
  }
  matches.sort((a, b) => b.cluster.frequency - a.cluster.frequency);
  return matches.slice(0, maxMatches);
}

// Render matched clusters as a pre-injection block. Returns undefined when no
// matches so the caller can skip the header entirely.
export function renderTopicHintsForPrompt(matches: TopicHintMatch[]): string | undefined {
  if (matches.length === 0) return undefined;
  const blocks = matches.map(({ cluster }) => {
    const samples = cluster.sampleQuestions.slice(0, 3).map((s) => `"${s}"`).join(', ');
    return [
      `* cluster ${cluster.id} — asked ${cluster.frequency}× (${cluster.size} variants)`,
      `  Representative: "${cluster.representativeQuestion}"`,
      `  Similar past questions: ${samples}`,
    ].join('\n');
  });
  return [
    '=== COMMON TOPIC MATCH (this question matches a frequent cluster — prior answers worked) ===',
    ...blocks,
    '=== END COMMON TOPIC MATCH ===',
  ].join('\n\n');
}
