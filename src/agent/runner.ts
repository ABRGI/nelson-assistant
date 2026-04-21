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
    `Before making any Nelson API call, read the API reference at docs/12-api-reference.md in the worktree to find the correct endpoint and parameters. Do not guess API paths — always look them up first.`,
    `Also read docs/00-overview.md for domain context if needed.`,
    `Rules:`,
    `- All Nelson API calls must go through the nelson_api tool.`,
    `- If an action is risky, destructive, or requires human judgment, call escalate_to_human and stop.`,
    `- Format answers for Slack mrkdwn: *bold*, bullet lists with •, \`code\`. No Markdown tables (| col |) — Slack does not render them.`,
    ...(psqlReadOnlyUrl
      ? [`- A read-only PostgreSQL observer connection is available at the environment variable PSQL_READ_ONLY_URL. You may use it with \`psql "$PSQL_READ_ONLY_URL" -c "..."\` for direct DB queries when the API does not expose the data you need. SELECT only; no writes.`]
      : []),
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
