import { NexusService, isInitialized } from '@nexus/core';
import { log } from './output.js';

/**
 * Open the NexusService, exiting with a clear message if not initialized.
 */
export function openService(): NexusService {
  if (!isInitialized()) {
    log.error('Nexus is not initialized. Run `nexus init` first.');
    process.exit(1);
  }
  return NexusService.open();
}
