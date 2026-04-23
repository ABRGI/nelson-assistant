import { z } from 'zod';
import type { JsonStore } from './types.js';
import { logger } from '../observability/logger.js';

export const DecisionSchema = z.object({
  schema: z.literal(1),
  slug: z.string().min(1).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be kebab-case'),
  version: z.number().int().positive().default(1),
  created: z.string(),
  updated: z.string(),
  failure_pattern: z.string().min(1),
  // 3–10 short fragments (e.g. "same time last year") rather than full sentences.
  recognise_phrases: z.array(z.string().min(3)).min(1).max(20),
  correct_behaviour: z.string().min(1),
  wrong_behaviour: z.string().optional(),
  related_leaves: z.array(z.string()).default([]),
  related_commits: z.array(z.string()).default([]),
  source_threads: z.array(z.string()).default([]),
  // Omitted = applies to all tenants.
  tenantId: z.string().optional(),
});
export type Decision = z.infer<typeof DecisionSchema>;

function keyFor(slug: string): string {
  return `decisions/${slug}.json`;
}

export async function saveDecision(store: JsonStore, decision: Decision): Promise<void> {
  const parsed = DecisionSchema.parse({ ...decision, updated: new Date().toISOString() });
  await store.putJson(keyFor(parsed.slug), parsed);
}

export async function loadAllDecisions(store: JsonStore): Promise<Decision[]> {
  const keys = await store.listKeys('decisions/');
  const out: Decision[] = [];
  for (const key of keys) {
    const rec = await store.getJson<unknown>(key).catch((err) => {
      logger.warn({ err, key }, 'decision load failed — skipping');
      return null;
    });
    if (!rec) continue;
    const parsed = DecisionSchema.safeParse(rec.value);
    if (parsed.success) out.push(parsed.data);
    else logger.warn({ err: parsed.error, key }, 'decision schema mismatch — skipping');
  }
  return out;
}

export async function loadDecision(store: JsonStore, slug: string): Promise<Decision | null> {
  const rec = await store.getJson<unknown>(keyFor(slug)).catch(() => null);
  if (!rec) return null;
  const parsed = DecisionSchema.safeParse(rec.value);
  return parsed.success ? parsed.data : null;
}

// Per-decision lower-cased phrase cache — amortises toLowerCase across turns.
const lcPhraseCache = new WeakMap<Decision, string[]>();
function lcPhrases(d: Decision): string[] {
  let cached = lcPhraseCache.get(d);
  if (!cached) {
    cached = d.recognise_phrases.map((p) => p.toLowerCase());
    lcPhraseCache.set(d, cached);
  }
  return cached;
}

// Returns decisions ranked by specificity (longest matched phrase first).
export function matchDecisions(
  question: string,
  decisions: Decision[],
  opts: { tenantId?: string; maxMatches?: number } = {},
): Decision[] {
  if (decisions.length === 0) return [];
  const q = question.toLowerCase();
  const scored: Array<{ decision: Decision; matchLen: number }> = [];
  for (const d of decisions) {
    if (d.tenantId && opts.tenantId && d.tenantId !== opts.tenantId) continue;
    let bestMatchLen = 0;
    for (const phrase of lcPhrases(d)) {
      if (q.includes(phrase) && phrase.length > bestMatchLen) {
        bestMatchLen = phrase.length;
      }
    }
    if (bestMatchLen > 0) scored.push({ decision: d, matchLen: bestMatchLen });
  }
  scored.sort((a, b) => b.matchLen - a.matchLen);
  const max = opts.maxMatches ?? 3;
  return scored.slice(0, max).map((s) => s.decision);
}

export function renderDecisionsForPrompt(decisions: Decision[]): string | undefined {
  if (decisions.length === 0) return undefined;
  const blocks = decisions.map((d) => {
    const lines: string[] = [
      `* ${d.slug}* (v${d.version}, ${d.failure_pattern})`,
      `  CORRECT: ${d.correct_behaviour}`,
    ];
    if (d.wrong_behaviour) lines.push(`  AVOID:   ${d.wrong_behaviour}`);
    if (d.related_leaves.length) lines.push(`  Related leaves: ${d.related_leaves.join(', ')}`);
    return lines.join('\n');
  });
  return [
    '=== PRIOR DECISIONS (matched this question) — apply these BEFORE reaching for tools ===',
    ...blocks,
    '=== END PRIOR DECISIONS ===',
  ].join('\n\n');
}
