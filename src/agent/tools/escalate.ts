import type { WebClient } from '@slack/web-api';
import { z } from 'zod';
import { logger } from '../../observability/logger.js';

export const EscalateInputSchema = z.object({
  reason: z.string().min(1),
  severity: z.enum(['low', 'medium', 'high']).default('medium'),
  suggested_action: z.string().optional(),
});
export type EscalateInput = z.infer<typeof EscalateInputSchema>;

export interface EscalateContext {
  slack: WebClient;
  escalationSlackUserId: string;
  channel: string;
  threadTs: string;
  askerSlackUserId: string;
  tenantId: string;
}

export interface EscalateResult {
  acknowledged: true;
  tagged: string;
}

export async function escalateToHuman(
  ctx: EscalateContext,
  input: EscalateInput,
): Promise<EscalateResult> {
  const parsed = EscalateInputSchema.parse(input);
  const permalink = await ctx.slack.chat.getPermalink({
    channel: ctx.channel,
    message_ts: ctx.threadTs,
  }).catch(() => ({ permalink: undefined }));

  const text = [
    `:sos: <@${ctx.escalationSlackUserId}> escalation from <@${ctx.askerSlackUserId}> on tenant *${ctx.tenantId}*`,
    `*Severity:* ${parsed.severity}`,
    `*Reason:* ${parsed.reason}`,
    parsed.suggested_action ? `*Suggested action:* ${parsed.suggested_action}` : undefined,
    permalink.permalink ? `*Thread:* ${permalink.permalink}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');

  await ctx.slack.chat.postMessage({
    channel: ctx.channel,
    thread_ts: ctx.threadTs,
    text,
    mrkdwn: true,
  });
  logger.warn(
    { askerSlackUserId: ctx.askerSlackUserId, tenantId: ctx.tenantId, severity: parsed.severity },
    'escalate_to_human invoked',
  );
  return { acknowledged: true, tagged: ctx.escalationSlackUserId };
}
