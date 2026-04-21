export interface SecretVault {
  /** Returns secret value or null if the secret does not exist. */
  get(name: string): Promise<string | null>;
  /** Creates the secret if missing, otherwise writes a new version. */
  put(name: string, value: string): Promise<void>;
  /** Removes the secret (best-effort — no error if missing). */
  remove(name: string): Promise<void>;
}
