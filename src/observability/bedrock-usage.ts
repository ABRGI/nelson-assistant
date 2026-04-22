export interface BedrockUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

interface BedrockMessagesResponseBody {
  content?: Array<{ type: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export interface ExtractedBedrockResponse {
  text: string;
  usage: BedrockUsage;
}

export function extractBedrockResponse(rawJson: string): ExtractedBedrockResponse {
  const parsed = JSON.parse(rawJson) as BedrockMessagesResponseBody;
  const text = (parsed.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
    .trim();
  const u = parsed.usage ?? {};
  return {
    text,
    usage: {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
    },
  };
}
