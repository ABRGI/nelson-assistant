export interface JsonRecord<T> {
  value: T;
  etag: string;
}

export class ConditionFailedError extends Error {
  constructor(public readonly key: string) {
    super(`Conditional write failed for ${key}`);
    this.name = 'ConditionFailedError';
  }
}

export interface JsonStore {
  getJson<T>(key: string): Promise<JsonRecord<T> | null>;
  putJson<T>(
    key: string,
    value: T,
    opts?: { ifMatch?: string; ifNoneMatch?: string },
  ): Promise<{ etag: string }>;
  updateJson<T>(
    key: string,
    initial: () => T,
    mutate: (current: T) => T,
    retries?: number,
  ): Promise<T>;
  listKeys(prefix: string): Promise<string[]>;
  deleteJson(key: string): Promise<void>;
}
