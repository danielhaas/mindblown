/**
 * Column-level encryption for secrets at rest (tokens, keys).
 *
 * Uses AES-256-GCM with a random IV per encryption.
 * Key is read from ENCRYPTION_KEY env var (base64-encoded 32 bytes).
 *
 * Ciphertext format: v1:<iv-b64>:<ciphertext-b64>:<authtag-b64>
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM recommended
const TAG_BYTES = 16;

let _key: Buffer | null = null;

function getKey(): Buffer {
  if (_key) return _key;

  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('ENCRYPTION_KEY env var is required for secret encryption');
  }

  _key = Buffer.from(raw, 'base64');
  if (_key.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must be 32 bytes (got ${_key.length}). Generate with: openssl rand -base64 32`);
  }

  return _key;
}

/**
 * Encrypt a plaintext string. Returns a versioned ciphertext string.
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return `v1:${iv.toString('base64')}:${encrypted.toString('base64')}:${authTag.toString('base64')}`;
}

/**
 * Decrypt a versioned ciphertext string back to plaintext.
 */
export function decrypt(ciphertext: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Invalid ciphertext format (expected v1:<iv>:<data>:<tag>)');
  }

  const key = getKey();
  const iv = Buffer.from(parts[1], 'base64');
  const encrypted = Buffer.from(parts[2], 'base64');
  const authTag = Buffer.from(parts[3], 'base64');

  if (iv.length !== IV_BYTES) throw new Error('Invalid IV length');
  if (authTag.length !== TAG_BYTES) throw new Error('Invalid auth tag length');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

/**
 * Check if a string looks like an encrypted value (starts with "v1:").
 * Useful for migrating from plaintext to encrypted storage.
 */
export function isEncrypted(value: string): boolean {
  return value.startsWith('v1:');
}
