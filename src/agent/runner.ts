import { query, tool, createSdkMcpServer, type Options, type SDKMessage, type SpawnOptions, type SpawnedProcess, type ModelUsage } from '@anthropic-ai/claude-agent-sdk';
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
import { runPsql, PsqlInputSchema } from './tools/psql.js';
import type { Pool as PgPool } from 'pg';
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
  psqlPool?: PgPool;                    // shared node-pg pool — required when psqlReadOnlyUrl is set
  knowledgeInjection?: string;          // pre-picked knowledge leaves rendered as one block
  worktrees: WorktreePool;              // needed for deep_research (it acquires on demand)
  defaultBranch: string;
  onEvent: (event: SDKMessage) => void;
  abortSignal?: AbortSignal;
}

type ModelUsageForChatlog = Pick<ModelUsage, 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens' | 'costUSD'>;

export interface RunAgentCostBreakdown {
  totalCostUsd: number;
  numTurns: number;
  durationMs: number;
  durationApiMs: number;
  deepResearchCalls: number;
  modelUsage: Record<string, ModelUsageForChatlog>;
}

export interface RunAgentResult {
  finalText: string;
  stopReason: string | undefined;
  sessionId: string | undefined;
  cost: RunAgentCostBreakdown | undefined;
}

const DEEP_RESEARCH_MAX_CALLS_PER_JOB = 1;

export async function runAgent(args: RunAgentArgs): Promise<RunAgentResult> {
  const seed = await loadSystemSeed(args.project, args.tenant, args.psqlReadOnlyUrl, args.knowledgeInjection);
  let deepResearchCalls = 0;
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
      'mcp__nelson__psql',
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
            'Call this ONLY for actions a human must perform: destructive writes (edits to DB, calls to non-GET APIs, emails/SMS to guests, credential or door-code changes), missing permission for a write, or an explicit support-playbook that says escalate. DO NOT escalate for read-only questions — if a read-side request is ambiguous or missing scope, REPLY in Slack with a short clarifying question instead (that is not an escalation). DO NOT escalate because you cannot find the data; try the alternative endpoints listed in tasks.yaml / retry-policy.yaml, or switch to psql, then say "I could not find it" and stop — don\'t page a human for a lookup.',
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
            `EXPENSIVE FALLBACK — hard-capped at ${DEEP_RESEARCH_MAX_CALLS_PER_JOB} call per question. Allocates a repo worktree and reads/greps source files to answer a question the pre-injected knowledge leaves cannot. Use SPARINGLY — the knowledge bundle should answer 95%+ of questions. Call this AT MOST ONCE per turn: pack all the file paths and grep patterns you need into that single call. A second call will be REJECTED. After you get results, answer from what you have or say "I don't know" and escalate — do not retry.`,
            DeepResearchInputSchema.shape,
            async (input) => {
              if (deepResearchCalls >= DEEP_RESEARCH_MAX_CALLS_PER_JOB) {
                logger.warn(
                  { tenantId: args.tenant.tenantId, project: input.project, attempt: deepResearchCalls + 1 },
                  'deep_research call rejected — per-job cap reached',
                );
                return {
                  content: [{
                    type: 'text',
                    text: `deep_research: REJECTED — you have already used your ${DEEP_RESEARCH_MAX_CALLS_PER_JOB} deep_research call for this question. Answer from the knowledge leaves and the previous deep_research result. If you truly cannot answer, say "I don't know" and call mcp__nelson__escalate_to_human — do NOT attempt another source read.`,
                  }],
                };
              }
              deepResearchCalls += 1;
              const res = await runDeepResearch(
                { worktrees: args.worktrees, defaultBranch: args.defaultBranch },
                input,
              );
              return { content: [{ type: 'text', text: res.summary }] };
            },
          ),
          ...(args.psqlPool && args.psqlReadOnlyUrl ? [
            tool(
              'psql',
              'Run a READ-ONLY SQL query against the Nelson observer database (PostgreSQL, multi-tenant schemas). Use this for authoritative lookups that the HTTP API cannot serve — e.g. looking up a reservation by its 9-digit code, verifying FK integrity when the API returns 500s, pulling DISTINCT values. SELECT / WITH / EXPLAIN / SHOW only — any INSERT/UPDATE/DELETE/DDL is rejected. Default 100 rows, max 500. Prod Omena data lives under the `nelson` schema (nelson.reservation, nelson.hotel, nelson.line_item, nelson.invoice). NEVER `SELECT *` on nelson.reservation / nelson.line_item / nelson.audit_log — always WHERE-filter by PK, code, or a narrow date range.',
              PsqlInputSchema.shape,
              async (input) => {
                const poolRef = args.psqlPool;
                const urlRef = args.psqlReadOnlyUrl;
                if (!poolRef || !urlRef) {
                  return { content: [{ type: 'text', text: 'psql: tool is not configured in this environment (PSQL_READ_ONLY_URL unset).' }] };
                }
                const res = await runPsql({ pool: poolRef, connectionString: urlRef }, input);
                return { content: [{ type: 'text', text: JSON.stringify(res) }] };
              },
            ),
          ] : []),
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
  let cost: RunAgentCostBreakdown | undefined;

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
      cost = {
        totalCostUsd: message.total_cost_usd,
        numTurns: message.num_turns,
        durationMs: message.duration_ms,
        durationApiMs: message.duration_api_ms,
        deepResearchCalls,
        modelUsage: { ...(message.modelUsage ?? {}) },
      };
    }
  }

  logger.info(
    { tenantId: args.tenant.tenantId, project: args.project, stopReason, sessionId },
    'agent run complete',
  );
  return { finalText, stopReason, sessionId, cost };
}

async function loadSystemSeed(project: string, tenant: ClientRecord, psqlReadOnlyUrl?: string, knowledgeInjection?: string): Promise<string> {
  const parts: string[] = [
    `You are Nelson — a friendly, concise hotel operations assistant answering a Slack message from a user on tenant *${tenant.displayName}* (tenantId: ${tenant.tenantId}).`,
    `Your grounded knowledge about the Nelson ecosystem (${project} + sibling repos) is pre-injected below as yaml leaves. Treat them as your SOURCE OF TRUTH. Quote paths, endpoints, rules, enums, schemas and SQL directly from those leaves. If the leaves don't answer the question, use mcp__nelson__deep_research — see the tool description for the one-call cap.`,
    `Tone and style:`,
    `- Respond like a knowledgeable hotel ops colleague, not a developer documenting an API.`,
    `- Be direct and concise. Lead with the answer, then add context if needed.`,
    `- Never expose raw API response structures, error stack traces, or implementation details to the user.`,
    `- NO thinking out loud. Do not narrate your process to the user: never write "Let me check...", "Looking at the data...", "I need to verify...", "Parsing the response...", "The key field is...". The user sees the final answer only; your reasoning is invisible scaffolding. If you would have written a sentence that describes what you are about to do or are currently doing, delete it.`,
    `- NO repetition. State each fact once. If you are about to restate a conclusion in different words ("All 5 arrivals show state CONFIRMED... Based on the data, all 5 arrivals have state CONFIRMED..."), delete the second version. Summaries go at the END only — never mid-reply.`,
    `- ONE answer per reply. Lead with the direct result. Follow with a short "here's how that breaks down" if the default-breakdown rule applies. End with one optional offer to drill in further ("want me to list specific ones?"). No multi-draft replies.`,
    `- When a follow-up question refers to a previous topic (e.g. "what about POR2?"), always carry the full context of the conversation — treat it as if the user asked the complete question again.`,
    `- Treat short user replies ("all", "HKI2", "yes", "last week") as answers to the bot's immediately preceding question in the thread. NEVER re-ask a clarifying question that was already asked and answered earlier in the same thread. If you still lack a parameter, default to a reasonable interpretation (or "all hotels" if the user literally said "all") and show it in the Assumed footer — do not bounce the question back.`,
    `Grounding rule (ABSOLUTE): Every factual claim must come from one of (a) the pre-injected knowledge below, (b) a tool result in this turn, (c) the preceding Slack conversation. NEVER answer from pre-training memory about Nelson — your training is general hotel industry knowledge, Nelson is specific and often different. If you can't ground a claim, say "I don't know" or escalate. No fabricated file paths, no made-up endpoints, no invented rules.`,
    `Source citation (HARD RULE): Every factual reply must end with an italic "Source:" footer naming the endpoint + key query params + JSON field paths, OR the DB table + a one-line paraphrase of the query (NEVER the raw SQL text), OR the knowledge leaf path. If any parameter was inferred (date year, occupancy defaults, hotel pick, tenant), add an italic "Assumed:" footer above the Source footer.`,
    `NEVER expose to the user: raw SQL query text, source-tree file:line paths, class/function names, code snippets, stack traces, or implementation internals. Cite the concept ("per the ReservationService underage rule") not the code. Full SQL/source details belong in trace logs, not the Slack reply.`,
    `Default breakdown on quantitative replies (HARD RULE — this WINS over any urge to ask for clarification on the same dimensions): when a factual answer includes counts, totals, revenue, or occupancy, break the answer down by EVERY relevant dimension the data carries — hotel, booking channel, room type, and date scope — unless the user explicitly asked for a single scalar. For "reservations today" style questions, ALWAYS show all three cuts side-by-side in the same reply: "created today" (booking_date = today), "arriving today" (arrival_date = today), and "staying tonight" (arrival_date ≤ today < departure_date). Never pick one cut and ask which one they meant — just show all three and let them read the one they care about. Similarly split per-hotel + per-channel + per-room-type. If a dimension isn't in the source, state "(not available in this source)" — never fabricate. See knowledge/nelson/output-format.yaml for the exact structure.`,
    `Clarify before answering (HARD RULE — USE SPARINGLY): ask ONE short clarifying question ONLY when the ambiguity is NOT resolvable by showing a breakdown and WOULD materially change the answer (e.g. unknown hotel scope when the roster has 10 hotels, or "last quarter" = calendar Q1 vs rolling 90 days). Do NOT clarify for dimensions that the default-breakdown rule already handles (reservation-vs-arrival-vs-stay, per-channel, per-room-type). Do NOT re-ask a clarification that was already asked and answered earlier in this same thread — carry the answer forward. Clarifying ≠ escalating — DO NOT call escalate_to_human for read-side ambiguity. Only use escalate_to_human for destructive actions a human must perform.`,
    `Read-only authority: You must NEVER call non-GET HTTP methods on Nelson APIs, NEVER write to the DB, NEVER edit source code, NEVER send emails/SMS to guests, NEVER rotate credentials or door codes. Destructive actions go through mcp__nelson__escalate_to_human first — no dry runs, no "let me just check".`,
    `Retry budget: Max 3 unsuccessful API attempts per question (4xx/5xx or empty/wrong-shape 2xx). After that: switch to psql if the knowledge leaves list an SQL path; swap hotel identifier (label↔id) if the call took a hotel segment; otherwise escalate. Never prefix-loop, never retry a 405 with the same method.`,
    `Reservation identifier routing (HARD RULE): when the user pastes a reservation identifier, route by SHAPE before calling anything — the DB (via mcp__nelson__psql) is faster and authoritative:\n- 36-char UUID (8-4-4-4-12 hyphen pattern) → GET /api/management/secure/reservations/{uuid} first, psql fallback.\n- EXACTLY 9 digits → mcp__nelson__psql with \`SELECT id, uuid, reservation_code, booking_channel, booking_channel_reservation_id, state FROM nelson.reservation WHERE reservation_code = '<code>'\` FIRST (do NOT hit the API blindly — /reservations?code= is fuzzy and can miss). Then use the returned uuid for API follow-ups (payments, invoices, etc.).\n- EXACTLY 10 digits → mcp__nelson__psql with \`SELECT id, uuid, reservation_code, booking_channel, booking_channel_reservation_id FROM nelson.reservation WHERE booking_channel_reservation_id = '<n>'\` (Booking.com / Expedia OTA reference), then use the returned uuid.\n- Otherwise → API search with code/guestName/customerEmail; psql LIKE as fallback.\nSee knowledge/nelson/endpoints/reservations.yaml → identifiers + how_to_route_a_user_supplied_identifier for details. NEVER conclude "reservation does not exist" from a single API 404/500 — verify by shape against the DB first.`,
    `Slack mrkdwn rendering — HARD rules. Replies go straight into Slack; Slack does NOT speak standard Markdown. What breaks if you use GitHub/CommonMark:
    • *single asterisks* = bold. **double asterisks** renders as literal "**". Use *one* asterisk.
    • _underscores_ = italic.
    • ~tilde~ = strikethrough.
    • \`backticks\` = inline code. Triple backticks \`\`\` for code blocks.
    • > at start of a line = blockquote.
    • Bullet lines start with • (U+2022), - or * work too. Numbered lists: "1. ".
    • LINKS: <https://example.com|label> (Slack syntax). Plain Markdown [label](url) does NOT render.
    • NO Markdown TABLES (| col | col |). Slack shows the pipes literally. For tabular data use either:
        (a) bullets: "• *Row name*: col1 val • col2 val"
        (b) aligned columns with spaces inside a code block.
    • Keep headings as *bold* lines, not # or ##.
    • Emoji names work: :white_check_mark: :warning: :wrench: :microscope: etc.
    Every reply MUST follow these or Slack will show garbled text. If you're about to write a pipe table or double-asterisk bold, stop and rewrite.`,
    `Keep replies under 3500 characters (Slack's hard limit forces ugly chunking above ~4000). If the data is long (e.g. >20 reservations or >20 rooms), DO NOT list every row — summarise by the relevant dimensions (per hotel, per channel, per room-type, per state) with counts, then offer: "want me to list specific ones? tell me which slice.". Quote individual rows only when the user explicitly asked for them. Running totals + distribution beats a verbatim dump every time.`,
    ...(psqlReadOnlyUrl
      ? [
          `Direct DB access: the \`mcp__nelson__psql\` tool gives you a read-only SELECT on the Nelson observer database. Prefer it over the HTTP API when you need authoritative lookups the API cannot serve — especially: looking up a reservation by its 9-digit code, verifying state when the API returns 500s with null-pointer errors, pulling DISTINCT values, checking integrity. SELECT / WITH / EXPLAIN / SHOW only — write statements are rejected at the tool layer. Prod Omena data lives under the \`nelson\` schema (\`nelson.reservation\`, \`nelson.hotel\`, \`nelson.line_item\`, \`nelson.invoice\`, etc.). NEVER \`SELECT *\` on \`nelson.reservation\`, \`nelson.line_item\`, \`nelson.audit_log\` or any insert-hot table — always filter by PK, code, or a narrow range.`,
          `API → DB fallback (HARD RULE): whenever the Nelson HTTP API returns 500 / 4xx with a descriptive error ("hotel is null", "reservation is null", "NullPointerException", etc.) AND the user's question is about a specific reservation / invoice / hotel / member, call \`mcp__nelson__psql\` with a targeted SELECT to verify actual DB state BEFORE drawing conclusions. A controller-level NullPointerException usually means a missing FK or a join condition failure, NOT row corruption — only the DB can tell you which. Run the SELECT, state the actual row values, and cite the query in the Source footer. Do NOT conclude "data corruption" or "needs DBA investigation" without DB evidence.`,
        ]
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
