import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';
import { logger } from '../observability/logger.js';
import { extractBedrockResponse, type BedrockUsage } from '../observability/bedrock-usage.js';
import type { KnowledgeBundle } from './loader.js';
import { renderLeafCatalogue } from './loader.js';

// The picker's whole job: given a user question + the catalogue of knowledge
// leaves, pick the 1-3 leaves most likely to contain the grounded answer.
// Runs on the cheapest model possible — Haiku today, Nova Micro later.

const MAX_LEAVES = 3;

const PickerResponseSchema = z.object({
  leaves: z.array(z.string()).max(MAX_LEAVES),
  reason: z.string().optional(),
});

export type PickerResult = z.infer<typeof PickerResponseSchema> & {
  usage?: BedrockUsage;
};

export interface LeafPickerDeps {
  modelId: string;
  client: BedrockRuntimeClient;
  bundle: KnowledgeBundle;
}

export class LeafPicker {
  // Catalogue is stable across queries — render once at startup, cache the string
  private readonly catalogue: string;

  constructor(private readonly deps: LeafPickerDeps) {
    this.catalogue = renderLeafCatalogue(deps.bundle);
  }

  async pick(question: string): Promise<PickerResult> {
    if (this.deps.bundle.leaves.size === 0) {
      return { leaves: [], reason: 'empty_bundle' };
    }

    const body = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 250,
      temperature: 0,
      system: [{ type: 'text', text: buildSystemPrompt(this.catalogue), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `User question: ${question}\n\nPick up to ${MAX_LEAVES} leaves. Output JSON only.` }],
    };

    const started = Date.now();
    try {
      const res = await this.deps.client.send(
        new InvokeModelCommand({
          modelId: this.deps.modelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify(body),
        }),
      );
      const raw = new TextDecoder().decode(res.body);
      const { text, usage } = extractBedrockResponse(raw);
      const parsed = parsePickerOutput(text);
      const validLeaves = parsed.leaves.filter((p) => this.deps.bundle.leaves.has(p));
      const dropped = parsed.leaves.filter((p) => !this.deps.bundle.leaves.has(p));
      if (dropped.length) logger.warn({ dropped }, 'leaf picker proposed unknown paths');
      logger.info(
        { chose: validLeaves, dropped: dropped.length, durationMs: Date.now() - started, usage },
        'leaf picker',
      );
      return validLeaves.length > 0
        ? { leaves: validLeaves, usage, ...(parsed.reason ? { reason: parsed.reason } : {}) }
        : { leaves: [], usage, reason: 'picker_no_valid_leaves' };
    } catch (err) {
      logger.warn({ err }, 'leaf picker failed — falling through with no pre-injection');
      return { leaves: [], reason: 'picker_error' };
    }
  }
}

function buildSystemPrompt(catalogue: string): string {
  return [
    'You route user questions to the right knowledge leaves for the Nelson Assistant.',
    '',
    'A knowledge leaf is a small YAML file that contains grounded facts about Nelson — rules, endpoints, schemas, enums, code pointers, etc. Your job: given the user question, pick the 1–3 leaves whose contents are most likely to answer it.',
    '',
    'Bias:',
    '- Always include a "rules/policy" leaf (e.g. nelson/business-rules.yaml) when the question asks about what Nelson allows, forbids, or enforces.',
    '- Include nelson/tasks.yaml when the question maps to a concrete hotel-ops action (list hotels, pricing, reservations, reports, etc.).',
    '- Include nelson/hotel-identity.yaml when a hotel is named in the question.',
    '- Include cross-repo/content-map.yaml when the user wants to change a visible string / hours / description.',
    '- Include the relevant endpoints/*.yaml leaf for narrow single-domain questions (e.g. "pricing" → nelson/endpoints/pricing.yaml).',
    '',
    'Pick fewer, not more — 1 or 2 is usually right. Only pick 3 when the question spans multiple topics.',
    '',
    'If none of the leaves look relevant, return an empty list. Do NOT invent paths.',
    '',
    'Available leaves (path — when to read):',
    catalogue,
    '',
    'Output format (single JSON object on one line, no markdown):',
    '  {"leaves": ["nelson/tasks.yaml", "nelson/hotel-identity.yaml"], "reason": "<one-phrase why>"}',
  ].join('\n');
}

export function parsePickerOutput(text: string): PickerResult {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const stripped = (fenceMatch?.[1] ?? text).trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error(`picker produced no JSON: ${stripped.slice(0, 120)}`);
  const parsed = JSON.parse(stripped.slice(start, end + 1)) as unknown;
  return PickerResponseSchema.parse(parsed);
}
