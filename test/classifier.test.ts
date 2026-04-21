import { describe, it, expect } from 'vitest';
import { parseClassifierOutput } from '../src/agent/classifier.js';

describe('parseClassifierOutput', () => {
  it('parses a bare data_query JSON line', () => {
    expect(parseClassifierOutput('{"type":"data_query","reason":"needs fresh pricing"}'))
      .toMatchObject({ type: 'data_query' });
  });

  it('parses a conversational JSON line with a reply', () => {
    expect(parseClassifierOutput('{"type":"conversational","reply":"Hi! Ask me anything about Nelson."}'))
      .toMatchObject({ type: 'conversational', reply: expect.stringContaining('Ask me anything') });
  });

  it('strips ```json code fences around the JSON', () => {
    expect(parseClassifierOutput('```json\n{"type":"conversational","reply":"sure thing"}\n```'))
      .toMatchObject({ type: 'conversational', reply: 'sure thing' });
  });

  it('ignores leading explanatory prose before the JSON object', () => {
    expect(parseClassifierOutput('Sure, here is the classification: {"type":"data_query"}'))
      .toMatchObject({ type: 'data_query' });
  });

  it('handles braces inside quoted strings in the reply', () => {
    expect(parseClassifierOutput('{"type":"conversational","reply":"Use curly braces like {{ var }} for templates"}'))
      .toMatchObject({ type: 'conversational', reply: expect.stringContaining('{{ var }}') });
  });

  it('rejects unknown types', () => {
    expect(() => parseClassifierOutput('{"type":"maybe"}')).toThrow();
  });

  it('rejects conversational without a reply', () => {
    expect(() => parseClassifierOutput('{"type":"conversational"}')).toThrow();
  });

  it('rejects output with no JSON object at all', () => {
    expect(() => parseClassifierOutput('I cannot decide, sorry.')).toThrow();
  });
});
