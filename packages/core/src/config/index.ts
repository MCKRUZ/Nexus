import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateEncryptionKey } from '../security/index.js';

export const NEXUS_DIR = path.join(os.homedir(), '.nexus');
export const CONFIG_FILE = path.join(NEXUS_DIR, 'config.json');
export const DB_FILE = path.join(NEXUS_DIR, 'nexus.db');

export interface NexusConfig {
  version: number;
  encryptionKey: string; // TODO: migrate to OS keychain in a future release
  createdAt: number;
}

export function ensureNexusDir(): void {
  fs.mkdirSync(NEXUS_DIR, { recursive: true });
}

export function isInitialized(): boolean {
  return fs.existsSync(CONFIG_FILE) && fs.existsSync(DB_FILE);
}

export function readConfig(): NexusConfig {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error('Nexus is not initialized. Run `nexus init` first.');
  }
  const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  return JSON.parse(raw) as NexusConfig;
}

export function writeConfig(config: NexusConfig): void {
  ensureNexusDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  // Restrict permissions on the config file (contains encryption key)
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
    // chmod may not be supported on all platforms
  }
}

export function initConfig(): NexusConfig {
  const config: NexusConfig = {
    version: 1,
    encryptionKey: generateEncryptionKey(),
    createdAt: Date.now(),
  };
  writeConfig(config);
  return config;
}
