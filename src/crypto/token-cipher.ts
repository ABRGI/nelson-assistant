import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const ALG = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX = 'enc1:'; // versioned prefix so we can detect encrypted values

/**
 * Encrypts a plaintext string with AES-256-GCM.
 * Each call uses a fresh random IV — same plaintext produces different ciphertext.
 * Output format: "enc1:<base64(iv || tag || ciphertext)>"
 */
export function encryptToken(plaintext: string, keyBase64: string): string {
    const key = Buffer.from(keyBase64, 'base64');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALG, key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob = Buffer.concat([iv, tag, ct]);
    return PREFIX + blob.toString('base64');
}

/**
 * Produces a stable, opaque S3-safe key for a given plaintext id (e.g. Slack user id).
 * Uses HMAC-SHA256 with a separate key so the id cannot be recovered from the filename.
 */
export function hashId(id: string, keyBase64: string): string {
    const key = Buffer.from(keyBase64, 'base64');
    return createHmac('sha256', key).update(id).digest('hex');
}

/**
 * Decrypts a value produced by encryptToken.
 * Throws if the value is not in the expected format or authentication fails.
 */
export function decryptToken(encrypted: string, keyBase64: string): string {
    if (!encrypted.startsWith(PREFIX)) {
        throw new Error('token is not encrypted — missing enc1: prefix');
    }
    const blob = Buffer.from(encrypted.slice(PREFIX.length), 'base64');
    const iv = blob.subarray(0, IV_BYTES);
    const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ct = blob.subarray(IV_BYTES + TAG_BYTES);
    const key = Buffer.from(keyBase64, 'base64');
    const decipher = createDecipheriv(ALG, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ct) + decipher.final('utf8');
}
