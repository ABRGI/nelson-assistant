import { query, tool, createSdkMcpServer, type Options, type SDKMessage, type SpawnOptions, type SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'node:child_process';
import type { WebClient } from '@slack/web-api';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ClientRecord } from '../auth/clients.js';
import type { IssuedTokens } from '../auth/cognito.js';
import { logger } from '../observability/logger.js';
import { callNelsonApi, NelsonApiInputSchema } from './tools/nelson_api.js';
import { escalateToHuman, EscalateInputSchema } from './tools/escalate.js';
import { gitLog, GitLogInputSchema } from './tools/git_log.js';

export interface RunAgentArgs {
  cwd: string;
  project: string;
  tenant: ClientRecord;
  tokens: IssuedTokens;
  askerSlackUserId: string;
  question: string;
  channel: string;
  threadTs: string;
  slack: WebClient;
  escalationSlackUserId: string;
  sonnetModelId: string;
  psqlReadOnlyUrl?: string;
  onEvent: (event: SDKMessage) => void;
  abortSignal?: AbortSignal;
}

export interface RunAgentResult {
  finalText: string;
  stopReason: string | undefined;
  sessionId: string | undefined;
}

export async function runAgent(args: RunAgentArgs): Promise<RunAgentResult> {
  const seed = await loadSystemSeed(args.cwd, args.project, args.tenant, args.psqlReadOnlyUrl);
  const options: Options = {
    cwd: args.cwd,
    model: args.sonnetModelId,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: seed,
    },
    permissionMode: 'default',
    settingSources: ['project'],
    env: {
      ...process.env,
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_MODEL: args.sonnetModelId,
      AWS_REGION: process.env.AWS_REGION ?? 'eu-west-1',
    },
    spawnClaudeCodeProcess: (opts: SpawnOptions): SpawnedProcess => {
      // Use process.execPath so the correct node binary is found regardless of
      // how npm run dev / tsx watch mutates the child's PATH.
      const command = opts.command === 'node' ? process.execPath : opts.command;
      return spawn(command, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'ignore'],
        signal: opts.signal,
      }) as unknown as SpawnedProcess;
    },
    allowedTools: [
      'Read',
      'Grep',
      'Glob',
      'Bash(git log:*)',
      'Bash(git show:*)',
      'Bash(git diff:*)',
      'Bash(git status:*)',
      'Bash(psql:*)',
      // Destructive `aws logs` subcommands (put/delete/create*) are deliberately absent.
      'Bash(aws logs describe-log-groups:*)',
      'Bash(aws logs describe-log-streams:*)',
      'Bash(aws logs tail:*)',
      'Bash(aws logs filter-log-events:*)',
      'Bash(aws logs get-log-events:*)',
      'Bash(aws logs start-query:*)',
      'Bash(aws logs get-query-results:*)',
      'Bash(aws logs stop-query:*)',
      'mcp__nelson__nelson_api',
      'mcp__nelson__git_log',
      'mcp__nelson__escalate_to_human',
    ],
    mcpServers: {
      nelson: createSdkMcpServer({
        name: 'nelson',
        version: '1.0.0',
        tools: [
          tool(
            'nelson_api',
            'Call the Nelson HTTP API on behalf of the asking Slack user. The base URL and user IdToken are fixed — do not include them. `path` must start with /api/.',
            NelsonApiInputSchema.shape,
            async (input) => {
              const result = await callNelsonApi(
                { client: args.tenant, idToken: args.tokens.idToken, slackUserId: args.askerSlackUserId },
                input,
              );
              return {
                content: [{ type: 'text', text: JSON.stringify(result) }],
              };
            },
          ),
          tool(
            'git_log',
            'Inspect recent commits on the current worktree. Useful for "what is on develop vs release/X" style questions.',
            GitLogInputSchema.shape,
            async (input) => {
              const entries = await gitLog(args.cwd, input);
              return { content: [{ type: 'text', text: JSON.stringify(entries) }] };
            },
          ),
          tool(
            'escalate_to_human',
            'Call this when you cannot safely complete the task: missing permission, destructive action, ambiguous scope, or something that requires human judgment. The designated human will be tagged in Slack.',
            EscalateInputSchema.shape,
            async (input) => {
              const res = await escalateToHuman(
                {
                  slack: args.slack,
                  escalationSlackUserId: args.escalationSlackUserId,
                  channel: args.channel,
                  threadTs: args.threadTs,
                  askerSlackUserId: args.askerSlackUserId,
                  tenantId: args.tenant.tenantId,
                },
                input,
              );
              return { content: [{ type: 'text', text: JSON.stringify(res) }] };
            },
          ),
        ],
      }),
    },
  };

  const iter = query({
    prompt: args.question,
    options,
    ...(args.abortSignal ? { abortController: toAbortController(args.abortSignal) } : {}),
  });

  let finalText = '';
  let stopReason: string | undefined;
  let sessionId: string | undefined;

  for await (const message of iter) {
    args.onEvent(message);
    if (message.type === 'system' && message.subtype === 'init') {
      sessionId = message.session_id;
    }
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') finalText += block.text;
      }
    }
    if (message.type === 'result') {
      stopReason = message.subtype;
      if (message.subtype === 'success' && 'result' in message && message.result) {
        finalText = message.result;
      }
    }
  }

  logger.info(
    { tenantId: args.tenant.tenantId, project: args.project, stopReason, sessionId },
    'agent run complete',
  );
  return { finalText, stopReason, sessionId };
}

async function loadSystemSeed(cwd: string, project: string, tenant: ClientRecord, psqlReadOnlyUrl?: string): Promise<string> {
  const parts: string[] = [
    `You are Nelson Assistant — a friendly, concise hotel operations assistant. You are answering a Slack message from a user on tenant *${tenant.displayName}* (tenantId: ${tenant.tenantId}).`,
    `You have access to the Nelson API and can read the ${project} codebase. You must NOT push to git, create tags, or delete branches.`,
    `Tone and style:`,
    `- Respond like a knowledgeable hotel ops colleague, not a developer documenting an API.`,
    `- Be direct and concise. Lead with the answer, then add context if needed.`,
    `- Never expose raw API response structures, error stack traces, or implementation details to the user.`,
    `- If the API fails or returns incomplete data, try an alternative approach (different endpoint, psql if available) before reporting a limitation. Only tell the user about a limitation when you have exhausted alternatives.`,
    `- When a follow-up question refers to a previous topic (e.g. "what about POR2?"), always carry the full context of the conversation — treat it as if the user asked the complete question again.`,
    `Source citations (HARD RULE — see .claude/knowledge/output-format.yaml): Every factual answer must end with a "Source:" footer in Slack mrkdwn italic, naming the endpoint path + key query params + the JSON field paths you read, OR the SQL query name. If ANY parameter was inferred (date year, occupancy defaults, hotel pick, tenant), add an "Assumed:" footer above the Source footer. Never hand-wave "based on Nelson data". Never report a field value you did not literally read from a tool result. Do not combine fields across different responses unless you cite each one.`,
    `MANDATORY OPENING SEQUENCE (HARD RULE — no exceptions):`,
    `  Step 1: Your FIRST tool call MUST be Read(.claude/knowledge.yaml). It's the tiny index of leaf files under .claude/knowledge/ (tasks.yaml, hotel-identity.yaml, bugs.yaml, enums.yaml, business-rules.yaml, retry-policy.yaml, security-prefixes.yaml, endpoints/*.yaml, db.yaml, db/*.yaml, diagnostics.yaml, support-playbooks.yaml, kpis.yaml, response-shapes.yaml, observability.yaml, modules.yaml) with a when-to-read for each.`,
    `  Step 2: Your SECOND tool call MUST be Read of the most relevant leaf from the index. Picking:`,
    `    - Questions about "can Nelson X" / "is X allowed" / "why doesn't Y work" / age limits / capacity / policies / state machine / validation / what's enforced → Read(.claude/knowledge/business-rules.yaml).`,
    `    - Questions about hotels / reservations / prices / availability / reports / rooms / guests / payments / vouchers / BeonX / channels → Read(.claude/knowledge/tasks.yaml).`,
    `    - Questions about an endpoint that errored → Read(.claude/knowledge/bugs.yaml) + Read(.claude/knowledge/retry-policy.yaml).`,
    `  Step 3: ONLY AFTER those reads may you call mcp__nelson__nelson_api, Bash(psql:…), or any other Nelson-facing action. No tool call to a Nelson endpoint is permitted before the graph reads are done.`,
    `  WHY: Without Step 1-2 you will answer from your pre-training and produce a confident-but-wrong reply with a fabricated citation. This HAS happened in production (score 2/10 from the confidence scorer). The grounding rule is absolute: if the graph has a task or rule that answers the question, it WINS over anything you "remember". Your training is general hotel knowledge; Nelson is specific and often different.`,
    `After the mandatory reads, be economical: read additional leaves ONLY if the initial ones point at them. DO NOT read docs/*.md unless the .claude/knowledge graph explicitly does not cover the task. DO NOT skim the whole graph "just in case".`,
    `Hard rules from the knowledge graph: (1) You are READ-ONLY. Never call non-GET HTTP methods on Nelson APIs (no POST/PUT/PATCH/DELETE), never write to the DB, never edit source code, never send emails/SMS to guests, never rotate credentials. Destructive and state-changing actions MUST go through mcp__nelson__escalate_to_human first — no dry runs, no "let me just check". See .claude/knowledge/authority-boundary.yaml for the full list and the "is this destructive" test. (2) Always check .claude/knowledge/hotel-identity.yaml before any API call that takes a hotel parameter — label (short code like HKI2) and numeric id are NOT interchangeable. (3) Prefer the Nelson API. Fall back to psql only when .claude/knowledge/tasks.yaml flags an SQL path, an endpoint is in .claude/knowledge/bugs.yaml, or the task requires aggregation across hotels/dates. (4) If a task is marked escalate:true or the user's phrasing matches a support-playbook, call mcp__nelson__escalate_to_human and stop.`,
    `If an endpoint errors unexpectedly, check .claude/knowledge/bugs.yaml before retrying.`,
    `Retry budget (HARD RULE — see .claude/knowledge/retry-policy.yaml): After 3 unsuccessful API attempts on the same question (4xx/5xx, or 2xx with empty/wrong-shape data), STOP calling the API. Then: (a) if the task has an SQL fallback in tasks.yaml or a matching query in db/queries.yaml, switch to psql — SQL is NOT second-class, it's pre-validated; (b) if the call takes a hotel segment, try the OTHER identifier (label↔id swap, one-shot — see hotel-identity.yaml); (c) otherwise escalate. NEVER: loop through URL prefix variations (api vs management/secure vs m_app), retry a 405 with the same method, or spam numeric ids hoping one works. The "API tunnel vision" anti-pattern has bitten us — don't.`,
    `Domain invariants (HARD RULE — see .claude/knowledge/business-rules.yaml): Before answering "can Nelson X?" / "why didn't Y happen?" / "is Z allowed?", scan business-rules.yaml for a matching rule. Many things a user reports as "broken" are enforced by design — underage main guest, refund > paid, late breakfast order, advance-booking cap, ECI buffer exhausted, voucher expired, multi-tenancy scoping, etc. Quote the rule + its source_file in the Source footer. Never say "Nelson forbids X" without a concrete rule + source.`,
    `Rules:`,
    `- All Nelson API calls must go through the nelson_api tool.`,
    `- If an action is risky, destructive, or requires human judgment, call escalate_to_human and stop.`,
    `- Format answers for Slack mrkdwn: *bold*, bullet lists with •, \`code\`. No Markdown tables (| col |) — Slack does not render them.`,
    ...(psqlReadOnlyUrl
      ? [`- A read-only PostgreSQL observer connection is available at the environment variable PSQL_READ_ONLY_URL. You may use it with \`psql "$PSQL_READ_ONLY_URL" -c "..."\` for direct DB queries when the API does not expose the data you need. SELECT only; no writes.`]
      : []),
    `- CloudWatch Logs are readable via \`aws logs tail <group> --since <N>m --region eu-central-1\` (plus filter-log-events / get-log-events / start-query / get-query-results). Task role is read-only on /ecs/* and /aws/codebuild/*. Use this for live-issue diagnosis (500s, OTA sync failures, stuck payment flows, missing emails). Load .claude/knowledge/observability.yaml in the worktree for the log-group map, CLI recipes, and tenant → group routing. Cite the exact group + filter + --since value in the Source footer.`,
  ];
  for (const candidate of [
    path.join(cwd, 'CLAUDE.md'),
    path.join(cwd, '.claude', 'CLAUDE.md'),
  ]) {
    try {
      const content = await readFile(candidate, 'utf-8');
      parts.push(`--- ${path.basename(path.dirname(candidate))}/CLAUDE.md ---`, content.slice(0, 8_000));
      break;
    } catch {
      // try next
    }
  }
  return parts.join('\n\n');
}

function toAbortController(signal: AbortSignal): AbortController {
  const ctrl = new AbortController();
  if (signal.aborted) ctrl.abort();
  else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  return ctrl;
}
