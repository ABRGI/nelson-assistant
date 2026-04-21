import { z } from 'zod';
import type { JsonStore } from '../state/types.js';
import { encryptToken, decryptToken, hashId } from '../crypto/token-cipher.js';
import { logger } from '../observability/logger.js';

export const UserBindingSchema = z.object({
  slackUserId: z.string().min(1),
  nelsonUsername: z.string().min(1),
  nelsonSub: z.string().min(1),
  refreshToken: z.string().min(1), // stored encrypted (enc1:... prefix)
  createdAt: z.string(),
  lastUsedAt: z.string().optional(),
});
export type UserBinding = z.infer<typeof UserBindingSchema>;

export class UserBindingStore {
  constructor(
    private readonly store: JsonStore,
    private readonly encryptionKey: string,
    private readonly idHashKey: string,
  ) {}

  async get(slackUserId: string): Promise<UserBinding | null> {
    const res = await this.store.getJson<unknown>(this.keyFor(slackUserId));
    if (!res) return null;
    const parsed = UserBindingSchema.safeParse(res.value);
    if (!parsed.success) {
      logger.warn(
        { slackUserId, errors: parsed.error.flatten() },
        'corrupt user binding, treating as missing',
      );
      return null;
    }
    return parsed.data;
  }

  async upsert(args: {
    slackUserId: string;
    nelsonUsername: string;
    nelsonSub: string;
    refreshToken: string;
  }): Promise<UserBinding> {
    const now = new Date().toISOString();
    const existing = await this.store.getJson<UserBinding>(this.keyFor(args.slackUserId));
    const next: UserBinding = {
      slackUserId: args.slackUserId,
      nelsonUsername: args.nelsonUsername,
      nelsonSub: args.nelsonSub,
      refreshToken: encryptToken(args.refreshToken, this.encryptionKey),
      createdAt: existing?.value.createdAt ?? now,
      lastUsedAt: now,
    };
    await this.store.putJson(this.keyFor(args.slackUserId), next, {
      ...(existing ? { ifMatch: existing.etag } : { ifNoneMatch: '*' }),
    });
    return next;
  }

  async readRefreshToken(binding: UserBinding): Promise<string> {
    return decryptToken(binding.refreshToken, this.encryptionKey);
  }

  async markUsed(slackUserId: string): Promise<void> {
    await this.store.updateJson<UserBinding>(
      this.keyFor(slackUserId),
      () => {
        throw new Error(`cannot markUsed: no binding for ${slackUserId}`);
      },
      (current) => ({ ...current, lastUsedAt: new Date().toISOString() }),
    );
  }

  private keyFor(slackUserId: string): string {
    return `users/${hashId(slackUserId, this.idHashKey)}.json`;
  }
}
