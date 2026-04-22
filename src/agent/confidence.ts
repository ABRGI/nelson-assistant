import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';
import { logger } from '../observability/logger.js';
import { extractBedrockResponse, type BedrockUsage } from '../observability/bedrock-usage.js';

// Post-answer grounding score. Haiku reviews the user's question, the assistant's
// reply, and the list of tools the agent used, and estimates how well-grounded
// the reply is. Low scores flag replies that probably have a hallucination or
// uncited claim — we surface those to the user AND log them for Phase D review.

const ConfidenceSchema = z.object({
  score: z.number().int().min(1).max(10),
  hedges: z.array(z.string()).max(6).default([]),
});

export type ConfidenceResult = z.infer<typeof ConfidenceSchema> & {
  usage?: BedrockUsage;
};

export interface ConfidenceInput {
  question: string;
  reply: string;
  toolsUsed: string[];
}

export interface ConfidenceScorerDeps {
  haikuModelId: string;
  client: BedrockRuntimeClient;
}

export class ConfidenceScorer {
  constructor(private readonly deps: ConfidenceScorerDeps) {}

  async score(input: ConfidenceInput): Promise<ConfidenceResult> {
    const body = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 200,
      temperature: 0,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: renderUser(input) }],
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
      const result = parseScore(text);
      logger.info(
        { score: result.score, hedgeCount: result.hedges.length, durationMs: Date.now() - started, usage },
        'confidence scored',
      );
      return { ...result, usage };
    } catch (err) {
      logger.warn({ err }, 'confidence scoring failed — defaulting to neutral 5/10');
      return { score: 5, hedges: ['confidence-scorer-failed'] };
    }
  }
}

const SYSTEM_PROMPT = [
  'You score the grounding quality of a Nelson Assistant reply.',
  '',
  'Inputs: the user\'s question, the assistant\'s reply, and the list of tools the agent used (nelson_api endpoints called, files Read, SQL queries run, etc.).',
  '',
  'Score 1-10 by how well the reply is grounded in SOURCED, CITED facts:',
  '- 10: every claim is cited in a Source footer that names an endpoint, SQL query, or file:line the agent actually used. No inferred defaults.',
  '- 7-9: mostly cited, but some minor claims are uncited or rely on inferred defaults (occupancy, date year, hotel pick). Assumptions are noted in an "Assumed:" footer.',
  '- 4-6: partially cited — some claims come from tool output, others are guesses or ungrounded narrative. Source footer is missing key details.',
  '- 1-3: ungrounded or fabricated. No Source footer, or the footer is generic ("based on Nelson data"). Fields invented. Year defaulted silently.',
  '',
  'Output format — one JSON object on one line only, no markdown:',
  '  {"score": <1-10>, "hedges": ["<flag1>", ...]}',
  '',
  'hedges is a short list of up to 6 brief labels describing why the score isn\'t 10. Examples: "no_source_footer", "year_assumed_silently", "hotel_pick_unexplained", "api_response_summarised_unclear_field", "appears_to_paraphrase_industry_knowledge". Empty array [] if score is 9 or 10.',
  '',
  'Be a strict reviewer. Replies that "sound right" but have no citations get 4 or less. Cite the concrete evidence you see (tool name + path/field).',
].join('\n');

function renderUser(input: ConfidenceInput): string {
  return [
    'User question:',
    input.question,
    '',
    'Assistant reply:',
    input.reply,
    '',
    'Tools the agent used (in order):',
    input.toolsUsed.length === 0 ? '(none)' : input.toolsUsed.map((t) => `- ${t}`).join('\n'),
    '',
    'Produce the JSON score now.',
  ].join('\n');
}

export function parseScore(text: string): ConfidenceResult {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const stripped = (fenceMatch?.[1] ?? text).trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error(`confidence scorer produced no JSON object: ${stripped.slice(0, 120)}`);
  const obj = JSON.parse(stripped.slice(start, end + 1)) as unknown;
  return ConfidenceSchema.parse(obj);
}
