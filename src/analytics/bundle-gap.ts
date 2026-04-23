import type { JsonStore } from '../state/types.js';
import type { ChatLogEvent, ChatLogEventKind } from '../observability/chatlog.js';
import { logger } from '../observability/logger.js';

// Phase E Part 2: aggregate chatlog events into a bundle-gap report that
// `/train` consumes. No Bedrock calls, no heavy compute — just deterministic
// rollups over the event log we already persist.
//
// Output shape is the contract for /train consumers: flagged threads (worth a
// learning-session review), cost rollups, deep_research triggers grouped by
// effective_question, and the most-frequent tool patterns.

export interface ThreadAggregate {
  threadTs: string;
  channel: string;
  tenantId: string | undefined;
  firstSeen: string;
  lastSeen: string;
  turnCount: number;
  userMessages: string[];                 // trimmed to 200 chars each
  effectiveQuestions: string[];
  lastBotReply: string | undefined;
  totalCostUsd: number;
  totalNumTurns: number;
  totalDeepResearchCalls: number;
  deepResearchEvents: number;              // count of deep_research_complete events
  toolsUsed: Record<string, number>;
  lastToolName: string | undefined;
  confidenceScores: number[];              // one per agent_reply with confidence
  escalated: boolean;
  userFeedbackNegative: number;            // count of user_feedback events with sentiment=negative
  userFeedbackPositive: number;
  errors: number;
  classifierParseErrors: number;
  flagReasons: string[];                   // why this thread should land in the report
}

export interface BundleGapReport {
  generatedAt: string;
  window: { fromIso: string; toIso: string };
  totalEvents: number;
  totalThreads: number;
  flaggedThreads: ThreadAggregate[];
  costSummary: {
    totalUsd: number;
    avgUsdPerThread: number;
    p95UsdPerThread: number;
    topByCost: Array<{ threadTs: string; usd: number; numTurns: number; toolsUsed: Record<string, number> }>;
  };
  deepResearchSummary: {
    totalTriggers: number;
    threadsWithDeepResearch: number;
    byEffectiveQuestion: Array<{ effective_question: string; threadTs: string; deepResearchCalls: number }>;
  };
  feedbackSummary: {
    negative: number;
    positive: number;
    threadsWithNegative: string[];
  };
  topToolPatterns: Array<{ toolSequence: string; count: number }>;
}

export interface ThresholdOptions {
  highCostUsd: number;                     // flag threads above this cost
  lowConfidence: number;                   // flag threads with any confidence < this
}

const DEFAULT_THRESHOLDS: ThresholdOptions = {
  highCostUsd: 0.50,
  lowConfidence: 7,
};

export async function buildBundleGapReport(
  store: JsonStore,
  opts: { fromIso: string; toIso: string; thresholds?: Partial<ThresholdOptions> } = { fromIso: '', toIso: '' },
): Promise<BundleGapReport> {
  const thresholds: ThresholdOptions = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds ?? {}) };
  const from = opts.fromIso ? new Date(opts.fromIso) : new Date(Date.now() - 24 * 60 * 60_000);
  const to = opts.toIso ? new Date(opts.toIso) : new Date();

  // Enumerate chatlog keys. Prefix scan is cheap — both fs and S3 implement it.
  const allKeys = await store.listKeys('chatlog/');
  const byThread = new Map<string, ChatLogEvent[]>();

  for (const key of allKeys) {
    // Parse date out of chatlog/<yyyy-mm-dd>/<threadTs>/<eventTs>-<eventId>.json
    const m = key.match(/^chatlog\/(\d{4}-\d{2}-\d{2})\//);
    if (!m) continue;
    const dateStr = m[1]!;
    const dateOnly = new Date(`${dateStr}T00:00:00Z`);
    // Fast-skip whole days outside the window.
    if (dateOnly.getTime() + 24 * 60 * 60_000 < from.getTime()) continue;
    if (dateOnly.getTime() > to.getTime()) continue;

    const rec = await store.getJson<ChatLogEvent>(key).catch((err) => {
      logger.warn({ err, key }, 'chatlog event read failed, skipping');
      return null;
    });
    if (!rec) continue;
    const ev = rec.value;
    if (!ev.eventTs) continue;
    const ts = new Date(ev.eventTs);
    if (ts < from || ts > to) continue;
    const arr = byThread.get(ev.threadTs) ?? [];
    arr.push(ev);
    byThread.set(ev.threadTs, arr);
  }

  const aggregates: ThreadAggregate[] = [];
  for (const [threadTs, events] of byThread) {
    events.sort((a, b) => a.eventTs.localeCompare(b.eventTs));
    aggregates.push(aggregateThread(threadTs, events, thresholds));
  }

  const report = assemble(aggregates, {
    from: from.toISOString(),
    to: to.toISOString(),
    totalEvents: Array.from(byThread.values()).reduce((n, arr) => n + arr.length, 0),
  });
  return report;
}

function aggregateThread(
  threadTs: string,
  events: ChatLogEvent[],
  thresholds: ThresholdOptions,
): ThreadAggregate {
  const agg: ThreadAggregate = {
    threadTs,
    channel: events[0]?.channel ?? '',
    tenantId: events.find((e) => e.tenantId)?.tenantId,
    firstSeen: events[0]?.eventTs ?? '',
    lastSeen: events[events.length - 1]?.eventTs ?? '',
    turnCount: 0,
    userMessages: [],
    effectiveQuestions: [],
    lastBotReply: undefined,
    totalCostUsd: 0,
    totalNumTurns: 0,
    totalDeepResearchCalls: 0,
    deepResearchEvents: 0,
    toolsUsed: {},
    lastToolName: undefined,
    confidenceScores: [],
    escalated: false,
    userFeedbackNegative: 0,
    userFeedbackPositive: 0,
    errors: 0,
    classifierParseErrors: 0,
    flagReasons: [],
  };

  for (const ev of events) {
    const d = ev.detail ?? {};
    switch (ev.kind as ChatLogEventKind) {
      case 'message_received': {
        agg.turnCount += 1;
        const text = typeof d.text === 'string' ? d.text.slice(0, 200) : '';
        if (text) agg.userMessages.push(text);
        break;
      }
      case 'classifier_verdict': {
        if (typeof d.effective_question === 'string') {
          agg.effectiveQuestions.push(d.effective_question.slice(0, 300));
        }
        if (d.reason === 'classifier_parse_error') agg.classifierParseErrors += 1;
        break;
      }
      case 'tool_use': {
        const name = typeof d.name === 'string' ? d.name : 'unknown';
        agg.toolsUsed[name] = (agg.toolsUsed[name] ?? 0) + 1;
        if (name === 'mcp__nelson__deep_research') agg.deepResearchEvents += 1;
        break;
      }
      case 'agent_reply': {
        if (typeof d.lastToolName === 'string') agg.lastToolName = d.lastToolName;
        if (typeof d.reply === 'string') agg.lastBotReply = d.reply.slice(0, 800);
        const cost = d.cost as { totalCostUsd?: number; numTurns?: number; deepResearchCalls?: number } | undefined;
        if (cost) {
          if (typeof cost.totalCostUsd === 'number') agg.totalCostUsd += cost.totalCostUsd;
          if (typeof cost.numTurns === 'number') agg.totalNumTurns += cost.numTurns;
          if (typeof cost.deepResearchCalls === 'number') agg.totalDeepResearchCalls += cost.deepResearchCalls;
        }
        const confidence = d.confidence as { score?: number } | null | undefined;
        if (confidence && typeof confidence.score === 'number') agg.confidenceScores.push(confidence.score);
        break;
      }
      case 'escalation':
        agg.escalated = true;
        break;
      case 'user_feedback': {
        if (d.sentiment === 'negative') agg.userFeedbackNegative += 1;
        if (d.sentiment === 'positive') agg.userFeedbackPositive += 1;
        break;
      }
      case 'error':
        agg.errors += 1;
        break;
    }
  }

  // Flag reasons — a thread lands in flaggedThreads if any of these are true.
  const minConfidence = agg.confidenceScores.length ? Math.min(...agg.confidenceScores) : undefined;
  if (agg.totalCostUsd >= thresholds.highCostUsd) agg.flagReasons.push(`high_cost_${agg.totalCostUsd.toFixed(2)}`);
  if (agg.totalDeepResearchCalls > 0 || agg.deepResearchEvents > 0) agg.flagReasons.push('deep_research_triggered');
  if (minConfidence !== undefined && minConfidence < thresholds.lowConfidence) agg.flagReasons.push(`low_confidence_${minConfidence}`);
  if (agg.userFeedbackNegative > 0) agg.flagReasons.push('user_negative');
  if (agg.errors > 0) agg.flagReasons.push('error');
  if (agg.classifierParseErrors > 0) agg.flagReasons.push('classifier_parse_error');

  return agg;
}

function assemble(
  aggregates: ThreadAggregate[],
  meta: { from: string; to: string; totalEvents: number },
): BundleGapReport {
  const flagged = aggregates.filter((a) => a.flagReasons.length > 0);
  const costs = aggregates.map((a) => a.totalCostUsd).filter((c) => c > 0);
  costs.sort((a, b) => a - b);
  const p95 = costs.length ? costs[Math.floor(costs.length * 0.95)] ?? 0 : 0;
  const totalCostUsd = costs.reduce((s, c) => s + c, 0);

  const topByCost = [...aggregates]
    .filter((a) => a.totalCostUsd > 0)
    .sort((a, b) => b.totalCostUsd - a.totalCostUsd)
    .slice(0, 10)
    .map((a) => ({ threadTs: a.threadTs, usd: +a.totalCostUsd.toFixed(4), numTurns: a.totalNumTurns, toolsUsed: a.toolsUsed }));

  const deepResearchThreads = aggregates.filter((a) => a.totalDeepResearchCalls > 0 || a.deepResearchEvents > 0);
  const byEffectiveQuestion = deepResearchThreads
    .map((a) => ({
      effective_question: a.effectiveQuestions[a.effectiveQuestions.length - 1] ?? a.userMessages[a.userMessages.length - 1] ?? '(unknown)',
      threadTs: a.threadTs,
      deepResearchCalls: a.totalDeepResearchCalls || a.deepResearchEvents,
    }))
    .sort((a, b) => b.deepResearchCalls - a.deepResearchCalls)
    .slice(0, 20);

  const negativeFeedbackThreads = aggregates
    .filter((a) => a.userFeedbackNegative > 0)
    .map((a) => a.threadTs);

  const toolSequenceCounts = new Map<string, number>();
  for (const a of aggregates) {
    const keys = Object.keys(a.toolsUsed).sort().join(',');
    if (!keys) continue;
    toolSequenceCounts.set(keys, (toolSequenceCounts.get(keys) ?? 0) + 1);
  }
  const topToolPatterns = [...toolSequenceCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([toolSequence, count]) => ({ toolSequence, count }));

  return {
    generatedAt: new Date().toISOString(),
    window: { fromIso: meta.from, toIso: meta.to },
    totalEvents: meta.totalEvents,
    totalThreads: aggregates.length,
    flaggedThreads: flagged,
    costSummary: {
      totalUsd: +totalCostUsd.toFixed(4),
      avgUsdPerThread: aggregates.length ? +(totalCostUsd / aggregates.length).toFixed(4) : 0,
      p95UsdPerThread: +(p95).toFixed(4),
      topByCost,
    },
    deepResearchSummary: {
      totalTriggers: aggregates.reduce((n, a) => n + (a.totalDeepResearchCalls || a.deepResearchEvents), 0),
      threadsWithDeepResearch: deepResearchThreads.length,
      byEffectiveQuestion,
    },
    feedbackSummary: {
      negative: aggregates.reduce((n, a) => n + a.userFeedbackNegative, 0),
      positive: aggregates.reduce((n, a) => n + a.userFeedbackPositive, 0),
      threadsWithNegative: negativeFeedbackThreads,
    },
    topToolPatterns,
  };
}

// Persist the report so `/train` can pick it up via listKeys('analytics/bundle-gaps/').
export async function saveBundleGapReport(store: JsonStore, report: BundleGapReport): Promise<string> {
  const date = report.generatedAt.slice(0, 10);
  const key = `analytics/bundle-gaps/${date}.json`;
  await store.putJson(key, report);
  return key;
}
