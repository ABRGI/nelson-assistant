import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { JsonStore } from './types.js';
import type { TitanEmbedder } from '../agent/embed.js';
import { logger } from '../observability/logger.js';

// Persistent dedupe cache for Titan embeddings. One file per unique normalised
// question; reruns skip Bedrock when the cache has a hit.

export const EmbeddingRecordSchema = z.object({
  schema: z.literal(1),
  text: z.string(),
  normalized: z.string(),
  model: z.string(),
  dimensions: z.number().int().positive(),
  vector: z.array(z.number()),
  firstSeenIso: z.string(),
  lastSeenIso: z.string(),
  hitCount: z.number().int().nonnegative(),
});
export type EmbeddingRecord = z.infer<typeof EmbeddingRecordSchema>;

export function normalizeQuestion(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s ]+/g, ' ')
    .replace(/^[\s"'.,;:!?()\[\]{}<>-]+|[\s"'.,;:!?()\[\]{}<>-]+$/g, '')
    .trim();
}

export function hashNormalized(normalized: string): string {
  return createHash('sha256').update(normalized, 'utf-8').digest('hex').slice(0, 16);
}

function keyFor(hash: string): string {
  return `analytics/embeddings/${hash}.json`;
}

export interface EmbeddingCacheStats {
  hits: number;
  misses: number;
  tokensIn: number;
}

// Look up or compute the embedding for a question. On a hit, bumps
// lastSeenIso + hitCount. On a miss, calls the embedder and persists.
export async function getOrEmbed(
  store: JsonStore,
  embedder: TitanEmbedder,
  modelId: string,
  rawText: string,
  nowIso: string,
  stats?: EmbeddingCacheStats,
): Promise<EmbeddingRecord> {
  const normalized = normalizeQuestion(rawText);
  if (normalized.length === 0) {
    throw new Error('normalizeQuestion returned empty — skip before calling getOrEmbed');
  }
  const hash = hashNormalized(normalized);
  const key = keyFor(hash);

  const existing = await store.getJson<unknown>(key).catch(() => null);
  if (existing) {
    const parsed = EmbeddingRecordSchema.safeParse(existing.value);
    if (parsed.success && parsed.data.model === modelId) {
      const updated: EmbeddingRecord = {
        ...parsed.data,
        lastSeenIso: nowIso,
        hitCount: parsed.data.hitCount + 1,
      };
      await store.putJson(key, updated);
      if (stats) stats.hits += 1;
      return updated;
    }
    logger.warn({ key, modelId }, 'embedding cache record invalid or wrong model — recomputing');
  }

  const { vector, usage } = await embedder.embed(normalized);
  const record: EmbeddingRecord = {
    schema: 1,
    text: rawText,
    normalized,
    model: modelId,
    dimensions: vector.length,
    vector,
    firstSeenIso: nowIso,
    lastSeenIso: nowIso,
    hitCount: 1,
  };
  await store.putJson(key, record);
  if (stats) {
    stats.misses += 1;
    stats.tokensIn += usage.inputTokens;
  }
  return record;
}
