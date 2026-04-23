import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FsJsonStore } from '../src/state/fs.js';
import { buildBundleGapReport, saveBundleGapReport } from '../src/analytics/bundle-gap.js';

// Minimal event factory — matches the shape ChatLog.append writes to disk.
function event(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    eventId: overrides.eventId ?? `ev-${Math.random().toString(36).slice(2, 10)}`,
    eventTs: overrides.eventTs ?? new Date().toISOString(),
    kind: overrides.kind ?? 'message_received',
    threadTs: overrides.threadTs ?? 't1',
    channel: overrides.channel ?? 'C1',
    slackUserId: overrides.slackUserId ?? 'U1',
    tenantId: overrides.tenantId ?? 'tenant-a',
    detail: overrides.detail ?? {},
  };
}

async function writeEvent(store: FsJsonStore, ev: Record<string, unknown>): Promise<void> {
  const date = String(ev.eventTs).slice(0, 10);
  const key = `chatlog/${date}/${ev.threadTs}/${ev.eventTs}-${ev.eventId}.json`;
  await store.putJson(key, ev);
}

describe('bundle-gap analytics', () => {
  let dir: string;
  let store: FsJsonStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'bundle-gap-'));
    store = new FsJsonStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('aggregates cost, tools and deep_research across a thread', async () => {
    const ts = '2026-04-22T10:00:00.000Z';
    await writeEvent(store, event({ threadTs: 't1', eventTs: ts, kind: 'message_received', detail: { text: 'OTB for HKI2 on May 5th' } }));
    await writeEvent(store, event({ threadTs: 't1', eventTs: '2026-04-22T10:00:01.000Z', kind: 'classifier_verdict', detail: { type: 'data_query', effective_question: 'OTB for HKI2 on 2026-05-05' } }));
    await writeEvent(store, event({ threadTs: 't1', eventTs: '2026-04-22T10:00:02.000Z', kind: 'tool_use', detail: { name: 'mcp__nelson__psql' } }));
    await writeEvent(store, event({ threadTs: 't1', eventTs: '2026-04-22T10:00:03.000Z', kind: 'tool_use', detail: { name: 'mcp__nelson__deep_research' } }));
    await writeEvent(store, event({
      threadTs: 't1', eventTs: '2026-04-22T10:00:04.000Z', kind: 'agent_reply',
      detail: {
        reply: 'HKI2 OTB on 2026-05-05: 67 RN / €3,912.17',
        lastToolName: 'mcp__nelson__psql',
        cost: { totalCostUsd: 0.23, numTurns: 8, deepResearchCalls: 1 },
        confidence: { score: 9, hedges: [] },
      },
    }));

    const report = await buildBundleGapReport(store, {
      fromIso: '2026-04-22T00:00:00.000Z',
      toIso: '2026-04-22T23:59:59.000Z',
    });
    expect(report.totalThreads).toBe(1);
    expect(report.costSummary.totalUsd).toBeCloseTo(0.23);
    expect(report.deepResearchSummary.totalTriggers).toBe(1);
    const t1 = report.flaggedThreads.find((a) => a.threadTs === 't1');
    expect(t1).toBeDefined();
    expect(t1!.flagReasons).toContain('deep_research_triggered');
    expect(t1!.toolsUsed['mcp__nelson__psql']).toBe(1);
    expect(t1!.toolsUsed['mcp__nelson__deep_research']).toBe(1);
    expect(t1!.lastToolName).toBe('mcp__nelson__psql');
    expect(t1!.totalCostUsd).toBeCloseTo(0.23);
  });

  it('flags high-cost threads above threshold', async () => {
    await writeEvent(store, event({ threadTs: 'expensive', kind: 'agent_reply', detail: { cost: { totalCostUsd: 0.80, numTurns: 15 } } }));
    await writeEvent(store, event({ threadTs: 'cheap', kind: 'agent_reply', detail: { cost: { totalCostUsd: 0.05, numTurns: 2 } } }));

    const report = await buildBundleGapReport(store, { fromIso: '1970-01-01T00:00:00Z', toIso: '2030-01-01T00:00:00Z' });
    const flagged = report.flaggedThreads.map((f) => f.threadTs);
    expect(flagged).toContain('expensive');
    expect(flagged).not.toContain('cheap');
  });

  it('flags low-confidence threads', async () => {
    await writeEvent(store, event({ threadTs: 'shaky', kind: 'agent_reply', detail: { confidence: { score: 3, hedges: ['no_source_footer'] } } }));
    await writeEvent(store, event({ threadTs: 'solid', kind: 'agent_reply', detail: { confidence: { score: 9, hedges: [] } } }));

    const report = await buildBundleGapReport(store, { fromIso: '1970-01-01T00:00:00Z', toIso: '2030-01-01T00:00:00Z' });
    const flagged = report.flaggedThreads.map((f) => f.threadTs);
    expect(flagged).toContain('shaky');
    expect(flagged).not.toContain('solid');
  });

  it('flags negative user_feedback', async () => {
    await writeEvent(store, event({ threadTs: 'unhappy', kind: 'user_feedback', detail: { sentiment: 'negative', source: 'reaction', reaction: '-1' } }));
    await writeEvent(store, event({ threadTs: 'happy', kind: 'user_feedback', detail: { sentiment: 'positive', source: 'reaction', reaction: '+1' } }));

    const report = await buildBundleGapReport(store, { fromIso: '1970-01-01T00:00:00Z', toIso: '2030-01-01T00:00:00Z' });
    expect(report.flaggedThreads.map((f) => f.threadTs)).toContain('unhappy');
    expect(report.feedbackSummary.negative).toBe(1);
    expect(report.feedbackSummary.positive).toBe(1);
    expect(report.feedbackSummary.threadsWithNegative).toEqual(['unhappy']);
  });

  it('does not flag a clean thread', async () => {
    await writeEvent(store, event({
      threadTs: 'perfect', kind: 'agent_reply',
      detail: { cost: { totalCostUsd: 0.10, numTurns: 3, deepResearchCalls: 0 }, confidence: { score: 10, hedges: [] } },
    }));
    const report = await buildBundleGapReport(store, { fromIso: '1970-01-01T00:00:00Z', toIso: '2030-01-01T00:00:00Z' });
    expect(report.flaggedThreads.map((f) => f.threadTs)).not.toContain('perfect');
  });

  it('respects the time window — excludes events outside', async () => {
    await writeEvent(store, event({ threadTs: 'old', eventTs: '2025-01-01T00:00:00Z', kind: 'agent_reply', detail: { cost: { totalCostUsd: 5.0 } } }));
    await writeEvent(store, event({ threadTs: 'new', eventTs: '2026-04-23T00:00:00Z', kind: 'agent_reply', detail: { cost: { totalCostUsd: 0.2 } } }));
    const report = await buildBundleGapReport(store, { fromIso: '2026-04-22T00:00:00Z', toIso: '2026-04-24T00:00:00Z' });
    expect(report.totalThreads).toBe(1);
    expect(report.flaggedThreads.map((f) => f.threadTs)).not.toContain('old');
  });

  it('ranks top-cost threads and computes p95', async () => {
    for (let i = 0; i < 10; i++) {
      await writeEvent(store, event({ threadTs: `t${i}`, kind: 'agent_reply', detail: { cost: { totalCostUsd: 0.01 * (i + 1) } } }));
    }
    const report = await buildBundleGapReport(store, { fromIso: '1970-01-01T00:00:00Z', toIso: '2030-01-01T00:00:00Z' });
    expect(report.costSummary.topByCost).toHaveLength(10);
    expect(report.costSummary.topByCost[0]!.threadTs).toBe('t9');    // highest
    expect(report.costSummary.p95UsdPerThread).toBeGreaterThanOrEqual(0.08);
  });

  it('groups deep_research triggers by effective_question', async () => {
    await writeEvent(store, event({ threadTs: 'a', eventTs: '2026-04-22T10:00:00Z', kind: 'classifier_verdict', detail: { effective_question: 'BUI component location' } }));
    await writeEvent(store, event({ threadTs: 'a', eventTs: '2026-04-22T10:00:01Z', kind: 'tool_use', detail: { name: 'mcp__nelson__deep_research' } }));
    await writeEvent(store, event({ threadTs: 'a', eventTs: '2026-04-22T10:00:02Z', kind: 'agent_reply', detail: { cost: { deepResearchCalls: 1 } } }));

    const report = await buildBundleGapReport(store, { fromIso: '1970-01-01T00:00:00Z', toIso: '2030-01-01T00:00:00Z' });
    expect(report.deepResearchSummary.byEffectiveQuestion[0]!.effective_question).toContain('BUI component location');
  });

  it('persists the report under analytics/bundle-gaps/<date>.json', async () => {
    await writeEvent(store, event({ threadTs: 'x', kind: 'agent_reply', detail: { cost: { totalCostUsd: 0.05 } } }));
    const report = await buildBundleGapReport(store, { fromIso: '1970-01-01T00:00:00Z', toIso: '2030-01-01T00:00:00Z' });
    const key = await saveBundleGapReport(store, report);
    expect(key).toMatch(/^analytics\/bundle-gaps\/\d{4}-\d{2}-\d{2}\.json$/);
    const readBack = await store.getJson(key);
    expect(readBack).toBeTruthy();
  });
});
