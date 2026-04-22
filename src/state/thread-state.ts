import { z } from 'zod';
import type { JsonStore } from './types.js';
import { logger } from '../observability/logger.js';

// Per-thread summary persisted at `threads/<threadTs>.json`. It is a compact,
// deterministic aggregation of what the pipeline has already captured in
// chatlog events — hotel scope, reservation ids referenced, metric cuts,
// tools-used history, rolling cost. The point is to survive bot restarts and
// to pre-inject established context into the classifier + Sonnet so we don't
// re-derive it from Slack history every turn.
//
// Write-last-wins is fine: the pipeline loads → mutates → writes at the end of
// each job, and only one job per threadTs runs at a time (the in-proc queue
// serialises per-thread work).

export const ThreadStateSchema = z.object({
  schema: z.literal(1),
  threadTs: z.string(),
  channel: z.string(),
  tenantId: z.string(),
  firstMessageAt: z.string(),
  lastUpdatedAt: z.string(),
  turnCount: z.number().int().nonnegative(),

  // Established context — merged across turns. Small, bounded sets.
  hotelLabels: z.array(z.string()).default([]),                 // e.g. ["HKI2","POR2"]
  reservationCodes: z.array(z.string()).default([]),            // 9-digit Nelson codes
  reservationUuids: z.array(z.string()).default([]),            // 36-char UUIDs
  otaConfirmationIds: z.array(z.string()).default([]),          // 10-digit OTA refs
  metricCuts: z.array(z.string()).default([]),                  // e.g. ["OTB_at_snapshot","YoY_-364d"]
  channelFilters: z.array(z.string()).default([]),              // e.g. ["BOOKINGCOM"]
  dateScope: z.object({
    stayDate: z.string().optional(),                            // YYYY-MM-DD
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    snapshotDate: z.string().optional(),
    compareTo: z.string().optional(),                           // e.g. "-364d DoW-aligned"
  }).default({}),

  // Rolling tool-use counts — for analytics + for telling Sonnet what's
  // already been tried this thread.
  toolsUsedCounts: z.record(z.string(), z.number().int().nonnegative()).default({}),

  // Cumulative cost across the thread so far.
  totalCostUsd: z.number().nonnegative().default(0),
  totalNumTurns: z.number().int().nonnegative().default(0),
  totalDeepResearchCalls: z.number().int().nonnegative().default(0),

  // The last Sonnet-side reply trimmed to ~500 chars. Used to jog context
  // when a follow-up message is short.
  lastBotReplySnippet: z.string().max(800).optional(),
  lastEffectiveQuestion: z.string().max(800).optional(),
});

export type ThreadState = z.infer<typeof ThreadStateSchema>;

export interface LoadOrCreateOpts {
  threadTs: string;
  channel: string;
  tenantId: string;
}

export async function loadOrCreateThreadState(
  store: JsonStore,
  opts: LoadOrCreateOpts,
): Promise<ThreadState> {
  const key = keyFor(opts.threadTs);
  const existing = await store.getJson<ThreadState>(key).catch((err) => {
    logger.warn({ err, key }, 'thread state load failed — starting fresh');
    return null;
  });
  if (existing) {
    // Be lenient: parse with defaults so an older record doesn't break.
    const parsed = ThreadStateSchema.safeParse(existing.value);
    if (parsed.success) return parsed.data;
    logger.warn({ err: parsed.error, key }, 'thread state schema mismatch — starting fresh');
  }
  const now = new Date().toISOString();
  return {
    schema: 1,
    threadTs: opts.threadTs,
    channel: opts.channel,
    tenantId: opts.tenantId,
    firstMessageAt: now,
    lastUpdatedAt: now,
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

export async function saveThreadState(store: JsonStore, state: ThreadState): Promise<void> {
  try {
    await store.putJson(keyFor(state.threadTs), { ...state, lastUpdatedAt: new Date().toISOString() });
  } catch (err) {
    logger.warn({ err, threadTs: state.threadTs }, 'thread state save failed — continuing');
  }
}

function keyFor(threadTs: string): string {
  return `threads/${threadTs}.json`;
}

// Render the thread state as a short mrkdwn-free block the classifier + Sonnet
// can consume directly. Only surfaces non-empty fields so the prompt stays
// tight.
export function renderThreadStateForPrompt(s: ThreadState): string | undefined {
  const lines: string[] = [];
  if (s.hotelLabels.length) lines.push(`Hotel scope established in this thread: ${s.hotelLabels.join(', ')}`);
  if (s.reservationCodes.length) lines.push(`Reservation codes referenced: ${s.reservationCodes.join(', ')}`);
  if (s.reservationUuids.length) lines.push(`Reservation uuids referenced: ${s.reservationUuids.join(', ')}`);
  if (s.otaConfirmationIds.length) lines.push(`OTA confirmation ids referenced: ${s.otaConfirmationIds.join(', ')}`);
  if (s.metricCuts.length) lines.push(`Metric interpretation: ${s.metricCuts.join(', ')}`);
  if (s.channelFilters.length) lines.push(`Booking-channel filter: ${s.channelFilters.join(', ')}`);
  if (s.dateScope.stayDate) lines.push(`Stay date: ${s.dateScope.stayDate}`);
  if (s.dateScope.startDate && s.dateScope.endDate) lines.push(`Date range: ${s.dateScope.startDate}..${s.dateScope.endDate}`);
  if (s.dateScope.snapshotDate) lines.push(`Snapshot date: ${s.dateScope.snapshotDate}`);
  if (s.dateScope.compareTo) lines.push(`Comparison basis: ${s.dateScope.compareTo}`);
  if (s.lastEffectiveQuestion) lines.push(`Last reconstructed question: ${truncate(s.lastEffectiveQuestion, 300)}`);
  if (s.lastBotReplySnippet) lines.push(`Last bot reply summary: ${truncate(s.lastBotReplySnippet, 400)}`);
  if (lines.length === 0) return undefined;
  return [
    '=== THREAD CONTEXT (established across earlier turns — do NOT re-ask these) ===',
    ...lines,
    '=== END THREAD CONTEXT ===',
  ].join('\n');
}

// Extract identifier/scope signals from a piece of text (the user's raw
// message OR the classifier's effective_question). Deterministic; cheap.
export interface ExtractedSignals {
  hotelLabels: string[];
  reservationCodes: string[];
  reservationUuids: string[];
  otaConfirmationIds: string[];
  chainWide: boolean;
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const DIGITS_RE = /\b\d{9,10}\b/g;
const CHAIN_WIDE_RE = /\b(all\s+hotels?|across\s+the\s+chain|chain[-\s]?wide|every\s+hotel|portfolio[-\s]?wide)\b/i;

export function extractSignalsFromText(text: string, knownHotelLabels: string[]): ExtractedSignals {
  const hotels = new Set<string>();
  const codes = new Set<string>();
  const uuids = new Set<string>();
  const ota = new Set<string>();

  const labelRe = knownHotelLabels.length
    ? new RegExp(`\\b(${knownHotelLabels.map((l) => escapeRegex(l)).join('|')})\\b`, 'gi')
    : null;
  if (labelRe) {
    for (const m of text.matchAll(labelRe)) {
      const label = (m[1] ?? '').toUpperCase();
      if (knownHotelLabels.includes(label)) hotels.add(label);
    }
  }
  for (const m of text.matchAll(UUID_RE)) uuids.add(m[0].toLowerCase());
  for (const m of text.matchAll(DIGITS_RE)) {
    const d = m[0];
    if (d.length === 9) codes.add(d);
    else if (d.length === 10) ota.add(d);
  }
  return {
    hotelLabels: [...hotels],
    reservationCodes: [...codes],
    reservationUuids: [...uuids],
    otaConfirmationIds: [...ota],
    chainWide: CHAIN_WIDE_RE.test(text),
  };
}

// Merge a fresh turn's extracted signals into the running thread state.
// Keeps sets bounded; de-duplicates; preserves the latest values.
export function mergeSignalsIntoState(
  state: ThreadState,
  signals: ExtractedSignals,
): ThreadState {
  return {
    ...state,
    hotelLabels: uniqCapped([...state.hotelLabels, ...signals.hotelLabels], 20),
    reservationCodes: uniqCapped([...state.reservationCodes, ...signals.reservationCodes], 20),
    reservationUuids: uniqCapped([...state.reservationUuids, ...signals.reservationUuids], 20),
    otaConfirmationIds: uniqCapped([...state.otaConfirmationIds, ...signals.otaConfirmationIds], 20),
  };
}

export function recordTurnCompleted(
  state: ThreadState,
  update: {
    toolName?: string | undefined;
    costUsd?: number;
    numTurns?: number;
    deepResearchCalls?: number;
    effectiveQuestion?: string | undefined;
    botReplySnippet?: string | undefined;
  },
): ThreadState {
  const toolsUsedCounts = { ...state.toolsUsedCounts };
  if (update.toolName) {
    toolsUsedCounts[update.toolName] = (toolsUsedCounts[update.toolName] ?? 0) + 1;
  }
  return {
    ...state,
    turnCount: state.turnCount + 1,
    toolsUsedCounts,
    totalCostUsd: state.totalCostUsd + (update.costUsd ?? 0),
    totalNumTurns: state.totalNumTurns + (update.numTurns ?? 0),
    totalDeepResearchCalls: state.totalDeepResearchCalls + (update.deepResearchCalls ?? 0),
    ...(update.effectiveQuestion ? { lastEffectiveQuestion: truncate(update.effectiveQuestion, 800) } : {}),
    ...(update.botReplySnippet ? { lastBotReplySnippet: truncate(update.botReplySnippet, 800) } : {}),
  };
}

function uniqCapped<T>(arr: T[], max: number): T[] {
  const out: T[] = [];
  const seen = new Set<T>();
  for (const v of arr) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
