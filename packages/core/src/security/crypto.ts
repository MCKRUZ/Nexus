import crypto from 'node:crypto';

/**
 * Generate a cryptographically secure random encryption key for SQLCipher.
 * Store this in the OS keychain (e.g., via keytar) — never in plaintext.
 */
export function generateEncryptionKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Derive a deterministic key from a passphrase + salt using PBKDF2.
 * Use this when the user provides a master password.
 */
export async function deriveKey(passphrase: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(passphrase, salt, 210_000, 32, 'sha256', (err, key) => {
      if (err) reject(err);
      else resolve(key.toString('hex'));
    });
  });
}
