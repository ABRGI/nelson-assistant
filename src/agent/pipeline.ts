import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { UserBindingStore } from '../auth/binding.js';
import type { ClientRegistry, ClientRecord } from '../auth/clients.js';
import { CognitoExchanger, RefreshTokenInvalid } from '../auth/cognito.js';
import type { NonceStore } from '../auth/nonce.js';
import type { AskJob, JobHandler } from '../queue/inproc.js';
import type { WorktreePool } from '../worktree/pool.js';
import { logger } from '../observability/logger.js';
import type { ChatLog } from '../observability/chatlog.js';
import {
  loadOrCreateThreadState,
  saveThreadState,
  renderThreadStateForPrompt,
  extractSignalsFromText,
  mergeSignalsIntoState,
  recordTurnCompleted,
} from '../state/thread-state.js';
import { matchDecisions, renderDecisionsForPrompt, type Decision } from '../state/decisions.js';
import { matchTopicHints, renderTopicHintsForPrompt } from '../state/topic-hints.js';
import type { TopicReport } from '../analytics/topics.js';
import { ThreadProgressMessage } from '../slack/renderer.js';
import { loadConversationHistory, renderHistoryForAgentPrompt } from '../slack/history.js';
import { downloadSlackAttachments, type LocalAttachment } from '../slack/attachments.js';
import type { HaikuClassifier, ClassifierResult } from './classifier.js';
import type { ConfidenceScorer } from './confidence.js';
import type { LeafPicker } from '../knowledge/picker.js';
import type { KnowledgeBundle } from '../knowledge/loader.js';
import { renderInjection } from '../knowledge/inject.js';
import { runAgent } from './runner.js';

export interface PipelineDeps {
  app: App;
  bindings: UserBindingStore;
  clients: ClientRegistry;
  cognito: CognitoExchanger;
  nonces: NonceStore;
  worktrees: WorktreePool;
  classifier: HaikuClassifier;
  leafPicker: LeafPicker;
  knowledge: KnowledgeBundle;
  confidence: ConfidenceScorer;
  chatlog: ChatLog;
  defaultProject: string;
  defaultBranch: string;
  sonnetModelId: string;
  psqlReadOnlyUrl?: string;
  psqlPool?: import('pg').Pool;
  store: import('../state/types.js').JsonStore;
  knownHotelLabels: string[];
  decisions: Decision[];
  // Holder for the latest topic report. Index.ts mutates .current on SIGHUP.
  topicReportRef: { current: TopicReport | null };
  escalationSlackUserId: string;
  authCallbackBaseUrl: string;
  // Bot token used for direct Slack file downloads (Bolt's WebClient has no
  // raw file-fetch; Slack's url_private_download needs an Authorization header).
  slackBotToken: string;
  resolveTenant: () => ClientRecord;
  runtimeCwd: string;              // safe directory for the agent process's cwd (no source access)
}

export function makeHandler(deps: PipelineDeps): JobHandler {
  return async (job: AskJob) => {
    const slack = deps.app.client;
    const threadTs = job.threadTs ?? (await postRoot(deps.app, job)).ts;
    const logEvent = (kind: Parameters<ChatLog['append']>[0]['kind'], detail: Record<string, unknown>, tenantId?: string): void =>
      deps.chatlog.append({
        kind,
        threadTs,
        channel: job.channel,
        slackUserId: job.userId,
        ...(tenantId ? { tenantId } : {}),
        detail,
      });
    logEvent('message_received', { source: job.source, text: job.text, userMessageTs: job.userMessageTs });

    // Heuristic: if the user's current message looks like negative feedback on
    // the bot's previous reply in this thread, log a user_feedback event.
    // Phase D review sessions filter by these to find what went wrong.
    if (job.source !== 'slash' && detectNegativeSentiment(job.text)) {
      logEvent('user_feedback', {
        source: 'heuristic',
        sentiment: 'negative',
        comment: job.text.slice(0, 300),
      });
      logger.info({ slackUserId: job.userId }, 'user feedback captured via negative-sentiment heuristic');
    }

    const binding = await deps.bindings.get(job.userId);
    if (!binding) {
      await swapReaction(slack, job, 'question');
      await postSignInPrompt(
        deps,
        job.channel,
        threadTs,
        job.userId,
        "You're not signed in to Nelson yet.",
      );
      return;
    }

    const history = await loadConversationHistory(slack, {
      channel: job.channel,
      source: job.source,
      threadTs: job.threadTs,
      // Exclude only the current message (we pass it separately as newMessage).
      // Using threadTs here was wrong for replies in a thread — it stripped the
      // user's original question while keeping the reply.
      excludeTs: job.userMessageTs,
    });

    // Load persisted thread state (survives bot restarts; rehydrates hotel
    // scope, reservations, metric cuts, cost totals from earlier turns). Merge
    // in the signals from this new message upfront so the classifier + picker
    // see the up-to-date context.
    const tenantEarly = deps.resolveTenant();
    let threadState = await loadOrCreateThreadState(deps.store, {
      threadTs,
      channel: job.channel,
      tenantId: tenantEarly.tenantId,
    });
    const inboundSignals = extractSignalsFromText(job.text, deps.knownHotelLabels);
    threadState = mergeSignalsIntoState(threadState, inboundSignals);

    // Kick off the Cognito refresh alongside the classifier so the ~200-500ms
    // exchange overlaps with Haiku. We discard the result on the conversational
    // branch; refresh tokens are reusable so the "extra" call is harmless.
    const tokensSettled = (async () => deps.cognito.exchangeRefresh(
      job.userId,
      binding.nelsonSub,
      await deps.bindings.readRefreshToken(binding),
    ))().then(
      (t) => ({ ok: true as const, tokens: t }),
      (err: unknown) => ({ ok: false as const, err }),
    );

    const renderedThreadContext = renderThreadStateForPrompt(threadState);
    // Surface attachment metadata to the classifier so it doesn't treat
    // "this report" / "this screenshot" as an unresolved referent and
    // ask for clarification — the attached file IS the clarification.
    const classifierInputText = (job.attachments && job.attachments.length > 0)
      ? `${job.text}\n\n[The user attached ${job.attachments.length} file(s): ${job.attachments.map((f) => `${f.name} (${f.mimetype})`).join(', ')}]`
      : job.text;
    const rawVerdict = await deps.classifier.classify(classifierInputText, history, renderedThreadContext);
    // Safety net: if the classifier emits a conversational reply that promises
    // to "run / check / pull / fetch / look up" data — it has no tools, so the
    // promise would be a dead end. Coerce to data_query so Sonnet actually
    // runs. The classifier prompt forbids these phrases but the guard stays
    // here as a hard defense.
    let verdict = coercePromisesToDataQuery(rawVerdict);
    // When the user attached files, a classifier "needs_clarification" or
    // "conversational" verdict almost always means the classifier ignored the
    // attachments. Route to data_query so Sonnet + read_attachment handle it.
    if (job.attachments && job.attachments.length > 0 && verdict.type !== 'data_query') {
      logger.info(
        { original: verdict.type, attachmentCount: job.attachments.length },
        'classifier verdict coerced to data_query — user attached files',
      );
      verdict = { type: 'data_query', effective_question: job.text, reason: 'attachments_present', ...(verdict.usage ? { usage: verdict.usage } : {}) };
    }
    logEvent('classifier_verdict', {
      ...(verdict.type === 'data_query'
        ? { type: 'data_query', ...(verdict.reason ? { reason: verdict.reason } : {}), ...(verdict.effective_question ? { effective_question: verdict.effective_question } : {}) }
        : verdict.type === 'conversational'
          ? { type: 'conversational', reply: verdict.reply }
          : { type: 'needs_clarification', reply: verdict.reply, ...(verdict.reason ? { reason: verdict.reason } : {}) }),
      ...(verdict.usage ? { usage: verdict.usage } : {}),
    });
    if (verdict.type === 'conversational' || verdict.type === 'needs_clarification') {
      await tokensSettled;
      await slack.chat.postMessage({
        channel: job.channel,
        thread_ts: threadTs,
        text: verdict.reply,
        mrkdwn: true,
      });
      const reaction = verdict.type === 'needs_clarification' || looksLikeQuestion(verdict.reply)
        ? 'question'
        : 'white_check_mark';
      await swapReaction(slack, job, reaction);
      logEvent('agent_reply', { path: verdict.type, reply: verdict.reply });
      logger.info(
        { slackUserId: job.userId, reason: verdict.type },
        'job completed (no agent run)',
      );
      threadState = recordTurnCompleted(threadState, {
        botReplySnippet: verdict.reply,
      });
      await saveThreadState(deps.store, threadState);
      return;
    }

    // Create the progress message immediately on the data-query branch so the
    // user sees motion during token refresh + worktree checkout (worktree is
    // cold + slow on the first query after an ECS task restart — easily 60s).
    const progress = await ThreadProgressMessage.create(
      slack,
      job.channel,
      threadTs,
      ':thinking_face: On it…',
    );

    let tenant: ClientRecord;
    try {
      tenant = deps.resolveTenant();
    } catch (err) {
      await swapReaction(slack, job, 'x');
      await progress.finalize(`:x: ${(err as Error).message}`);
      return;
    }

    progress.update(':key: Checking your Nelson session…');
    const tokenResult = await tokensSettled;
    if (!tokenResult.ok) {
      const err = tokenResult.err;
      if (err instanceof RefreshTokenInvalid) {
        logger.info({ slackUserId: job.userId }, 'refresh token rejected, prompting re-auth');
        await swapReaction(slack, job, 'question');
        await progress.finalize('Your Nelson session expired.');
        await postSignInPrompt(
          deps,
          job.channel,
          threadTs,
          job.userId,
          'Your Nelson session expired. Sign in again to continue.',
        );
        return;
      }
      logger.warn({ err, slackUserId: job.userId }, 'token exchange failed');
      await swapReaction(slack, job, 'x');
      await progress.finalize(`I couldn't refresh your Nelson session: ${(err as Error).message}`);
      return;
    }
    const tokens = tokenResult.tokens;

    // The effective question is either the user's literal text OR, when the
    // classifier recognised a short answer to its own prior clarification, the
    // reconstructed full question. Using the reconstructed form keeps the leaf
    // picker on-topic and stops Sonnet from re-asking the same question.
    const effectiveText = verdict.type === 'data_query' && verdict.effective_question
      ? verdict.effective_question
      : job.text;
    if (effectiveText !== job.text) {
      logger.info(
        { original: job.text, reconstructed: effectiveText },
        'classifier reconstructed user question from clarification answer',
      );
    }
    let attachments: LocalAttachment[] = [];
    if (job.attachments && job.attachments.length > 0) {
      progress.update(':paperclip: Downloading your attachment…');
      attachments = await downloadSlackAttachments({
        files: job.attachments,
        botToken: deps.slackBotToken,
      });
    }
    const attachmentsPreamble = renderAttachmentsPreamble(attachments);
    const questionBody = renderHistoryForAgentPrompt(history, effectiveText);
    const question = attachmentsPreamble ? `${attachmentsPreamble}\n\n${questionBody}` : questionBody;

    // Hot path: pick 1-3 knowledge leaves, pre-inject them into the system
    // prompt. No worktree allocation, no source-code read on the happy path.
    // deep_research is the only path back into source and it allocates its own
    // worktree on demand inside the tool handler.
    progress.update(':books: Loading the right playbook…');
    const picked = await deps.leafPicker.pick(effectiveText);
    const leafInjection = renderInjection(deps.knowledge, picked.leaves);
    const matchQuestion = effectiveText === job.text ? job.text : `${effectiveText}\n${job.text}`;
    const matchedDecisions = matchDecisions(matchQuestion, deps.decisions, { tenantId: tenant.tenantId });
    const renderedDecisions = renderDecisionsForPrompt(matchedDecisions);
    if (matchedDecisions.length > 0) {
      logEvent('tool_use', {
        name: 'decision_matcher',
        output: { matched: matchedDecisions.map((d) => ({ slug: d.slug, version: d.version })) },
      }, tenant.tenantId);
    }
    const matchedTopicHints = matchTopicHints(matchQuestion, deps.topicReportRef.current);
    const renderedTopicHints = renderTopicHintsForPrompt(matchedTopicHints);
    if (matchedTopicHints.length > 0) {
      logEvent('tool_use', {
        name: 'topic_hint_matcher',
        output: { matched: matchedTopicHints.map((m) => ({ clusterId: m.cluster.id, frequency: m.cluster.frequency })) },
      }, tenant.tenantId);
    }
    // Ordering: most-authoritative first (decisions > thread state > topic hints > leaves).
    const knowledgeInjection = [renderedDecisions, renderedThreadContext, renderedTopicHints, leafInjection]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join('\n\n');
    logEvent('tool_use', {
      name: 'leaf_picker',
      input: { question: effectiveText, ...(effectiveText !== job.text ? { originalUserText: job.text } : {}) },
      output: { leaves: picked.leaves, reason: picked.reason },
      ...(picked.usage ? { usage: picked.usage } : {}),
    }, tenant.tenantId);
    progress.update(':brain: Thinking through your question…');
    try {
      let lastToolName: string | undefined;
      let escalated = false;
      const toolsUsed: string[] = [];
      const result = await runAgent({
        cwd: deps.runtimeCwd,
        project: deps.defaultProject,
        tenant,
        tokens,
        askerSlackUserId: job.userId,
        question,
        channel: job.channel,
        threadTs,
        slack,
        escalationSlackUserId: deps.escalationSlackUserId,
        sonnetModelId: deps.sonnetModelId,
        worktrees: deps.worktrees,
        defaultBranch: deps.defaultBranch,
        ...(knowledgeInjection ? { knowledgeInjection } : {}),
        ...(deps.psqlReadOnlyUrl ? { psqlReadOnlyUrl: deps.psqlReadOnlyUrl } : {}),
        ...(deps.psqlPool ? { psqlPool: deps.psqlPool } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        onEvent: (event) => {
          if (event.type === 'assistant') {
            for (const block of event.message.content) {
              if (block.type === 'tool_use') {
                lastToolName = block.name;
                toolsUsed.push(describeToolForConfidence(block.name, block.input));
                progress.update(describeToolActivity(block.name, block.input));
                logEvent('tool_use', { name: block.name, input: block.input }, tenant.tenantId);
                if (block.name === 'mcp__nelson__escalate_to_human') {
                  escalated = true;
                  logEvent('escalation', { reason: 'agent_invoked_tool', input: block.input }, tenant.tenantId);
                }
              }
            }
          }
        },
      });
      const finalText = result.finalText?.trim() || 'Done.';
      // Skip confidence scoring entirely when the reply is a clarification
      // question with no factual claims — the scorer penalises the absence of
      // citations even though there's nothing to cite (learning-session thread
      // 1776793631.337929 sub-reply 'tell me about prices', scored 2/10).
      const isClarificationOnly = looksLikeClarificationOnly(finalText);
      const confidencePromise = isClarificationOnly
        ? Promise.resolve(null)
        : deps.confidence.score({ question: job.text, reply: finalText, toolsUsed });
      const needsInput = escalated || looksLikeQuestion(finalText);
      await swapReaction(slack, job, needsInput ? 'question' : 'white_check_mark');
      const confidence = await confidencePromise;
      const displayText = confidence && confidence.score < 7
        ? `${finalText}\n\n_Confidence ${confidence.score}/10${confidence.hedges.length ? ': ' + confidence.hedges.join(', ') : ''}. Double-check this one._`
        : finalText;
      await progress.finalize(displayText);
      logEvent('agent_reply', {
        path: 'data_query',
        reply: finalText,
        lastToolName,
        toolsUsed,
        stopReason: result.stopReason,
        sessionId: result.sessionId,
        needsInput,
        ...(result.cost ? { cost: result.cost } : {}),
        ...(confidence ? { confidence } : { confidence: null, confidenceSkippedReason: 'clarification_request_no_citations_needed' }),
      }, tenant.tenantId);
      logger.info(
        {
          tenantId: tenant.tenantId,
          project: deps.defaultProject,
          lastToolName,
          stopReason: result.stopReason,
          ...(result.cost ? {
            totalCostUsd: result.cost.totalCostUsd,
            numTurns: result.cost.numTurns,
            deepResearchCalls: result.cost.deepResearchCalls,
          } : {}),
        },
        'job completed',
      );
      await deps.bindings.markUsed(job.userId).catch(() => undefined);
      // Record what was established this turn so the next turn rehydrates it.
      const replySignals = extractSignalsFromText(finalText, deps.knownHotelLabels);
      threadState = mergeSignalsIntoState(threadState, replySignals);
      threadState = recordTurnCompleted(threadState, {
        toolName: lastToolName,
        costUsd: result.cost?.totalCostUsd ?? 0,
        numTurns: result.cost?.numTurns ?? 0,
        deepResearchCalls: result.cost?.deepResearchCalls ?? 0,
        ...(verdict.effective_question ? { effectiveQuestion: verdict.effective_question } : {}),
        botReplySnippet: finalText,
      });
      await saveThreadState(deps.store, threadState);
    } catch (err) {
      logger.error({ err }, 'agent run failed');
      await swapReaction(slack, job, 'x');
      logEvent('error', { stage: 'agent_run', message: (err as Error).message }, tenant.tenantId);
      await progress.finalize(
        `:x: Something went wrong and I couldn't complete your request.\n\`\`\`${(err as Error).message}\`\`\`\nPlease contact <@${deps.escalationSlackUserId}> for help.`,
      );
      await saveThreadState(deps.store, recordTurnCompleted(threadState, {})).catch(() => undefined);
    }
  };
}

const TOOL_LABELS: Record<string, string> = {
  mcp__nelson__escalate_to_human: ':raising_hand: Looping in a human teammate…',
  mcp__nelson__git_log: ':mag: Checking recent code changes…',
  mcp__nelson__psql: ':floppy_disk: Querying the Nelson database…',
  mcp__nelson__deep_research: ':microscope: Opening the Nelson source — this takes a moment…',
  Read: ':books: Checking the Nelson documentation…',
  Grep: ':books: Checking the Nelson documentation…',
  Glob: ':books: Checking the Nelson documentation…',
  Task: ':brain: Working through the next step…',
  Bash: ':hammer_and_wrench: Running a check…',
};

const NELSON_API_PATH_LABELS: Array<[RegExp, string]> = [
  [/\/availability/, 'Checking availability'],
  [/\/prices/, 'Looking up pricing'],
  [/\/reservations\/arrivals/, "Checking today's arrivals"],
  [/\/reservations/, 'Looking up reservations'],
  [/\/hotels/, 'Looking up hotels'],
  [/\/rooms/, 'Looking up rooms'],
  [/\/(guests|customers)/, 'Looking up guests'],
  [/\/reports/, 'Fetching a report'],
  [/\/config/, 'Reading configuration'],
];

function describeToolForConfidence(toolName: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (toolName === 'mcp__nelson__nelson_api') {
    return `nelson_api ${String(i['method'] ?? 'GET')} ${String(i['path'] ?? '')}`;
  }
  if (toolName === 'Read' && typeof i['file_path'] === 'string') {
    return `Read ${i['file_path']}`;
  }
  if (toolName === 'Grep' && typeof i['pattern'] === 'string') {
    return `Grep ${i['pattern']}`;
  }
  if (toolName === 'Bash' && typeof i['command'] === 'string') {
    return `Bash ${String(i['command']).slice(0, 100)}`;
  }
  return toolName;
}

function describeToolActivity(toolName: string, input: unknown): string {
  if (toolName === 'mcp__nelson__nelson_api') {
    const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const method = typeof i['method'] === 'string' ? i['method'] : 'GET';
    const path = typeof i['path'] === 'string' ? i['path'] : '';
    const matched = NELSON_API_PATH_LABELS.find(([re]) => re.test(path.toLowerCase()));
    const label = matched ? matched[1] : 'Calling the Nelson API';
    return `:satellite_antenna: ${label} (${method} ${path})`;
  }
  return TOOL_LABELS[toolName] ?? ':hourglass_flowing_sand: Working on it…';
}

// Keep this list conservative — false positives spam the feedback queue. Only
// match phrases where the user is clearly flagging a recent bot reply as wrong.
const NEGATIVE_FEEDBACK_PATTERNS: RegExp[] = [
  /\b(that'?s |this is |you'?re )?(wrong|incorrect|not (right|correct))\b/i,
  /\b(doesn'?t look right|that'?s not it|nope that'?s)\b/i,
  /\b(you (made|got) (that|it) up|you hallucinated|fabricated)\b/i,
  /\bwhere did you get (that|this)\b.*\?/i,
  /\b(that can'?t be right|doesn'?t match)\b/i,
];

function detectNegativeSentiment(text: string): boolean {
  if (!text || text.length < 3) return false;
  return NEGATIVE_FEEDBACK_PATTERNS.some((re) => re.test(text));
}

// A clarification-only reply has no factual claims to cite. The confidence
// scorer would otherwise penalise its empty Source footer and surface a
// misleading 2/10 warning to the user.
const CLARIFICATION_PHRASES = [
  /\bcould you (clarify|specify|tell me|share)\b/i,
  /\bcan you (clarify|be more specific|tell me|share)\b/i,
  /\bwhat (exactly )?(would you like|are you (asking|looking for)|did you mean)\b/i,
  /\b(which|what)\s+(hotel|reservation|date|room|tenant|period|range)\b.*\?/i,
  /\bplease (specify|clarify|share|provide|tell)\b/i,
  /\bthe more specific you are\b/i,
];

function looksLikeClarificationOnly(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.includes('?')) return false;
  // Has to be predominantly a question, not a buried clarifier after a factual answer.
  // Heuristic: first 250 chars contain a clarification phrase.
  const head = trimmed.slice(0, 250);
  return CLARIFICATION_PHRASES.some((re) => re.test(head));
}

function looksLikeQuestion(text: string): boolean {
  const trimmed = text.trim().replace(/[`*_~]+$/, '').trimEnd();
  return trimmed.endsWith('?');
}

// Phrases the classifier sometimes emits in a "conversational" reply that
// imply it is about to run a query — which it can't. When we see one, coerce
// to data_query so Sonnet actually runs and the user isn't left waiting on a
// promise the bot can never fulfil.
const PROMISE_PATTERNS = [
  // Future-tense "I will do this"
  /let me (run|check|query|pull|fetch|look|verify|re[\s-]?run|try|escalate|flag|notify|ping|tag)/i,
  /i['']?ll (run|check|query|pull|fetch|look|verify|re[\s-]?run|try|escalate|flag|notify|ping|tag)/i,
  /one\s+(sec|moment|minute)[,.\s]/i,
  /hold on[,.\s]/i,
  /on it[,.\s]/i,
  /thanks for catching that[ \-—,]*let me/i,
  /i['']?m (going to|about to|gonna) (run|check|query|pull|fetch|escalate|flag|notify|ping|tag)/i,
  /let me (re)?(-)?run the corrected query/i,
  // Past-tense "I've done this" — same category of lie, worse because it
  // implies the action already took place. Classifier has no tools, so none
  // of these can ever be true. If claiming an action happened, it's data_query.
  /i['']?ve (flagged|escalated|notified|pinged|tagged|sent|emailed|messaged|forwarded|ran|run|checked|queried|pulled|fetched|looked|verified|logged|recorded|filed|raised)/i,
  /i (flagged|escalated|notified|pinged|tagged|sent|emailed|messaged|forwarded|ran|checked|queried|pulled|fetched|looked|verified|logged|recorded|filed|raised) (this|it|the|them|him|her|that)/i,
  /(has|have) been (flagged|escalated|notified|sent|forwarded|pinged|logged|recorded|filed)/i,
  /(the )?(ops|support|dev|team|escalation user) (has been|have been|will follow|will review|is (flagged|notified))/i,
];

function containsUnkeepablePromise(text: string): boolean {
  if (!text) return false;
  return PROMISE_PATTERNS.some((re) => re.test(text));
}

function coercePromisesToDataQuery(verdict: ClassifierResult): ClassifierResult {
  if (verdict.type !== 'conversational') return verdict;
  if (!containsUnkeepablePromise(verdict.reply)) return verdict;
  logger.warn(
    { reply: verdict.reply.slice(0, 200) },
    'classifier conversational reply promised work it cannot do — coercing to data_query',
  );
  const coerced: ClassifierResult = {
    type: 'data_query',
    reason: 'coerced_from_promise_conversational',
    effective_question: verdict.reply,
    ...(verdict.usage ? { usage: verdict.usage } : {}),
  };
  return coerced;
}

async function swapReaction(slack: WebClient, job: AskJob, next: string): Promise<void> {
  try {
    await slack.reactions.remove({ channel: job.channel, timestamp: job.userMessageTs, name: 'hourglass_flowing_sand' });
  } catch { /* already removed or never added */ }
  try {
    await slack.reactions.add({ channel: job.channel, timestamp: job.userMessageTs, name: next });
  } catch (err) {
    logger.debug({ err }, 'failed to add outcome reaction');
  }
}

async function postRoot(app: App, job: AskJob): Promise<{ ts: string }> {
  const res = await app.client.chat.postMessage({
    channel: job.channel,
    text: `<@${job.userId}> asked: ${job.text}`,
  });
  if (!res.ts) throw new Error('Slack did not return a ts for root message');
  return { ts: res.ts };
}

async function postSignInPrompt(
  deps: Pick<PipelineDeps, 'app' | 'nonces' | 'authCallbackBaseUrl'>,
  channel: string,
  threadTs: string,
  slackUserId: string,
  lead: string,
): Promise<void> {
  try {
    const pending = await deps.nonces.create({ slackUserId });
    const url = `${deps.authCallbackBaseUrl.replace(/\/$/, '')}/auth/login/${encodeURIComponent(pending.nonce)}`;
    const ttlMins = Math.round((pending.expiresAt - pending.createdAt) / 60_000);
    const text = `${lead} Click to sign in (valid ${ttlMins} min, single use): ${url}`;
    await deps.app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `${lead} Link valid for ${ttlMins} min, single use.` } },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Sign in to Nelson' },
              style: 'primary',
              url,
              action_id: 'nelson_auth_link',
            },
          ],
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: 'Enter your Nelson password *on that page only*, never here. Ask again after you see the "Linked" DM.',
            },
          ],
        },
      ],
    });
  } catch (err) {
    logger.error({ err, slackUserId }, 'failed to post sign-in prompt');
    await deps.app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: 'You need to sign in, but I could not create a link. Try again in a minute.',
    });
  }
}

function renderAttachmentsPreamble(attachments: LocalAttachment[]): string | undefined {
  if (attachments.length === 0) return undefined;
  const lines = attachments.map((a) => `- file_id=\`${a.fileId}\` name=${a.name} mimetype=${a.mimetype} size=${a.sizeBytes}`);
  return [
    '=== USER-ATTACHED FILES ===',
    `The user uploaded ${attachments.length} file(s) alongside this message:`,
    ...lines,
    'Call `mcp__nelson__read_attachment` with the relevant `file_id` to inspect contents. Images return as image blocks; text files inline up to ~40 KB; other mimetypes return metadata only (ask the user to paste contents if needed).',
    '=== END USER-ATTACHED FILES ===',
  ].join('\n');
}
