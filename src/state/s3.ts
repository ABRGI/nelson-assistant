import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { logger } from '../observability/logger.js';
import {
  ConditionFailedError,
  type JsonRecord,
  type JsonStore,
} from './types.js';

export class S3JsonStore implements JsonStore {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    clientOrConfig?: S3Client | S3ClientConfig,
  ) {
    if (clientOrConfig instanceof S3Client) {
      this.client = clientOrConfig;
    } else {
      this.client = new S3Client(clientOrConfig ?? {});
    }
  }

  async getJson<T>(key: string): Promise<JsonRecord<T> | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const text = await res.Body?.transformToString('utf-8');
      if (!text) return null;
      const value = JSON.parse(text) as T;
      const etag = (res.ETag ?? '').replace(/^"|"$/g, '');
      return { value, etag };
    } catch (err) {
      if (err instanceof NoSuchKey) return null;
      if (err instanceof S3ServiceException && err.name === 'NoSuchKey') return null;
      throw err;
    }
  }

  async putJson<T>(
    key: string,
    value: T,
    opts?: { ifMatch?: string; ifNoneMatch?: string },
  ): Promise<{ etag: string }> {
    try {
      const res = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: JSON.stringify(value, null, 2),
          ContentType: 'application/json',
          ...(opts?.ifMatch ? { IfMatch: opts.ifMatch } : {}),
          ...(opts?.ifNoneMatch ? { IfNoneMatch: opts.ifNoneMatch } : {}),
        }),
      );
      const etag = (res.ETag ?? '').replace(/^"|"$/g, '');
      return { etag };
    } catch (err) {
      if (err instanceof S3ServiceException && err.name === 'PreconditionFailed') {
        throw new ConditionFailedError(`${this.bucket}/${key}`);
      }
      throw err;
    }
  }

  async updateJson<T>(
    key: string,
    initial: () => T,
    mutate: (current: T) => T,
    retries = 3,
  ): Promise<T> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const existing = await this.getJson<T>(key);
      const next = mutate(existing?.value ?? initial());
      try {
        await this.putJson<T>(
          key,
          next,
          existing ? { ifMatch: existing.etag } : { ifNoneMatch: '*' },
        );
        return next;
      } catch (err) {
        if (err instanceof ConditionFailedError && attempt < retries) {
          logger.debug({ key, attempt }, 'conditional write lost race, retrying');
          continue;
        }
        throw err;
      }
    }
    throw new Error(`exhausted retries updating ${key}`);
  }

  async listKeys(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (obj.Key) out.push(obj.Key);
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async deleteJson(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export { ConditionFailedError } from './types.js';
