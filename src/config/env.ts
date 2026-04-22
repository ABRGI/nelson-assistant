import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import { logger } from '../observability/logger.js';

const BootEnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  AUTH_CALLBACK_PORT: z.coerce.number().int().positive().default(3100),
  AUTH_CALLBACK_BASE_URL: z.string().url().default('http://localhost:3100'),
  AWS_REGION: z.string().default('eu-west-1'),
  AWS_PROFILE: z.string().optional(),
  // When "fs", use filesystem-backed stores (local dev). When "aws", use S3 + Secrets Manager.
  // Defaults: fs in development, aws everywhere else.
  STORAGE_MODE: z.enum(['fs', 'aws']).optional(),
  STATE_BUCKET: z.string().optional(),
  LOCAL_STATE_ROOT: z.string().default('./.local-state'),
  WORKSPACE_ROOT: z.string().default('/work'),
  SECRETS_RUNTIME_NAME: z.string().default('nelson-assistant/runtime'),
  SECRETS_USER_PREFIX: z.string().default('nelson-assistant/user'),
  SECRETS_CLIENT_PREFIX: z.string().default('nelson-assistant/client'),
  BEDROCK_SONNET_MODEL_ID: z.string().default('eu.anthropic.claude-sonnet-4-6'),
  BEDROCK_HAIKU_MODEL_ID: z.string().default('eu.anthropic.claude-haiku-4-5-20251001-v1:0'),
  // Each helper role gets its own model id so we can independently pilot
  // cheaper models (e.g. Amazon Nova Micro / Lite) in shadow mode without
  // touching code. Defaults pin to Haiku today.
  BEDROCK_CLASSIFIER_MODEL_ID: z.string().default('eu.anthropic.claude-haiku-4-5-20251001-v1:0'),
  BEDROCK_LEAF_PICKER_MODEL_ID: z.string().default('eu.anthropic.claude-haiku-4-5-20251001-v1:0'),
  BEDROCK_CONFIDENCE_MODEL_ID: z.string().default('eu.anthropic.claude-haiku-4-5-20251001-v1:0'),
  ESCALATION_SLACK_USER_ID: z.string().min(1),
  // Global Nelson auth — user-management-service covers every tenant/env.
  // Both login and refresh-token exchange go through POST /api/user/login.
  NELSON_USER_MGMT_BASE_URL: z.string().url().default('https://admin.nelson.management'),
  NELSON_DISPLAY_NAME: z.string().default('Nelson'),
  // Which tenant does /nelson target when no explicit routing? Required once >1 tenant is registered.
  DEFAULT_TENANT_ID: z.string().optional(),
  NELSON_TENANTS_TABLE: z.string().default('nelson-tenants'),
  // Dev-only overrides; in prod these come from the runtime secret
  SLACK_SIGNING_SECRET: z.string().optional(),
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  PSQL_READ_ONLY_URL: z.string().optional(),
  // Dev-only: base64 AES-256 key for encrypting refresh tokens in S3.
  // In prod this comes from the runtime secret (tokenEncryptionKey field).
  TOKEN_ENCRYPTION_KEY: z.string().optional(),
  ID_HASH_KEY: z.string().optional(),
});

const RuntimeSecretSchema = z.object({
  slackSigningSecret: z.string().min(1),
  slackBotToken: z.string().min(1),
  slackAppToken: z.string().optional(),
  githubDeployKey: z.string().optional(),
  psqlReadOnlyUrl: z.string().optional(),
  tokenEncryptionKey: z.string().min(1),
  idHashKey: z.string().min(1),
});

export type StorageMode = 'fs' | 'aws';

export type AppConfig = z.infer<typeof BootEnvSchema> & {
  runtime: z.infer<typeof RuntimeSecretSchema>;
  isDev: boolean;
  storageMode: StorageMode;
};

let cached: AppConfig | undefined;

export async function loadConfig(): Promise<AppConfig> {
  if (cached) return cached;

  const boot = BootEnvSchema.parse(process.env);
  const isDev = boot.NODE_ENV !== 'production';
  const storageMode: StorageMode = boot.STORAGE_MODE ?? (isDev ? 'fs' : 'aws');

  if (storageMode === 'aws' && !boot.STATE_BUCKET) {
    throw new Error('STATE_BUCKET is required when STORAGE_MODE=aws');
  }

  // In dev with Slack creds in env, use them directly. Otherwise fetch from Secrets Manager.
  const hasInlineSlackCreds = isDev && boot.SLACK_SIGNING_SECRET && boot.SLACK_BOT_TOKEN;
  const runtime = hasInlineSlackCreds
    ? RuntimeSecretSchema.parse({
        slackSigningSecret: boot.SLACK_SIGNING_SECRET,
        slackBotToken: boot.SLACK_BOT_TOKEN,
        slackAppToken: boot.SLACK_APP_TOKEN,
        psqlReadOnlyUrl: boot.PSQL_READ_ONLY_URL,
        tokenEncryptionKey: boot.TOKEN_ENCRYPTION_KEY,
        idHashKey: boot.ID_HASH_KEY,
      })
    : await fetchRuntimeSecret(boot.SECRETS_RUNTIME_NAME, boot.AWS_REGION);

  cached = { ...boot, runtime, isDev, storageMode };
  logger.info(
    {
      nodeEnv: cached.NODE_ENV,
      storageMode: cached.storageMode,
      stateBucket: cached.STATE_BUCKET,
      localStateRoot: cached.LOCAL_STATE_ROOT,
      awsProfile: cached.AWS_PROFILE,
      region: cached.AWS_REGION,
      sonnet: cached.BEDROCK_SONNET_MODEL_ID,
      haiku: cached.BEDROCK_HAIKU_MODEL_ID,
      socketMode: Boolean(cached.runtime.slackAppToken),
      authCallbackBaseUrl: cached.AUTH_CALLBACK_BASE_URL,
      nelsonUserMgmt: cached.NELSON_USER_MGMT_BASE_URL,
      defaultTenant: cached.DEFAULT_TENANT_ID,
    },
    'config loaded',
  );
  return cached;
}

async function fetchRuntimeSecret(
  name: string,
  region: string,
): Promise<z.infer<typeof RuntimeSecretSchema>> {
  const sm = new SecretsManagerClient({ region });
  const res = await sm.send(new GetSecretValueCommand({ SecretId: name }));
  if (!res.SecretString) {
    throw new Error(`Runtime secret ${name} has no SecretString`);
  }
  return RuntimeSecretSchema.parse(JSON.parse(res.SecretString));
}
