// Database layer — all access goes through this module
// SQLCipher encryption is MANDATORY — see openDatabase()

export { openDatabase, type NexusDb } from './connection.js';
export { migrateDatabase } from './migrations.js';
