import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import type { BedrockUsage } from '../observability/bedrock-usage.js';
import { logger } from '../observability/logger.js';

// Titan Text Embedding v2 invoked via Bedrock. Offline use only — never on
// the hot path. Called by the topic-analysis job to embed user questions
// for similarity clustering.

export interface TitanEmbedderDeps {
  modelId: string;
  client: BedrockRuntimeClient;
  dimensions?: number; // 1024 default, also supports 256 / 512
}

export interface TitanEmbedResult {
  vector: number[];
  usage: BedrockUsage;
}

interface TitanResponseBody {
  embedding?: number[];
  inputTextTokenCount?: number;
}

export class TitanEmbedder {
  private readonly dims: number;

  constructor(private readonly deps: TitanEmbedderDeps) {
    this.dims = deps.dimensions ?? 1024;
  }

  get dimensions(): number {
    return this.dims;
  }

  async embed(text: string): Promise<TitanEmbedResult> {
    const started = Date.now();
    const body = {
      inputText: text,
      dimensions: this.dims,
      normalize: true,
    };
    const res = await this.deps.client.send(
      new InvokeModelCommand({
        modelId: this.deps.modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(body),
      }),
    );
    const raw = new TextDecoder().decode(res.body);
    const parsed = JSON.parse(raw) as TitanResponseBody;
    if (!Array.isArray(parsed.embedding) || parsed.embedding.length === 0) {
      throw new Error(`Titan embed returned no vector (textLen=${text.length})`);
    }
    const usage: BedrockUsage = {
      inputTokens: parsed.inputTextTokenCount ?? 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    logger.debug(
      { durationMs: Date.now() - started, dims: parsed.embedding.length, usage },
      'titan embed',
    );
    return { vector: parsed.embedding, usage };
  }
}
