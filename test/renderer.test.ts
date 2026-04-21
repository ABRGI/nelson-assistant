import { describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { ThreadProgressMessage } from '../src/slack/renderer.js';

function fakeSlack(): { slack: WebClient; updates: string[]; ts: string } {
  const updates: string[] = [];
  const ts = '1700000000.000001';
  const postMessage = vi.fn(async () => ({ ok: true, ts }));
  const update = vi.fn(async ({ text }: { text?: string }) => {
    if (text !== undefined) updates.push(text);
    return { ok: true };
  });
  const slack = { chat: { postMessage, update } } as unknown as WebClient;
  return { slack, updates, ts };
}

describe('ThreadProgressMessage', () => {
  it('coalesces bursts of update() calls into a single chat.update', async () => {
    const { slack, updates } = fakeSlack();
    const msg = await ThreadProgressMessage.create(slack, 'C1', 'T1', 'hi', 60);
    msg.update('one');
    msg.update('two');
    msg.update('three');
    await new Promise((r) => setTimeout(r, 120));
    // Latest text wins; earlier updates never reach Slack
    expect(updates.at(-1)).toBe('three');
    // At least one update happened; might be one or two depending on timing,
    // but never three (coalescing works).
    expect(updates.length).toBeLessThanOrEqual(2);
    await msg.finalize('done');
    expect(updates.at(-1)).toBe('done');
  });

  it('finalize flushes even if no prior update was scheduled', async () => {
    const { slack, updates } = fakeSlack();
    const msg = await ThreadProgressMessage.create(slack, 'C1', 'T1', 'hi');
    await msg.finalize('final');
    expect(updates).toEqual(['final']);
  });
});
