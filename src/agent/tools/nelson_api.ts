import { request } from 'undici';
import { z } from 'zod';
import type { ClientRecord } from '../../auth/clients.js';
import { logger } from '../../observability/logger.js';

export const NelsonApiInputSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().regex(/^\/api\//, 'path must start with /api/'),
  body: z.unknown().optional(),
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export type NelsonApiInput = z.infer<typeof NelsonApiInputSchema>;

export interface NelsonApiContext {
  client: ClientRecord;
  idToken: string;
  slackUserId: string;
}

export interface NelsonApiResult {
  status: number;
  body: unknown;
  durationMs: number;
}

/**
 * Single funnel for Nelson API calls. Always uses the asking user's fresh
 * IdToken so Nelson's RBAC applies exactly as it would to that user. The
 * agent cannot override base URL or token.
 */
export async function callNelsonApi(
  ctx: NelsonApiContext,
  input: NelsonApiInput,
): Promise<NelsonApiResult> {
  const parsed = NelsonApiInputSchema.parse(input);
  const url = new URL(parsed.path, ctx.client.nelsonApiBaseUrl);
  if (parsed.query) {
    for (const [k, v] of Object.entries(parsed.query)) url.searchParams.set(k, String(v));
  }
  const startedAt = Date.now();
  const hasBody = parsed.body !== undefined && parsed.method !== 'GET';
  const res = await request(url.toString(), {
    method: parsed.method,
    headers: {
      authorization: `Bearer ${ctx.idToken}`,
      accept: 'application/json',
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(parsed.body) } : {}),
  });
  const text = await res.body.text();
  const durationMs = Date.now() - startedAt;
  let body: unknown = text;
  try {
    if (text) body = JSON.parse(text);
  } catch {
    // leave as text
  }
  logger.info(
    {
      tenantId: ctx.client.tenantId,
      slackUserId: ctx.slackUserId,
      method: parsed.method,
      path: parsed.path,
      status: res.statusCode,
      durationMs,
    },
    'nelson_api call',
  );
  return { status: res.statusCode, body, durationMs };
}
