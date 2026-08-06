// Security utilities — use these before writing ANY content to DB or logs

export { filterSecrets } from './secret-filter.js';
export { generateEncryptionKey, deriveKey } from './crypto.js';
export {
  isKeychainAvailable,
  readKeyFromKeychain,
  writeKeyToKeychain,
  deleteKeyFromKeychain,
  resolveEncryptionKey,
  ENCRYPTION_KEY_ENV,
  type KeySource,
  type ResolvedKey,
} from './key-store.js';
