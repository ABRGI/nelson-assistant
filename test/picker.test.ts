import { describe, it, expect } from 'vitest';
import { parsePickerOutput } from '../src/knowledge/picker.js';

describe('parsePickerOutput', () => {
  it('parses a bare JSON object with leaves', () => {
    const r = parsePickerOutput('{"leaves":["nelson/tasks.yaml","nelson/hotel-identity.yaml"],"reason":"pricing+hotel"}');
    expect(r.leaves).toEqual(['nelson/tasks.yaml', 'nelson/hotel-identity.yaml']);
    expect(r.reason).toBe('pricing+hotel');
  });

  it('parses JSON inside ```json fences', () => {
    const r = parsePickerOutput('```json\n{"leaves":["nelson/business-rules.yaml"]}\n```');
    expect(r.leaves).toEqual(['nelson/business-rules.yaml']);
  });

  it('ignores leading prose before the JSON object', () => {
    const r = parsePickerOutput('sure — {"leaves":["nelson/tasks.yaml"],"reason":"ok"}');
    expect(r.leaves).toEqual(['nelson/tasks.yaml']);
  });

  it('accepts an empty leaves array', () => {
    const r = parsePickerOutput('{"leaves":[]}');
    expect(r.leaves).toEqual([]);
  });

  it('caps leaves at 3 via schema (rejects a 4-leaf list)', () => {
    expect(() => parsePickerOutput('{"leaves":["a","b","c","d"]}')).toThrow();
  });

  it('rejects output with no JSON', () => {
    expect(() => parsePickerOutput('I cannot tell.')).toThrow();
  });
});
