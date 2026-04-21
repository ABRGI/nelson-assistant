import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { logger } from '../observability/logger.js';

export const ClientRecordSchema = z.object({
  tenantId: z.string().min(1),
  displayName: z.string().min(1),
  nelsonApiBaseUrl: z.string().url(),
  dbHost: z.string().optional(),
  dbSchema: z.string().optional(),
  notes: z.string().optional(),
});
export type ClientRecord = z.infer<typeof ClientRecordSchema>;

const DynEnvSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  sitehost: z.string().url(),
  type: z.string().optional(),
});

export class ClientRegistry {
  private cache = new Map<string, ClientRecord>();
  private readonly ddc: DynamoDBDocumentClient;

  constructor(
    dynamo: DynamoDBClient,
    private readonly tableName: string,
  ) {
    this.ddc = DynamoDBDocumentClient.from(dynamo);
  }

  async load(): Promise<void> {
    const next = new Map<string, ClientRecord>();
    let lastKey: Record<string, unknown> | undefined;
    let totalItems = 0;

    do {
      const res = await this.ddc.send(new ScanCommand({
        TableName: this.tableName,
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }));

      for (const item of res.Items ?? []) {
        totalItems++;
        const envList: unknown[] = Array.isArray(item['environments']) ? item['environments'] : [];
        for (const env of envList) {
          const parsed = DynEnvSchema.safeParse(env);
          if (!parsed.success) {
            logger.debug({ env, errors: parsed.error.flatten() }, 'skipping env — schema mismatch');
            continue;
          }
          const { id, name, sitehost } = parsed.data;
          next.set(id, {
            tenantId: id,
            displayName: name,
            nelsonApiBaseUrl: `${sitehost}/api`,
          });
        }
      }

      lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);

    this.cache = next;
    logger.info({ tenants: next.size, scannedItems: totalItems }, 'client registry loaded');
  }

  get(tenantId: string): ClientRecord | undefined {
    return this.cache.get(tenantId);
  }

  list(): ClientRecord[] {
    return [...this.cache.values()];
  }
}
