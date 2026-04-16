#!/usr/bin/env node
/**
 * Generate a fresh 32-byte master key and print it as base64.
 * Set as SLINGSHOT_MASTER_KEY in your dev env.
 *
 *   node scripts/dev-harness/generate-master-key.js
 */
import { generateMasterKey } from '../../shared/utils/credential-store.js';

const key = generateMasterKey();
console.log(key);
console.error('\nAdd to shared/.env (or export in your shell):');
console.error(`  SLINGSHOT_MASTER_KEY=${key}`);
