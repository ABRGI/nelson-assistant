/**
 * Agent-SDK smoke harness. Three stages:
 *   plain   — bare Bedrock round-trip (no MCP)
 *   mcp     — in-process MCP tool (echo)
 *   nelson  — full pipeline: real binding + CognitoExchanger + nelson_api tool
 *
 * Run: npx tsx scripts/agent-smoke.ts [plain|mcp|nelson]
 */
import 'dotenv/config';
import { query, tool, createSdkMcpServer, type SpawnOptions, type SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';

async function main() {
  const model = process.env.BEDROCK_SONNET_MODEL_ID ?? 'eu.anthropic.claude-sonnet-4-6';
  const stage = process.argv[2] ?? 'plain';
  console.log(`\n=== stage: ${stage} ===\n`);

  const spawnClaudeCodeProcess = (opts: SpawnOptions): SpawnedProcess =>
    spawn(opts.command === 'node' ? process.execPath : opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'ignore'],
      signal: opts.signal,
    }) as unknown as SpawnedProcess;

  // --- nelson stage: full pipeline ---
  if (stage === 'nelson') {
    await runNelsonStage(model, spawnClaudeCodeProcess);
    return;
  }

  const options: Parameters<typeof query>[0]['options'] = {
    cwd: process.cwd(),
    model,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'You are a smoke-test assistant. Answer very briefly.' },
    permissionMode: 'default',
    settingSources: ['project'],
    env: {
      ...process.env,
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_MODEL: model,
      AWS_REGION: process.env.AWS_REGION ?? 'eu-west-1',
    },
    spawnClaudeCodeProcess,
    allowedTools: stage === 'mcp'
      ? ['mcp__demo__echo']
      : ['Read', 'Glob'],
  };

  if (stage === 'mcp') {
    options.mcpServers = {
      demo: createSdkMcpServer({
        name: 'demo',
        version: '1.0.0',
        tools: [
          tool(
            'echo',
            'Echo back the provided message.',
            { message: z.string() },
            async (input) => ({
              content: [{ type: 'text', text: `echoed: ${input.message}` }],
            }),
          ),
        ],
      }),
    };
  }

  const prompt =
    stage === 'mcp'
      ? 'Call the mcp__demo__echo tool with message="hello from smoke". Then tell me the echoed text and stop.'
      : 'Say hi in five words or fewer and stop.';

  console.log('prompt:', prompt, '\n');

  try {
    for await (const message of query({ prompt, options })) {
      if (message.type === 'system' && message.subtype === 'init') {
        console.log(`[init] session=${message.session_id}`);
      } else if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text') console.log('[assistant]', block.text);
          else if (block.type === 'tool_use') console.log('[tool_use]', block.name, JSON.stringify(block.input));
        }
      } else if (message.type === 'user') {
        for (const block of message.message.content) {
          if (typeof block === 'object' && 'type' in block && block.type === 'tool_result') {
            console.log('[tool_result]', JSON.stringify(block.content).slice(0, 200));
          }
        }
      } else if (message.type === 'result') {
        console.log(`[result] stop=${message.subtype}`);
        if ('result' in message && message.result) console.log('[final]', message.result);
      }
    }
    console.log('\nOK');
  } catch (err) {
    console.error('\nFAILED:', err);
    process.exit(1);
  }
}

async function runNelsonStage(
  model: string,
  spawnClaudeCodeProcess: (opts: SpawnOptions) => SpawnedProcess,
) {
  // Dynamic imports so plain/mcp stages don't drag in all the service deps.
  const { FsJsonStore } = await import('../src/state/fs.js');
  const { FsSecretVault } = await import('../src/secrets/fs.js');
  const { UserBindingStore: BindingStore } = await import('../src/auth/binding.js');
  const { ClientRegistry } = await import('../src/auth/clients.js');
  const { CognitoExchanger } = await import('../src/auth/cognito.js');
  const { callNelsonApi, NelsonApiInputSchema } = await import('../src/agent/tools/nelson_api.js');

  const stateRoot = process.env.LOCAL_STATE_ROOT ?? './.local-state';
  const store = new FsJsonStore(stateRoot + '/state');
  const vault = new FsSecretVault(stateRoot + '/secrets');
  const bindings = new BindingStore(store, vault);
  const registry = new ClientRegistry(store);
  const cognito = new CognitoExchanger({ userManagementBaseUrl: process.env.NELSON_USER_MGMT_BASE_URL! });

  await registry.load();

  // Use the first binding found in .local-state/state/users/
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(stateRoot + '/state/users').catch(() => [] as string[]);
  if (!files.length) {
    console.error('No user bindings found. Run /nelson in Slack first to create one.');
    process.exit(1);
  }
  const slackUserId = files[0]!.replace('.json', '');
  console.log(`Using binding for Slack user: ${slackUserId}`);

  const binding = await bindings.get(slackUserId);
  if (!binding) { console.error('Binding not found'); process.exit(1); }

  const refreshToken = await bindings.readRefreshToken(binding);
  const tokens = await cognito.exchangeRefresh(slackUserId, binding.nelsonSub, refreshToken);
  console.log(`Token exchange OK — nelsonSub: ${tokens.nelsonSub}`);

  const tenantId = process.env.DEFAULT_TENANT_ID ?? 'omena-prod';
  const tenant = registry.get(tenantId);
  if (!tenant) { console.error(`Tenant ${tenantId} not found`); process.exit(1); }
  console.log(`Tenant: ${tenant.displayName} (${tenant.nelsonApiBaseUrl})\n`);

  const { runAgent } = await import('../src/agent/runner.js');
  const { WebClient } = await import('@slack/web-api');
  const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

  const result = await runAgent({
    cwd: process.cwd(),
    project: 'local',
    tenant,
    tokens,
    askerSlackUserId: slackUserId,
    question: 'What hotels can I see? List them briefly.',
    channel: 'smoke-test',
    threadTs: '0',
    slack,
    escalationSlackUserId: process.env.ESCALATION_SLACK_USER_ID ?? slackUserId,
    sonnetModelId: model,
    onEvent: (msg) => {
      if (msg.type === 'assistant') {
        for (const b of msg.message.content) {
          if (b.type === 'tool_use') console.log(`[tool_use] ${b.name}`, JSON.stringify(b.input).slice(0, 120));
          if (b.type === 'text') console.log(`[assistant] ${b.text}`);
        }
      }
    },
  });

  console.log('\n[final]', result.finalText);
  console.log('[stop]', result.stopReason);
  console.log('\nOK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
