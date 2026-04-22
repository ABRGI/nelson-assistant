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
import { runDeepResearch, DeepResearchInputSchema } from './tools/deep_research.js';
import type { WorktreePool } from '../worktree/pool.js';

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
  knowledgeInjection?: string;          // pre-picked knowledge leaves rendered as one block
  worktrees: WorktreePool;              // needed for deep_research (it acquires on demand)
  defaultBranch: string;
  onEvent: (event: SDKMessage) => void;
  abortSignal?: AbortSignal;
}

export interface RunAgentResult {
  finalText: string;
  stopReason: string | undefined;
  sessionId: string | undefined;
}

export async function runAgent(args: RunAgentArgs): Promise<RunAgentResult> {
  const seed = await loadSystemSeed(args.project, args.tenant, args.psqlReadOnlyUrl, args.knowledgeInjection);
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
    // Hot path has NO source-tree access — the model's only grounding is the
    // pre-injected knowledge bundle. Source reads cost real money; route them
    // through mcp__nelson__deep_research so we can meter + bound them.
    // psql stays (observer role, SELECT-only) and aws logs stay (read-only
    // ECS log tailing for live diagnosis). Git log is exposed via MCP, not Bash.
    allowedTools: [
      'Bash(psql:*)',
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
      'mcp__nelson__deep_research',
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
          tool(
            'deep_research',
            'EXPENSIVE FALLBACK. Allocates a repo worktree and reads / greps source files to answer a question the pre-injected knowledge leaves cannot. Use SPARINGLY — the knowledge bundle should answer 95%+ of questions. Call this only after the knowledge leaves have been consulted and came up short, with a focused list of file paths + optional grep patterns. Returns raw file excerpts with line numbers.',
            DeepResearchInputSchema.shape,
            async (input) => {
              const res = await runDeepResearch(
                { worktrees: args.worktrees, defaultBranch: args.defaultBranch },
                input,
              );
              return { content: [{ type: 'text', text: res.summary }] };
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

async function loadSystemSeed(project: string, tenant: ClientRecord, psqlReadOnlyUrl?: string, knowledgeInjection?: string): Promise<string> {
  const parts: string[] = [
    `You are Nelson — a friendly, concise hotel operations assistant answering a Slack message from a user on tenant *${tenant.displayName}* (tenantId: ${tenant.tenantId}).`,
    `Your grounded knowledge about the Nelson ecosystem (${project} + sibling repos) is pre-injected below as yaml leaves. Treat them as your SOURCE OF TRUTH. Quote paths, endpoints, rules, enums, schemas and SQL directly from those leaves. If the leaves don't answer the question, call mcp__nelson__deep_research ONCE with a focused read/grep — that tool is the only way back into the source tree and is expensive by design.`,
    `Tone and style:`,
    `- Respond like a knowledgeable hotel ops colleague, not a developer documenting an API.`,
    `- Be direct and concise. Lead with the answer, then add context if needed.`,
    `- Never expose raw API response structures, error stack traces, or implementation details to the user.`,
    `- When a follow-up question refers to a previous topic (e.g. "what about POR2?"), always carry the full context of the conversation — treat it as if the user asked the complete question again.`,
    `Grounding rule (ABSOLUTE): Every factual claim must come from one of (a) the pre-injected knowledge below, (b) a tool result in this turn, (c) the preceding Slack conversation. NEVER answer from pre-training memory about Nelson — your training is general hotel industry knowledge, Nelson is specific and often different. If you can't ground a claim, say "I don't know" or escalate. No fabricated file paths, no made-up endpoints, no invented rules.`,
    `Source citation (HARD RULE): Every factual reply must end with an italic "Source:" footer naming the endpoint + key query params + JSON field paths OR the SQL query OR the knowledge leaf path. If any parameter was inferred (date year, occupancy defaults, hotel pick, tenant), add an italic "Assumed:" footer above the Source footer.`,
    `Read-only authority: You must NEVER call non-GET HTTP methods on Nelson APIs, NEVER write to the DB, NEVER edit source code, NEVER send emails/SMS to guests, NEVER rotate credentials or door codes. Destructive actions go through mcp__nelson__escalate_to_human first — no dry runs, no "let me just check".`,
    `Retry budget: Max 3 unsuccessful API attempts per question (4xx/5xx or empty/wrong-shape 2xx). After that: switch to psql if the knowledge leaves list an SQL path; swap hotel identifier (label↔id) if the call took a hotel segment; otherwise escalate. Never prefix-loop, never retry a 405 with the same method.`,
    `Format answers for Slack mrkdwn: *bold*, bullet lists with •, \`code\`. No Markdown tables (| col |) — Slack does not render them.`,
    ...(psqlReadOnlyUrl
      ? [`A read-only PostgreSQL observer connection is available at PSQL_READ_ONLY_URL. Use \`psql "$PSQL_READ_ONLY_URL" -c "..."\` for direct DB queries when the API cannot serve the data. SELECT only.`]
      : []),
    `CloudWatch Logs (task role is read-only on /ecs/* and /aws/codebuild/*): \`aws logs tail <group> --since <N>m --region eu-central-1\` + filter-log-events / get-log-events / start-query / get-query-results. Use for live-issue diagnosis; cite the exact group + filter + --since value in the Source footer.`,
  ];
  if (knowledgeInjection) {
    parts.push(knowledgeInjection);
  }
  return parts.join('\n\n');
}

function toAbortController(signal: AbortSignal): AbortController {
  const ctrl = new AbortController();
  if (signal.aborted) ctrl.abort();
  else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  return ctrl;
}
