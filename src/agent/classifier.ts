import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { extractBedrockResponse, type BedrockUsage } from '../observability/bedrock-usage.js';
import { z } from 'zod';
import { formatTurns, type ConversationTurn } from '../slack/history.js';
import { logger } from '../observability/logger.js';

// Authority boundary: Haiku may only read the Slack conversation history the bot
// already has access to and produce text replies. It cannot call Nelson APIs,
// touch the worktree, or exchange tokens. The data-query branch always falls
// through to the Sonnet agent under the asking user's own IdToken.

const ClassifierResponseSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('data_query'),
    reason: z.string().optional(),
    // When the user's current message is a short answer to a prior clarifying
    // question ("all", "HKI2", "yes"), the classifier reconstructs the full
    // question so the downstream agent doesn't have to re-derive it from
    // thread context. Example: prior bot "Which hotel?" + user "all" →
    // effective_question "How many reservations today across all hotels?".
    effective_question: z.string().optional(),
  }),
  z.object({
    type: z.literal('conversational'),
    reply: z.string().min(1),
  }),
  z.object({
    type: z.literal('needs_clarification'),
    reply: z.string().min(1),
    reason: z.string().optional(),
  }),
]);

export type ClassifierResult = z.infer<typeof ClassifierResponseSchema> & {
  usage?: BedrockUsage;
};

export interface TenantHotel {
  label: string;
  city: string;
}

export interface ClassifierDeps {
  haikuModelId: string;
  client: BedrockRuntimeClient;
  knownHotels?: TenantHotel[];
  ambiguousCities?: string[];
}

export class HaikuClassifier {
  private readonly systemPrompt: string;

  constructor(private readonly deps: ClassifierDeps) {
    this.systemPrompt = buildSystemPrompt(deps.knownHotels ?? [], deps.ambiguousCities ?? []);
  }

  async classify(newMessage: string, history: ConversationTurn[]): Promise<ClassifierResult> {
    // Pass the entire thread — no trimming. Haiku is cheap, and truncating the
    // history is the main reason the classifier asks questions that were
    // already answered earlier in the thread.
    const body = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 200,
      temperature: 0,
      // Ephemeral cache on the system prompt — it's identical per call, so Bedrock
      // caches it and subsequent requests skip re-tokenising ~1.5KB of rules.
      system: [{ type: 'text', text: this.systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: buildUserPrompt(newMessage, history),
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
      const { text, usage } = extractBedrockResponse(raw);
      try {
        const parsed = parseClassifierOutput(text);
        logger.info(
          {
            type: parsed.type,
            durationMs: Date.now() - started,
            historyTurns: history.length,
            messageLen: newMessage.length,
            usage,
            ...(parsed.type === 'needs_clarification' ? { reply: parsed.reply, reason: parsed.reason } : {}),
            ...(parsed.type === 'conversational' ? { reply: parsed.reply } : {}),
            ...(parsed.type === 'data_query' ? {
              ...(parsed.effective_question ? { effective_question: parsed.effective_question } : {}),
              ...(parsed.reason ? { reason: parsed.reason } : {}),
            } : {}),
          },
          'haiku classifier',
        );
        return { ...parsed, usage };
      } catch (parseErr) {
        logger.warn(
          { err: parseErr, rawOutput: text.slice(0, 800), usage },
          'haiku classifier JSON parse failed, defaulting to data_query',
        );
        return { type: 'data_query', reason: 'classifier_parse_error', usage };
      }
    } catch (err) {
      logger.warn({ err }, 'haiku classifier call failed, defaulting to data_query');
      return { type: 'data_query', reason: 'classifier_error' };
    }
  }
}

function buildSystemPrompt(knownHotels: TenantHotel[], ambiguousCities: string[]): string {
  const hotelList = knownHotels.length
    ? knownHotels.map((h) => `    ${h.label} — ${h.city}`).join('\n')
    : '    (no hotel roster available — always ask which hotel unless clearly chain-wide)';
  const ambiguousCityList = ambiguousCities.length
    ? ambiguousCities.map((c) => {
        const labels = knownHotels.filter((h) => h.city === c).map((h) => h.label);
        return `    ${c}: ${labels.join(', ')}`;
      }).join('\n')
    : '    (none)';

  return [
    'You are the conversational pre-classifier in front of Nelson Assistant — a Slack bot for hotel-operations staff. The main agent (Claude Sonnet) has access to the Nelson HTTP API, a read-only DB, source code, and logs; running it costs real money and a few seconds.',
    '',
    'READ THE WHOLE THREAD AS ONE FLOWING CONVERSATION. Do not classify the latest message in isolation. A real colleague would scroll through what has been said so far and figure out what the user wants RIGHT NOW. That is your job.',
    '',
    'Your only output is a single JSON object. Pick exactly one of three verdicts:',
    '- type="data_query"          — run the Sonnet agent.',
    '- type="conversational"      — reply directly from thread context (no agent run). Include `reply`.',
    '- type="needs_clarification" — ask the user one short question before running the agent. Include `reply`.',
    '',
    'DEFAULT BIAS: data_query. If the user clearly wants Nelson data AND you can reconstruct a complete question from the thread, choose data_query. Clarifying is a LAST resort — only when even a careful reading of the thread leaves genuine ambiguity that would materially change the answer.',
'',
'NO CONFIRMATION QUESTIONS. If you can reconstruct the intent with ~80% confidence, just pick data_query with effective_question and run. Do NOT emit needs_clarification to confirm you got it right. FORBIDDEN reply shapes: "Are you asking X, or something else?", "Did you mean X?", "Just to confirm, you want X?". If you would write one of those, you already know enough — emit data_query instead.',
'',
'NO PROMISES YOU CAN\'T KEEP. You have NO tools — you cannot query Nelson, read the DB, fetch reservations, or run anything. Your only three outputs are data_query (hands off to Sonnet), conversational (short reply from context), needs_clarification (one short question). If the user is asking for data OR pointing out a wrong answer OR asking you to re-run something, that is data_query — it is NEVER conversational. FORBIDDEN reply phrases: "Let me run …", "Let me check …", "Let me pull …", "Let me query …", "I\'ll fetch …", "I\'ll re-run …", "Let me look that up", "One sec, I\'ll verify", "Thanks for catching that — let me …". If you were about to write one of those, emit data_query with an effective_question describing exactly what Sonnet should run.',
'',
'COMPOUND ANSWERS are fine. The user may answer a "which hotel" clarification with one label ("HKI2"), multiple labels ("POR2 and HAN1", "HKI2, HKI3"), a city ("Helsinki" — then use the city\'s labels), or "all"/"all hotels". Each is unambiguous — reconstruct and go. Example: bot asked "Which hotel?" and user replies "POR2 and HAN1" → {"type":"data_query","reason":"user answered clarification with two hotels","effective_question":"How many reservations today at POR2 and HAN1?"}.',
    '',
    '## How to read the thread',
    '',
    'Walk through the thread and ask yourself, in order:',
    '1. What Nelson question is the user currently trying to get answered? (It may span several messages.)',
    '2. Has the user narrowed / changed scope since the original ask? (e.g. later said "actually make it HKI3", "just Booking.com", "for this week instead")',
    '3. Is the latest message a standalone new topic, or a continuation / clarification / correction of something earlier?',
    '4. Do I have every parameter I need to pass a complete question to Sonnet? If yes → data_query with the reconstructed question. If not → needs_clarification for the ONE missing parameter.',
    '',
    '## When to set `effective_question` (data_query only)',
    '',
    'Whenever the user\'s latest message is NOT a fully self-contained question, set `effective_question` to the full reconstructed intent using the whole thread. This saves the Sonnet agent from re-deriving it and stops loops.',
    '',
    'Common patterns where you MUST reconstruct:',
    '- **Answer to a prior clarification**. Bot asked "Which hotel?" → user says "all" / "HKI2" / "Helsinki". Reconstruct: "<original question> for <answer>".',
    '- **Follow-up / scope change**. Earlier: "How many reservations at HKI2 today?" → user says "what about POR2?" → reconstruct: "How many reservations at POR2 today?".',
    '- **Correction**. Earlier user asked about HKI2, then says "sorry I meant HKI3" → reconstruct for HKI3.',
    '- **Additional filter**. Earlier: "Reservations at HKI2 today?" already answered → user adds "only Booking.com" → reconstruct: "Reservations at HKI2 today from Booking.com only".',
    '- **Multi-message build-up**. User sent "arrivals" then "for HKI2" then "tomorrow" — consolidate into "arrivals at HKI2 tomorrow".',
    '- **Follow-up by reference** ("show me more", "the first one", "that reservation"). Resolve the reference against the prior bot reply + reconstruct.',
    '',
    'When the latest message is a fresh standalone question with no dependence on earlier turns, `effective_question` can be omitted (or equal to the literal message).',
    '',
    '## When to pick needs_clarification',
    '',
    'ONLY when, after reading the whole thread, a parameter that would change the answer by an order of magnitude is still missing. Almost always this is hotel scope. Keep the question short, offer concrete options, and do NOT attempt to answer the underlying question in the clarification reply.',
    '',
    'BEFORE you emit needs_clarification for hotel scope, you MUST scan every message in the thread (all user AND bot messages, from oldest to newest) for ANY of these signals. If any are present, hotel scope is already known — emit data_query with a reconstructed effective_question instead:',
    '- A hotel label from the roster below (JYL1 / HKI2 / HKI3 / TRE2 / TKU1 / TKU2 / VSA2 / POR2 / HAN1 / JOE1) appears anywhere in the thread, case-insensitive. "Appears" includes comma-separated, "and"-separated, and multi-hotel lists ("POR2 and HAN1 and JOE1").',
    '- A reservation number / booking id / reservation uuid is present anywhere in the thread.',
    '- The user said "all hotels" / "across the chain" / "chain-wide" / "every hotel" / "portfolio" anywhere in the thread.',
    '- The question is a legitimately chain-wide report by definition (chain sales forecast, chain revenue summary, new-sales chain total, "list hotels", "summary by hotel").',
    '',
    'If the user narrowed to specific hotels earlier in the thread (e.g. turn 3 said "POR2 and HAN1"), that scope STICKS until they change it. A later short user message like "arriving today" or "this week" is a FILTER narrowing, not a reset — do NOT ask which hotel again; reconstruct using the scope already established.',
    '',
    'NEVER re-ask a question the user already answered in this thread. NEVER ask two clarifying questions in a row. If more than one parameter is missing, ask only the highest-information-gain one.',
    '',
    'Roster (Prod Omena, the only tenant today):',
    hotelList,
    '',
    'Cities that resolve to multiple active hotels — ALWAYS clarify which label when one of these is named without a specific label:',
    ambiguousCityList,
    '',
    'Clarification reply style:',
    '- One short sentence in the voice of a friendly hotel-ops colleague.',
    '- For "which hotel?", list the available labels inline. City ambiguity → narrow to that city\'s labels only.',
    '- Example: "Which hotel? (HKI2 / HKI3 / TRE2 / TKU1 / TKU2 / JYL1 / VSA2 / POR2 / HAN1 / JOE1, or `all hotels`)."',
    '',
    '## When to pick conversational',
    '',
    'Only for:',
    '- Greetings ("hi", "hey Nelson", "morning").',
    '- Thanks / acknowledgements ("thanks", "got it", "cool").',
    '- Chit-chat with no Nelson content.',
    '- A request that can be answered word-for-word from the preceding bot message (e.g. "repeat that last part").',
    '',
    'NEVER pick conversational for ANY question about Nelson features, policies, age limits, capacity, availability, pricing, reservations, products, users, or domain behavior — even if the answer sounds "obvious". General hotel-industry knowledge is NOT Nelson; route to data_query so the answer gets grounded.',
    '',
    'Conversational reply grounding (HARD):',
    '- Your reply must not contain ANY factual claim that is not literally in the preceding thread or in this system prompt. No invented numbers, policies, APIs, hotel details, industry norms.',
    '- If you have nothing grounded to say and the message is not answerable, pick data_query with reason="needs grounding" — do not fabricate a conversational answer.',
    '',
    '## Output format',
    '',
    'A single JSON object on one line. No markdown, no code fences. Exactly one of:',
    '  {"type":"data_query","reason":"<short reason>","effective_question":"<reconstructed full question if needed>"}',
    '  {"type":"conversational","reply":"<Slack mrkdwn reply>"}',
    '  {"type":"needs_clarification","reply":"<one short question>","reason":"<what is missing>"}',
    '',
    '`effective_question` is optional on data_query — include it whenever the latest user message is not self-contained. `reason` is optional on data_query.',
    '',
    'JSON escape discipline (MUST follow):',
    '- Inside any string value, use ONLY single quotes / backticks / parentheses — NEVER double quotes. If you must quote: `like this` or \'like this\'.',
    '- No newlines inside string values. Keep each string on one line. Use " • " between items.',
    '- No backslashes unless you really mean a JSON escape.',
    '- No trailing commas. Must parse with JSON.parse on the first try.',
    '',
    'All user-visible replies must sound like a friendly, concise hotel-ops colleague. Slack mrkdwn allowed (*bold*, `code`, • bullets); no Markdown tables.',
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
