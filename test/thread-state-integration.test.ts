import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FsJsonStore } from '../src/state/fs.js';
import {
  loadOrCreateThreadState,
  saveThreadState,
  extractSignalsFromText,
  mergeSignalsIntoState,
  recordTurnCompleted,
  renderThreadStateForPrompt,
} from '../src/state/thread-state.js';

const KNOWN = ['HKI2', 'HKI3', 'TRE2', 'POR2', 'HAN1', 'JOE1', 'TKU1', 'TKU2', 'JYL1', 'VSA2'];

describe('thread-state round-trip via FsJsonStore', () => {
  let dir: string;
  let store: FsJsonStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'thread-state-'));
    store = new FsJsonStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persists and reloads a fresh thread state end-to-end', async () => {
    // Turn 1: user asks about HKI2 and reservation 717463067
    let state = await loadOrCreateThreadState(store, {
      threadTs: '1776864056.540009',
      channel: 'D0ATW505X3P',
      tenantId: 'tenant-omena',
    });
    expect(state.turnCount).toBe(0);
    expect(state.hotelLabels).toEqual([]);

    state = mergeSignalsIntoState(
      state,
      extractSignalsFromText('OTB for HKI2 reservation 717463067 please', KNOWN),
    );
    state = recordTurnCompleted(state, {
      toolName: 'mcp__nelson__psql',
      costUsd: 0.12,
      numTurns: 5,
      deepResearchCalls: 0,
      effectiveQuestion: 'OTB for HKI2 as of now',
      botReplySnippet: 'HKI2 on 2026-05-04: 64 RN / €3,675 net.',
    });
    await saveThreadState(store, state);

    // Simulate bot restart — new store instance pointing at the same dir
    const store2 = new FsJsonStore(dir);
    const restored = await loadOrCreateThreadState(store2, {
      threadTs: '1776864056.540009',
      channel: 'D0ATW505X3P',
      tenantId: 'tenant-omena',
    });

    expect(restored.hotelLabels).toEqual(['HKI2']);
    expect(restored.reservationCodes).toEqual(['717463067']);
    expect(restored.turnCount).toBe(1);
    expect(restored.toolsUsedCounts['mcp__nelson__psql']).toBe(1);
    expect(restored.totalCostUsd).toBeCloseTo(0.12);
    expect(restored.lastEffectiveQuestion).toBe('OTB for HKI2 as of now');
    expect(restored.lastBotReplySnippet).toContain('HKI2 on 2026-05-04');
  });

  it('carries scope across turns when follow-up message is short', async () => {
    let state = await loadOrCreateThreadState(store, {
      threadTs: 't-follow-up',
      channel: 'D1',
      tenantId: 'tenant1',
    });
    // Turn 1: original question with HKI2
    state = mergeSignalsIntoState(state, extractSignalsFromText('how many arrivals today at HKI2?', KNOWN));
    state = recordTurnCompleted(state, {
      toolName: 'mcp__nelson__nelson_api',
      botReplySnippet: '12 arrivals today at HKI2.',
    });
    await saveThreadState(store, state);

    // Simulate next turn — user just says "what about POR2?"
    state = await loadOrCreateThreadState(store, {
      threadTs: 't-follow-up',
      channel: 'D1',
      tenantId: 'tenant1',
    });
    expect(state.hotelLabels).toEqual(['HKI2']); // prior scope preserved

    state = mergeSignalsIntoState(state, extractSignalsFromText('what about POR2?', KNOWN));
    expect(state.hotelLabels).toEqual(['HKI2', 'POR2']); // new hotel accumulates

    const rendered = renderThreadStateForPrompt(state);
    expect(rendered).toContain('HKI2');
    expect(rendered).toContain('POR2');
    expect(rendered).toContain('12 arrivals today at HKI2');
  });

  it('accumulates cost + tool counts across multiple turns', async () => {
    let state = await loadOrCreateThreadState(store, { threadTs: 't-multi', channel: 'D1', tenantId: 'tenant1' });
    state = recordTurnCompleted(state, { toolName: 'mcp__nelson__psql', costUsd: 0.10, numTurns: 3, deepResearchCalls: 0 });
    state = recordTurnCompleted(state, { toolName: 'mcp__nelson__psql', costUsd: 0.08, numTurns: 2, deepResearchCalls: 1 });
    state = recordTurnCompleted(state, { toolName: 'mcp__nelson__nelson_api', costUsd: 0.06, numTurns: 4, deepResearchCalls: 0 });
    await saveThreadState(store, state);

    const restored = await loadOrCreateThreadState(store, { threadTs: 't-multi', channel: 'D1', tenantId: 'tenant1' });
    expect(restored.turnCount).toBe(3);
    expect(restored.totalCostUsd).toBeCloseTo(0.24);
    expect(restored.totalNumTurns).toBe(9);
    expect(restored.totalDeepResearchCalls).toBe(1);
    expect(restored.toolsUsedCounts['mcp__nelson__psql']).toBe(2);
    expect(restored.toolsUsedCounts['mcp__nelson__nelson_api']).toBe(1);
  });

  it('does not pollute a different thread (scope is thread-local)', async () => {
    let a = await loadOrCreateThreadState(store, { threadTs: 'a', channel: 'D1', tenantId: 't1' });
    a = mergeSignalsIntoState(a, extractSignalsFromText('HKI2 now', KNOWN));
    await saveThreadState(store, a);

    const b = await loadOrCreateThreadState(store, { threadTs: 'b', channel: 'D1', tenantId: 't1' });
    expect(b.hotelLabels).toEqual([]); // NOT HKI2
  });

  it('detects chain-wide phrasing and doesn\'t invent hotel labels', async () => {
    let state = await loadOrCreateThreadState(store, { threadTs: 'cw', channel: 'D1', tenantId: 't1' });
    const signals = extractSignalsFromText('revenue across all hotels this week', KNOWN);
    expect(signals.chainWide).toBe(true);
    expect(signals.hotelLabels).toEqual([]);
    state = mergeSignalsIntoState(state, signals);
    expect(state.hotelLabels).toEqual([]);
  });

  it('leniently parses an older on-disk record instead of crashing', async () => {
    // Write a record that looks like a prior version (missing some newer fields).
    // loadOrCreateThreadState should fall back to starting fresh, not throw.
    await store.putJson('threads/legacy-thread.json', {
      schema: 0, // wrong schema
      threadTs: 'legacy-thread',
    } as unknown as Parameters<typeof store.putJson>[1]);

    const state = await loadOrCreateThreadState(store, {
      threadTs: 'legacy-thread',
      channel: 'D1',
      tenantId: 't1',
    });
    expect(state.schema).toBe(1);
    expect(state.turnCount).toBe(0); // reset, not corrupt
  });

  it('caps hotel list at 20 to prevent runaway growth on pathological threads', async () => {
    let state = await loadOrCreateThreadState(store, { threadTs: 'big', channel: 'D1', tenantId: 't1' });
    // Feed 25 different labels (more than the 10 real ones + duplicates)
    for (let i = 0; i < 25; i++) {
      state = mergeSignalsIntoState(state, {
        hotelLabels: [`FAKE${i}`],
        reservationCodes: [],
        reservationUuids: [],
        otaConfirmationIds: [],
        chainWide: false,
      });
    }
    expect(state.hotelLabels.length).toBeLessThanOrEqual(20);
  });

  it('render output stays under a sensible size cap', async () => {
    let state = await loadOrCreateThreadState(store, { threadTs: 'sz', channel: 'D1', tenantId: 't1' });
    state = mergeSignalsIntoState(state, extractSignalsFromText('HKI2 HKI3 POR2 HAN1 JOE1 TKU1 TKU2 TRE2 JYL1 VSA2', KNOWN));
    state = recordTurnCompleted(state, {
      effectiveQuestion: 'a'.repeat(5000),       // deliberately over 800
      botReplySnippet: 'b'.repeat(5000),         // deliberately over 800
    });
    const rendered = renderThreadStateForPrompt(state) ?? '';
    expect(rendered.length).toBeLessThan(3000); // well under Bedrock/Slack danger zone
  });
});
