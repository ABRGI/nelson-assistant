import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { JsonStore } from '../state/types.js';
import { ConditionFailedError } from '../state/types.js';
import { logger } from '../observability/logger.js';

/**
 * One-time URL token used by `/nelson-auth` to hand off Slack-bound auth to a
 * web form. The nonce binds {slackUserId, tenantId} at creation time, so even
 * if the URL leaks the attacker can only ever affect *that* Slack user's
 * binding — never inject another user's identity.
 *
 * Lifecycle:
 *   created → (form GET) → (form POST, ok) → consumed (deleted)
 *                        └→ (form POST, 401) → attempts++, still usable until exhausted
 *   created → (TTL elapses) → expired (treated as missing)
 */

export const PendingAuthSchema = z.object({
  nonce: z.string().min(16),
  slackUserId: z.string().min(1),
  createdAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  attempts: z.number().int().nonnegative(),
});
export type PendingAuth = z.infer<typeof PendingAuthSchema>;

export interface NonceStoreOptions {
  ttlMs?: number;
  maxAttempts?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;

export class NonceStore {
  private readonly ttlMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => number;

  constructor(
    private readonly store: JsonStore,
    opts: NonceStoreOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.now = opts.now ?? (() => Date.now());
  }

  async create(args: { slackUserId: string }): Promise<PendingAuth> {
    const nonce = randomBytes(24).toString('base64url');
    const createdAt = this.now();
    const record: PendingAuth = {
      nonce,
      slackUserId: args.slackUserId,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      attempts: 0,
    };
    await this.store.putJson(this.keyFor(nonce), record, { ifNoneMatch: '*' });
    return record;
  }

  /** Returns the pending-auth record if it exists, hasn't expired, and hasn't exceeded attempts. */
  async get(nonce: string): Promise<PendingAuth | null> {
    if (!isPlausibleNonce(nonce)) return null;
    const res = await this.store.getJson<unknown>(this.keyFor(nonce));
    if (!res) return null;
    const parsed = PendingAuthSchema.safeParse(res.value);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'corrupt pending-auth record, deleting');
      await this.store.deleteJson(this.keyFor(nonce)).catch(() => {});
      return null;
    }
    if (parsed.data.expiresAt <= this.now()) {
      await this.store.deleteJson(this.keyFor(nonce)).catch(() => {});
      return null;
    }
    if (parsed.data.attempts >= this.maxAttempts) {
      await this.store.deleteJson(this.keyFor(nonce)).catch(() => {});
      return null;
    }
    return parsed.data;
  }

  /** Count a failed submit against the nonce. Caller still needs to check `get()` next. */
  async recordAttempt(nonce: string): Promise<void> {
    const key = this.keyFor(nonce);
    for (let i = 0; i < 3; i++) {
      const current = await this.store.getJson<PendingAuth>(key);
      if (!current) return;
      try {
        await this.store.putJson(
          key,
          { ...current.value, attempts: current.value.attempts + 1 },
          { ifMatch: current.etag },
        );
        return;
      } catch (err) {
        if (err instanceof ConditionFailedError) continue;
        logger.warn({ err }, 'failed to record auth attempt');
        return;
      }
    }
  }

  async consume(nonce: string): Promise<void> {
    await this.store.deleteJson(this.keyFor(nonce));
  }

  private keyFor(nonce: string): string {
    return `pending-auth/${nonce}.json`;
  }
}

/**
 * Cheap server-side sanity filter before hitting the store, so a path param
 * that's obviously garbage (wrong characters, wrong length) doesn't turn into
 * a storage read.
 */
export function isPlausibleNonce(nonce: string): boolean {
  return /^[A-Za-z0-9_-]{20,64}$/.test(nonce);
}
