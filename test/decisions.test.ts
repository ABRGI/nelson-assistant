import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FsJsonStore } from '../src/state/fs.js';
import {
  saveDecision,
  loadAllDecisions,
  loadDecision,
  matchDecisions,
  renderDecisionsForPrompt,
  type Decision,
} from '../src/state/decisions.js';

function mkDecision(overrides: Partial<Decision> = {}): Decision {
  const now = new Date().toISOString();
  return {
    schema: 1 as const,
    slug: overrides.slug ?? 'test-decision',
    version: overrides.version ?? 1,
    created: overrides.created ?? now,
    updated: overrides.updated ?? now,
    failure_pattern: overrides.failure_pattern ?? 'Test failure pattern',
    recognise_phrases: overrides.recognise_phrases ?? ['test phrase'],
    correct_behaviour: overrides.correct_behaviour ?? 'Do this correctly',
    wrong_behaviour: overrides.wrong_behaviour,
    related_leaves: overrides.related_leaves ?? [],
    related_commits: overrides.related_commits ?? [],
    source_threads: overrides.source_threads ?? [],
    tenantId: overrides.tenantId,
  };
}

describe('decision store round-trip', () => {
  let dir: string;
  let store: FsJsonStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'decisions-'));
    store = new FsJsonStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persists and reloads a decision by slug', async () => {
    const d = mkDecision({ slug: 'otb-vs-current-total', recognise_phrases: ['otb vs same time last year'] });
    await saveDecision(store, d);
    const loaded = await loadDecision(store, 'otb-vs-current-total');
    expect(loaded).not.toBeNull();
    expect(loaded!.recognise_phrases).toEqual(['otb vs same time last year']);
  });

  it('loadAllDecisions skips records with a bad schema', async () => {
    await saveDecision(store, mkDecision({ slug: 'valid-one' }));
    await store.putJson('decisions/malformed.json', { foo: 'bar' }); // invalid shape
    const all = await loadAllDecisions(store);
    expect(all.map((d) => d.slug)).toEqual(['valid-one']);
  });

  it('rejects a slug that is not kebab-case', async () => {
    await expect(saveDecision(store, mkDecision({ slug: 'Not Kebab' }))).rejects.toThrow();
  });
});

describe('matchDecisions', () => {
  it('matches a phrase that appears verbatim in the question', () => {
    const d = mkDecision({ slug: 'a', recognise_phrases: ['same time last year'] });
    const matches = matchDecisions('OTB for HKI2 same time last year', [d]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.slug).toBe('a');
  });

  it('is case-insensitive', () => {
    const d = mkDecision({ slug: 'a', recognise_phrases: ['arrivals today'] });
    expect(matchDecisions('ARRIVALS TODAY at HKI2', [d])).toHaveLength(1);
  });

  it('does not match when no phrase appears', () => {
    const d = mkDecision({ slug: 'a', recognise_phrases: ['advance invoice'] });
    expect(matchDecisions('how many arrivals today?', [d])).toHaveLength(0);
  });

  it('ranks longer-phrase matches first (more specific)', () => {
    const general = mkDecision({ slug: 'general', recognise_phrases: ['OTB'] });
    const specific = mkDecision({ slug: 'specific', recognise_phrases: ['OTB vs same time last year'] });
    const matches = matchDecisions('show me OTB vs same time last year for HKI2', [general, specific]);
    expect(matches[0]!.slug).toBe('specific');
    expect(matches[1]!.slug).toBe('general');
  });

  it('respects tenantId scoping', () => {
    const tenantA = mkDecision({ slug: 'a', recognise_phrases: ['foo'], tenantId: 'tenant-a' });
    const global = mkDecision({ slug: 'g', recognise_phrases: ['foo'] });
    const matches = matchDecisions('foo bar', [tenantA, global], { tenantId: 'tenant-b' });
    expect(matches.map((d) => d.slug)).toEqual(['g']); // tenant-a excluded
  });

  it('caps at maxMatches', () => {
    const ds = [1, 2, 3, 4, 5].map((i) => mkDecision({ slug: `d${i}`, recognise_phrases: ['xx'] }));
    expect(matchDecisions('xx', ds, { maxMatches: 2 })).toHaveLength(2);
  });
});

describe('renderDecisionsForPrompt', () => {
  it('returns undefined when nothing matches', () => {
    expect(renderDecisionsForPrompt([])).toBeUndefined();
  });

  it('wraps matches in PRIOR DECISIONS markers and includes correct + avoid lines', () => {
    const d = mkDecision({
      slug: 'otb-vs-current',
      failure_pattern: 'Returning current total instead of OTB snapshot',
      correct_behaviour: 'Use canonical_sql.otb_at_snapshot',
      wrong_behaviour: 'Plain line_item sum',
    });
    const out = renderDecisionsForPrompt([d]) ?? '';
    expect(out).toContain('PRIOR DECISIONS');
    expect(out).toContain('otb-vs-current');
    expect(out).toContain('CORRECT: Use canonical_sql.otb_at_snapshot');
    expect(out).toContain('AVOID:   Plain line_item sum');
  });
});
