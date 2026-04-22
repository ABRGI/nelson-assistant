import { describe, it, expect } from 'vitest';
import {
  extractSignalsFromText,
  mergeSignalsIntoState,
  recordTurnCompleted,
  renderThreadStateForPrompt,
  type ThreadState,
} from '../src/state/thread-state.js';

const KNOWN = ['HKI2', 'HKI3', 'TRE2', 'POR2', 'HAN1', 'JOE1'];

function emptyState(): ThreadState {
  return {
    schema: 1,
    threadTs: 't1',
    channel: 'C1',
    tenantId: 'tenant1',
    firstMessageAt: '2026-04-22T00:00:00Z',
    lastUpdatedAt: '2026-04-22T00:00:00Z',
    turnCount: 0,
    hotelLabels: [],
    reservationCodes: [],
    reservationUuids: [],
    otaConfirmationIds: [],
    metricCuts: [],
    channelFilters: [],
    dateScope: {},
    toolsUsedCounts: {},
    totalCostUsd: 0,
    totalNumTurns: 0,
    totalDeepResearchCalls: 0,
  };
}

describe('extractSignalsFromText', () => {
  it('pulls a 9-digit reservation code as reservation_code (not OTA)', () => {
    const s = extractSignalsFromText('advance invoice for reservation 717463067 please', KNOWN);
    expect(s.reservationCodes).toEqual(['717463067']);
    expect(s.otaConfirmationIds).toEqual([]);
  });
  it('pulls a 10-digit number as OTA confirmation id', () => {
    const s = extractSignalsFromText('BCom ref 6512678711', KNOWN);
    expect(s.otaConfirmationIds).toEqual(['6512678711']);
    expect(s.reservationCodes).toEqual([]);
  });
  it('detects a UUID', () => {
    const s = extractSignalsFromText('uuid is 5a8d0841-cf7c-4316-ad59-20394e93c817', KNOWN);
    expect(s.reservationUuids).toEqual(['5a8d0841-cf7c-4316-ad59-20394e93c817']);
  });
  it('detects multiple hotel labels case-insensitively', () => {
    const s = extractSignalsFromText('compare hki2 and POR2 and Han1', KNOWN);
    expect(s.hotelLabels.sort()).toEqual(['HAN1', 'HKI2', 'POR2']);
  });
  it('does not invent labels that are not in the known roster', () => {
    const s = extractSignalsFromText('what about XYZ4', KNOWN);
    expect(s.hotelLabels).toEqual([]);
  });
  it('detects chain-wide phrasings', () => {
    expect(extractSignalsFromText('across all hotels', KNOWN).chainWide).toBe(true);
    expect(extractSignalsFromText('chain-wide revenue', KNOWN).chainWide).toBe(true);
    expect(extractSignalsFromText('portfolio wide numbers', KNOWN).chainWide).toBe(true);
    expect(extractSignalsFromText('only at HKI2', KNOWN).chainWide).toBe(false);
  });
});

describe('mergeSignalsIntoState', () => {
  it('dedupes hotels and caps at 20', () => {
    let s = emptyState();
    s = mergeSignalsIntoState(s, { hotelLabels: ['HKI2','HKI3'], reservationCodes: [], reservationUuids: [], otaConfirmationIds: [], chainWide: false });
    s = mergeSignalsIntoState(s, { hotelLabels: ['HKI2','POR2'], reservationCodes: [], reservationUuids: [], otaConfirmationIds: [], chainWide: false });
    expect(s.hotelLabels).toEqual(['HKI2','HKI3','POR2']);
  });
  it('merges reservation codes across turns', () => {
    let s = emptyState();
    s = mergeSignalsIntoState(s, { hotelLabels: [], reservationCodes: ['717463067'], reservationUuids: [], otaConfirmationIds: [], chainWide: false });
    s = mergeSignalsIntoState(s, { hotelLabels: [], reservationCodes: ['123456789'], reservationUuids: [], otaConfirmationIds: [], chainWide: false });
    expect(s.reservationCodes).toEqual(['717463067','123456789']);
  });
});

describe('recordTurnCompleted', () => {
  it('increments turn count, cost, deep_research', () => {
    let s = emptyState();
    s = recordTurnCompleted(s, { toolName: 'mcp__nelson__psql', costUsd: 0.12, numTurns: 3, deepResearchCalls: 0, effectiveQuestion: 'q', botReplySnippet: 'ok' });
    expect(s.turnCount).toBe(1);
    expect(s.totalCostUsd).toBeCloseTo(0.12);
    expect(s.totalNumTurns).toBe(3);
    expect(s.toolsUsedCounts['mcp__nelson__psql']).toBe(1);
    s = recordTurnCompleted(s, { toolName: 'mcp__nelson__psql', costUsd: 0.08, numTurns: 2, deepResearchCalls: 1 });
    expect(s.turnCount).toBe(2);
    expect(s.totalCostUsd).toBeCloseTo(0.20);
    expect(s.totalDeepResearchCalls).toBe(1);
    expect(s.toolsUsedCounts['mcp__nelson__psql']).toBe(2);
  });
});

describe('renderThreadStateForPrompt', () => {
  it('returns undefined when nothing has been established yet', () => {
    expect(renderThreadStateForPrompt(emptyState())).toBeUndefined();
  });
  it('surfaces the populated fields and wraps in THREAD CONTEXT markers', () => {
    const s: ThreadState = { ...emptyState(), hotelLabels: ['HKI2'], reservationCodes: ['717463067'] };
    const rendered = renderThreadStateForPrompt(s);
    expect(rendered).toBeDefined();
    expect(rendered).toContain('THREAD CONTEXT');
    expect(rendered).toContain('HKI2');
    expect(rendered).toContain('717463067');
  });
});
