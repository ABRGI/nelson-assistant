import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  type SecretsManagerClientConfig,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type { SecretVault } from './types.js';

export class AwsSecretVault implements SecretVault {
  private readonly client: SecretsManagerClient;

  constructor(clientOrConfig?: SecretsManagerClient | SecretsManagerClientConfig) {
    if (clientOrConfig instanceof SecretsManagerClient) {
      this.client = clientOrConfig;
    } else {
      this.client = new SecretsManagerClient(clientOrConfig ?? {});
    }
  }

  async get(name: string): Promise<string | null> {
    try {
      const res = await this.client.send(new GetSecretValueCommand({ SecretId: name }));
      return res.SecretString ?? null;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return null;
      throw err;
    }
  }

  async put(name: string, value: string): Promise<void> {
    try {
      await this.client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
    } catch (err) {
      if (err instanceof ResourceNotFoundException) {
        await this.client.send(
          new CreateSecretCommand({
            Name: name,
            SecretString: value,
            Description: 'nelson-assistant managed secret',
          }),
        );
        return;
      }
      throw err;
    }
  }

  async remove(name: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true }),
      );
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return;
      throw err;
    }
  }
}
