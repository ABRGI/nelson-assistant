import { z } from 'zod';
import type { JsonStore } from './types.js';
import { logger } from '../observability/logger.js';

// Phase E Part 3: Decision memory.
//
// When a `/debug` or `/learning` session identifies a wrong-answer pattern
// and applies a fix (to a leaf, the runner seed, or the classifier), we
// persist a distilled record at `decisions/<slug>.json`. On subsequent
// questions the pipeline matches the incoming message against the
// `recognise_phrases` on every decision and pre-injects the matching
// decisions above the leaf content — so Sonnet reads "we already figured
// this out last time, here's the correct behaviour" BEFORE reaching for
// tools or source reads.
//
// Decisions are bounded, human-authored distillations — NOT raw event
// logs. Think of them as the "lessons learned" index that `/train`
// consumes and that `/learning` writes to after a fix.

export const DecisionSchema = z.object({
  schema: z.literal(1),
  slug: z.string().min(1).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be kebab-case'),
  version: z.number().int().positive().default(1),
  created: z.string(),
  updated: z.string(),

  // One-sentence summary of the failure class.
  failure_pattern: z.string().min(1),

  // Phrases that — when they appear in a user question — should surface this
  // decision. Matched case-insensitively via substring. Use `specific & short`
  // fragments (e.g. "same time last year", "as of now vs last year") rather
  // than full sentences. 3–10 phrases is the right fit.
  recognise_phrases: z.array(z.string().min(3)).min(1).max(20),

  // What the bot MUST do when it sees this pattern.
  correct_behaviour: z.string().min(1),

  // What the bot tends to do instead — the common wrong answer.
  wrong_behaviour: z.string().optional(),

  // Knowledge leaves / code files that already carry the fix, so readers
  // know where to look to extend it.
  related_leaves: z.array(z.string()).default([]),
  related_commits: z.array(z.string()).default([]),

  // Slack thread ts values where this was first diagnosed — for auditability.
  source_threads: z.array(z.string()).default([]),

  // Scope restrictions. Empty/omitted = applies to all tenants.
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

// Cheap case-insensitive substring match. No embeddings yet (that's Phase F).
// If the incoming question contains any of a decision's recognise_phrases,
// the decision is a match. Returns decisions ranked by specificity (longest
// matched phrase first) so the most-precise decision is listed first.
export function matchDecisions(
  question: string,
  decisions: Decision[],
  opts: { tenantId?: string; maxMatches?: number } = {},
): Decision[] {
  const q = question.toLowerCase();
  const scored: Array<{ decision: Decision; matchLen: number }> = [];
  for (const d of decisions) {
    if (d.tenantId && opts.tenantId && d.tenantId !== opts.tenantId) continue;
    let bestMatchLen = 0;
    for (const phrase of d.recognise_phrases) {
      if (q.includes(phrase.toLowerCase()) && phrase.length > bestMatchLen) {
        bestMatchLen = phrase.length;
      }
    }
    if (bestMatchLen > 0) scored.push({ decision: d, matchLen: bestMatchLen });
  }
  scored.sort((a, b) => b.matchLen - a.matchLen);
  const max = opts.maxMatches ?? 3;
  return scored.slice(0, max).map((s) => s.decision);
}

// Render matched decisions as a pre-injection block for the Sonnet system
// prompt. Lives above the leaf content so Sonnet reads the distilled fix
// BEFORE reaching for tools. Returns undefined when no matches.
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
