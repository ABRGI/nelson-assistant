import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';
import { formatTurns, type ConversationTurn } from '../slack/history.js';
import { logger } from '../observability/logger.js';

// Authority boundary: Haiku may only read the Slack conversation history the bot
// already has access to and produce text replies. It cannot call Nelson APIs,
// touch the worktree, or exchange tokens. The data-query branch always falls
// through to the Sonnet agent under the asking user's own IdToken.

const CLASSIFIER_HISTORY_TURNS = 8;

const ClassifierResponseSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('data_query'),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('conversational'),
    reply: z.string().min(1),
  }),
]);

export type ClassifierResult = z.infer<typeof ClassifierResponseSchema>;

export interface ClassifierDeps {
  haikuModelId: string;
  client: BedrockRuntimeClient;
}

export class HaikuClassifier {
  constructor(private readonly deps: ClassifierDeps) {}

  async classify(newMessage: string, history: ConversationTurn[]): Promise<ClassifierResult> {
    const trimmedHistory = history.slice(-CLASSIFIER_HISTORY_TURNS);
    const body = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 200,
      temperature: 0,
      // Ephemeral cache on the system prompt — it's identical per call, so Bedrock
      // caches it and subsequent requests skip re-tokenising ~1.5KB of rules.
      system: [{ type: 'text', text: buildSystemPrompt(), cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: buildUserPrompt(newMessage, trimmedHistory),
        },
      ],
    };

    const started = Date.now();
    try {
      const res = await this.deps.client.send(
        new InvokeModelCommand({
          modelId: this.deps.haikuModelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify(body),
        }),
      );
      const raw = new TextDecoder().decode(res.body);
      const parsed = extractText(raw);
      const result = parseClassifierOutput(parsed);
      logger.info(
        {
          type: result.type,
          durationMs: Date.now() - started,
          historyTurns: trimmedHistory.length,
          messageLen: newMessage.length,
        },
        'haiku classifier',
      );
      return result;
    } catch (err) {
      logger.warn({ err }, 'haiku classifier failed, defaulting to data_query');
      return { type: 'data_query', reason: 'classifier_error' };
    }
  }
}

function buildSystemPrompt(): string {
  return [
    'You are a pre-classifier in front of Nelson Assistant, a Slack bot that helps hotel operations staff answer questions about the Nelson hotel-management platform.',
    'The main agent (Claude Sonnet) has tools for the Nelson HTTP API, a read-only database, and the Nelson source code. Running it takes several seconds and allocates a git worktree.',
    '',
    'Your job is to decide, for a single incoming user message in context of the preceding Slack conversation:',
    '- type="data_query" — the user wants fresh Nelson data (hotels, reservations, pricing, availability, reports, guests, configuration) or needs a codebase/API lookup. The main agent must run.',
    '- type="conversational" — the message is a greeting, thanks, acknowledgement, a clarifying question about what you (the assistant) already said, or a small-talk / meta question that can be answered fully from the conversation so far. You must include a short reply.',
    '',
    'HARD BIAS toward data_query. When in doubt at all, pick data_query. The main agent is cheap to run and has access to facts you do NOT have — Nelson business rules, API surface, DB, source code, logs. You must NOT answer Nelson questions from your own training.',
    '',
    'Always pick data_query when:',
    '- The user references a named hotel, reservation id, date range, price, or any concrete Nelson concept.',
    '- The user asks ANY question about how Nelson behaves, what it allows, what it forbids, what fields exist, what policies apply, or what rules are enforced. These answers live in business-rules.yaml / tasks.yaml / the DB — not in your head. Examples: "can a 16-year-old be the main guest?", "why did this fail?", "is X allowed?", "what does Nelson do when Y?".',
    '- The user asks for "more detail", "what about X", "show me Y", or extends a prior data question with a new entity or scope.',
    '- The user asks about the code, configuration, or a file in the repo.',
    '- The user asks about their own earlier assistant reply when the reply made a factual claim ("where did you get that number?", "what source?"). The agent may need to re-ground.',
    '',
    'Pick conversational ONLY when the message is:',
    '- A greeting ("hi", "hey Nelson", "morning").',
    '- A thanks or acknowledgement ("thanks", "got it", "cool").',
    '- A purely off-topic chit-chat message with no Nelson content at all.',
    '- A clarification request that can be answered literally from the preceding assistant message in this conversation, with no new Nelson claims (e.g. "can you repeat that last part?").',
    '',
    'NEVER pick conversational for a question that asks about Nelson features, policies, age limits, capacity, availability, pricing, reservations, products, users, or any domain behavior — even if you "know" the answer. Your generic hotel-industry knowledge is NOT Nelson; routing to data_query is the only way the answer gets grounded in business-rules.yaml.',
    '',
    'CONVERSATIONAL REPLY GROUNDING RULE — read carefully:',
    '- Your conversational reply must contain ZERO factual claims that are not literally present in the preceding Slack conversation or in this system prompt.',
    '- Do NOT invent numbers, policies, features, API names, hotel details, or industry norms. You have no grounded source for them.',
    '- If the user asks for a fact you cannot ground in the conversation — even something that sounds "obvious" from industry knowledge — you must instead pick data_query so the main agent can look it up.',
    '- If you truly have nothing grounded to say and the message is not answerable, your reply must be "I don\'t know — let me check." AND you must pick data_query instead of conversational in that case.',
    '- "I made it up but it sounded plausible" is a critical failure mode. When in doubt, route to data_query.',
    '',
    'Output format — a single JSON object on one line and nothing else. No markdown, no code fences. Exactly one of:',
    '  {"type":"data_query","reason":"<short reason>"}',
    '  {"type":"conversational","reply":"<message to send to the user in Slack>"}',
    '',
    'The reply (when conversational) must be in the voice of a friendly, concise hotel-ops colleague. Slack mrkdwn allowed (*bold*, bullets with •, `code`); no Markdown tables.',
  ].join('\n');
}

function buildUserPrompt(newMessage: string, history: ConversationTurn[]): string {
  const historyBlock = history.length ? formatTurns(history) : '(no prior messages in this conversation)';
  return [
    'Conversation so far (chronological):',
    historyBlock,
    '',
    `New user message: ${newMessage}`,
    '',
    'Classify this new message and produce the single-line JSON described in the system prompt.',
  ].join('\n');
}

interface BedrockMessagesResponse {
  content?: Array<{ type: string; text?: string }>;
}

function extractText(raw: string): string {
  const parsed = JSON.parse(raw) as BedrockMessagesResponse;
  const blocks = parsed.content ?? [];
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
    .trim();
}

// Haiku occasionally wraps the JSON in ```…``` fences or prefixes a short
// explanation. Strip those before parsing.
export function parseClassifierOutput(text: string): ClassifierResult {
  const stripped = stripCodeFences(text).trim();
  const objText = extractFirstJsonObject(stripped);
  if (!objText) {
    throw new Error(`classifier produced no JSON object: ${truncate(text, 200)}`);
  }
  const parsed = JSON.parse(objText) as unknown;
  return ClassifierResponseSchema.parse(parsed);
}

function stripCodeFences(s: string): string {
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return fenceMatch?.[1] ?? s;
}

function extractFirstJsonObject(s: string): string | undefined {
  const start = s.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return undefined;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
