import 'dotenv/config';
import { App, ExpressReceiver, LogLevel, SocketModeReceiver } from '@slack/bolt';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import express from 'express';
import path from 'node:path';
import { writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import { loadConfig, type AppConfig } from './config/env.js';
import { logger } from './observability/logger.js';
import { S3JsonStore } from './state/s3.js';
import { FsJsonStore } from './state/fs.js';
import type { JsonStore } from './state/types.js';
import { AwsSecretVault } from './secrets/aws.js';
import { FsSecretVault } from './secrets/fs.js';
import type { SecretVault } from './secrets/types.js';
import { ClientRegistry, type ClientRecord } from './auth/clients.js';
import { UserBindingStore } from './auth/binding.js';
import { CognitoExchanger } from './auth/cognito.js';
import { NonceStore } from './auth/nonce.js';
import { buildAuthRouter } from './auth/web.js';
import { WorktreePool, type ProjectRemote } from './worktree/pool.js';
import { InProcQueue } from './queue/inproc.js';
import { registerCommands } from './slack/commands.js';
import { registerEvents } from './slack/events.js';
import { makeHandler } from './agent/pipeline.js';
import { HaikuClassifier } from './agent/classifier.js';
import { ConfidenceScorer } from './agent/confidence.js';
import { ChatLog } from './observability/chatlog.js';
import { loadKnowledgeBundle } from './knowledge/loader.js';
import { loadTenantHotelsFromBundle } from './knowledge/tenant-hotels.js';
import { LeafPicker } from './knowledge/picker.js';
import { buildPsqlPool } from './agent/tools/psql.js';

const DEFAULT_PROJECT = 'nelson';
// Knowledge graph lands on `develop` first; switch to 'master' once the team's
// develop→master release flow has merged the graph files.
const DEFAULT_BRANCH = 'develop';
const KNOWLEDGE_ROOT = path.resolve(process.cwd(), 'knowledge');

async function main(): Promise<void> {
  const config = await loadConfig();
  const { store, vault } = await buildStores(config);
  const dynamo = buildDynamoClient(config);

  const clients = new ClientRegistry(dynamo, config.NELSON_TENANTS_TABLE);
  await clients.load();

  const bindings = new UserBindingStore(store, config.runtime.tokenEncryptionKey, config.runtime.idHashKey);
  const cognito = new CognitoExchanger({
    userManagementBaseUrl: config.NELSON_USER_MGMT_BASE_URL,
  });
  const nonces = new NonceStore(store);

  const resolveTenant = buildTenantResolver(clients, config.DEFAULT_TENANT_ID);

  const sshKeyPath = await writeSshKey(config.runtime.githubDeployKey);
  // The worktree pool now only serves the rare mcp__nelson__deep_research
  // fallback path. No startup warmup — cold paths are fine because the hot
  // path doesn't touch source.
  const worktrees = new WorktreePool(config.WORKSPACE_ROOT, buildRemotes(), 4, sshKeyPath);
  await worktrees.init();

  const knowledge = await loadKnowledgeBundle(KNOWLEDGE_ROOT);
  const tenantHotels = loadTenantHotelsFromBundle(knowledge);
  logger.info(
    { count: tenantHotels.hotels.length, ambiguousCities: tenantHotels.ambiguousCities },
    'tenant hotel roster loaded',
  );

  const psqlPool = config.runtime.psqlReadOnlyUrl
    ? buildPsqlPool(config.runtime.psqlReadOnlyUrl)
    : undefined;
  if (psqlPool) logger.info('psql observer pool initialised');

  const bedrock = new BedrockRuntimeClient(awsClientConfig(config));
  const classifier = new HaikuClassifier({
    haikuModelId: config.BEDROCK_CLASSIFIER_MODEL_ID,
    client: bedrock,
    knownHotels: tenantHotels.hotels,
    ambiguousCities: tenantHotels.ambiguousCities,
  });
  const leafPicker = new LeafPicker({
    modelId: config.BEDROCK_LEAF_PICKER_MODEL_ID,
    client: bedrock,
    bundle: knowledge,
  });
  const confidence = new ConfidenceScorer({
    haikuModelId: config.BEDROCK_CONFIDENCE_MODEL_ID,
    client: bedrock,
  });

  const chatlog = new ChatLog(store, true);

  const { app, startBolt, maybeExpress } = buildSlackApp(config);

  const queue = new InProcQueue(6, async (channel, threadTs, message) => {
    await app.client.chat.postMessage({
      channel,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      text: `${message}\nContact <@${config.ESCALATION_SLACK_USER_ID}> for help.`,
    });
  });
  const handler = makeHandler({
    app,
    bindings,
    clients,
    cognito,
    nonces,
    worktrees,
    classifier,
    leafPicker,
    knowledge,
    confidence,
    chatlog,
    defaultProject: DEFAULT_PROJECT,
    defaultBranch: DEFAULT_BRANCH,
    sonnetModelId: config.BEDROCK_SONNET_MODEL_ID,
    ...(config.runtime.psqlReadOnlyUrl ? { psqlReadOnlyUrl: config.runtime.psqlReadOnlyUrl } : {}),
    ...(psqlPool ? { psqlPool } : {}),
    store,
    knownHotelLabels: tenantHotels.hotels.map((h) => h.label),
    escalationSlackUserId: config.ESCALATION_SLACK_USER_ID,
    authCallbackBaseUrl: config.AUTH_CALLBACK_BASE_URL,
    resolveTenant,
    runtimeCwd: os.tmpdir(),
  });
  const enqueue = queue.create(handler);

  registerCommands(app, {
    bindings,
    nonces,
    enqueue,
    chatlog,
    authCallbackBaseUrl: config.AUTH_CALLBACK_BASE_URL,
  });

  let selfUserId: string | undefined;
  try {
    const auth = await app.client.auth.test();
    selfUserId = auth.user_id;
    logger.info({ selfUserId, team: auth.team }, 'slack auth.test ok');
  } catch (err) {
    logger.warn({ err }, 'slack auth.test failed — mentions may not strip the bot user id');
  }
  registerEvents(app, enqueue, selfUserId, chatlog);

  // /health and /ready are pre-registered in buildSlackApp (HTTP mode) or below (socket dev mode).
  if (config.runtime.slackAppToken && maybeExpress) {
    maybeExpress.get('/health', (_req, res) => {
      res.json({ ok: true, inFlight: queue.size() });
    });
    maybeExpress.get('/ready', (_req, res) => {
      res.json({ ok: true, tenants: clients.list().map((c) => c.tenantId) });
    });
  }

  const authRouter = buildAuthRouter({
    nonces,
    bindings,
    cognito,
    slack: app,
    displayName: config.NELSON_DISPLAY_NAME,
  });
  // Mount auth routes on the main Express app (port 3000 / ALB) so that
  // https://assistant.nelson.management/auth/login/:nonce is reachable.
  if (maybeExpress) {
    maybeExpress.set('trust proxy', config.isDev ? false : 1);
    maybeExpress.use(authRouter);

    maybeExpress.get('/refresh', async (_req, res) => {
      const project = typeof _req.query['project'] === 'string' ? _req.query['project'] : undefined;
      worktrees.refresh(project).then(() => {
        logger.info({ project: project ?? 'all' }, 'manual repo refresh complete');
      }).catch((err) => {
        logger.error({ err, project }, 'manual repo refresh failed');
      });
      res.json({ ok: true, message: `refresh triggered for ${project ?? 'all projects'}` });
    });
  }

  await startBolt();
  logger.info(
    {
      port: config.PORT,
      authBaseUrl: config.AUTH_CALLBACK_BASE_URL,
      mode: config.runtime.slackAppToken ? 'socket' : 'http',
      storage: config.storageMode,
    },
    'nelson-assistant listening',
  );
}

async function buildStores(config: AppConfig): Promise<{ store: JsonStore; vault: SecretVault }> {
  if (config.storageMode === 'fs') {
    const root = path.resolve(config.LOCAL_STATE_ROOT);
    const stateRoot = path.join(root, 'state');
    const secretRoot = path.join(root, 'secrets');
    const store = new FsJsonStore(stateRoot);
    await store.init();
    const vault = new FsSecretVault(secretRoot);
    await vault.init();
    logger.info({ root }, 'using filesystem-backed stores (dev)');
    return { store, vault };
  }
  const clientConfig = awsClientConfig(config);
  const s3 = new S3JsonStore(config.STATE_BUCKET!, clientConfig);
  const vault = new AwsSecretVault(clientConfig);
  return { store: s3, vault };
}

/**
 * Build AWS client config that respects AWS_PROFILE (e.g., "nelson") when present.
 * In ECS/Fargate the task role is used automatically — AWS_PROFILE is only set in dev.
 */
function awsClientConfig(config: AppConfig): { region: string; credentials?: ReturnType<typeof fromNodeProviderChain> } {
  const base: { region: string; credentials?: ReturnType<typeof fromNodeProviderChain> } = {
    region: config.AWS_REGION,
  };
  if (config.AWS_PROFILE) {
    base.credentials = fromNodeProviderChain({ profile: config.AWS_PROFILE });
  }
  return base;
}

function buildDynamoClient(config: AppConfig): DynamoDBClient {
  return new DynamoDBClient(awsClientConfig(config));
}

function buildSlackApp(config: AppConfig): {
  app: App;
  startBolt: () => Promise<void>;
  maybeExpress: express.Application | undefined;
} {
  if (config.runtime.slackAppToken) {
    const receiver = new SocketModeReceiver({
      appToken: config.runtime.slackAppToken,
      logLevel: config.isDev ? LogLevel.DEBUG : LogLevel.INFO,
    });
    const app = new App({
      token: config.runtime.slackBotToken,
      receiver,
      logLevel: config.isDev ? LogLevel.DEBUG : LogLevel.INFO,
    });
    // SocketModeReceiver has no HTTP server; start a tiny express for health probes in dev.
    const expressApp = express();
    const startBolt = async () => {
      await app.start();
      await new Promise<void>((resolve) => {
        expressApp.listen(config.PORT, () => resolve());
      });
    };
    return { app, startBolt, maybeExpress: expressApp };
  }

  // Register /health and /ready BEFORE passing to ExpressReceiver so they are first
  // in the Express middleware stack (Bolt mounts its router via app.use() in its constructor,
  // which would shadow routes registered afterwards on receiver.app).
  const expressApp = express();
  expressApp.get('/health', (_req, res) => res.json({ ok: true }));
  expressApp.get('/ready', (_req, res) => res.json({ ok: true }));

  const receiver = new ExpressReceiver({
    app: expressApp,
    signingSecret: config.runtime.slackSigningSecret,
    endpoints: {
      events: '/slack/events',
      commands: '/slack/commands',
      interactive: '/slack/interactive',
    },
    processBeforeResponse: true,
  });
  const app = new App({
    token: config.runtime.slackBotToken,
    receiver,
  });
  const startBolt = async () => {
    await app.start(config.PORT);
  };
  return { app, startBolt, maybeExpress: expressApp };
}

/**
 * For Stage 1 we route every `/nelson` question to a single tenant. Picks
 * DEFAULT_TENANT_ID if set, else the sole registered tenant. Multi-tenant
 * per-query routing (JWT claims, explicit flag, Haiku classifier) is V2.
 */
function buildTenantResolver(
  clients: ClientRegistry,
  explicitDefault: string | undefined,
): () => ClientRecord {
  return () => {
    if (explicitDefault) {
      const match = clients.get(explicitDefault);
      if (!match) {
        throw new Error(
          `DEFAULT_TENANT_ID="${explicitDefault}" is not registered. Known: ${clients.list().map((c) => c.tenantId).join(', ') || '(none)'}`,
        );
      }
      return match;
    }
    const all = clients.list();
    if (all.length === 1) return all[0]!;
    if (all.length === 0) {
      throw new Error('No tenants registered. Drop a clients/<tenantId>.json into the state store.');
    }
    throw new Error(
      `Multiple tenants registered (${all.map((c) => c.tenantId).join(', ')}); set DEFAULT_TENANT_ID to pick one.`,
    );
  };
}

const KNOWN_REMOTES: ProjectRemote[] = [
  { project: 'nelson',                          remoteUrl: 'git@github.com:ABRGI/nelson.git' },
  { project: 'nelson-client-configuration',     remoteUrl: 'git@github.com:ABRGI/nelson-client-configuration.git' },
  { project: 'nelson-user-management-service',  remoteUrl: 'git@github.com:ABRGI/nelson-user-management-service.git' },
  { project: 'omena-mobile-app',                remoteUrl: 'git@github.com:ABRGI/omena-mobile-app.git' },
  { project: 'nelson-management-ui',            remoteUrl: 'git@github.com:ABRGI/nelson-management-ui.git' },
  { project: 'nelson-bui-2.0',                  remoteUrl: 'git@github.com:ABRGI/nelson-bui-2.0.git' },
  { project: 'omena-service-app',               remoteUrl: 'git@github.com:ABRGI/omena-service-app.git' },
  { project: 'nelson-tenant-management-service', remoteUrl: 'git@github.com:ABRGI/nelson-tenant-management-service.git' },
];

function buildRemotes(): Map<string, ProjectRemote> {
  const remotes = new Map<string, ProjectRemote>();
  // Override via env: PROJECT_REMOTES=project=url,project2=url2
  const raw = process.env.PROJECT_REMOTES;
  if (raw) {
    for (const pair of raw.split(',')) {
      const [project, url] = pair.split('=');
      if (project && url) remotes.set(project.trim(), { project: project.trim(), remoteUrl: url.trim() });
    }
  }
  for (const r of KNOWN_REMOTES) {
    if (!remotes.has(r.project)) remotes.set(r.project, r);
  }
  return remotes;
}

async function writeSshKey(key: string | undefined): Promise<string | undefined> {
  if (!key) return undefined;
  const keyPath = path.join(os.tmpdir(), 'nelson-assistant-deploy.pem');
  await writeFile(keyPath, key, { encoding: 'utf-8', mode: 0o600 });
  await chmod(keyPath, 0o600);
  return keyPath;
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal error during startup');
  process.exit(1);
});
