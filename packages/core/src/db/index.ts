// Database layer — all access goes through this module
// Encryption is MANDATORY and verified at open time — see openDatabase()

export {
  openDatabase,
  isPlaintextDatabase,
  EncryptionUnavailableError,
  UnencryptedDatabaseError,
  NEXUS_CIPHER,
  type NexusDb,
} from './connection.js';
export { migrateDatabase } from './migrations.js';
export { encryptDatabase, type EncryptMigrationResult } from './encrypt-migration.js';
