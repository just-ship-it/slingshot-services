/**
 * Replicate exact CLI flow to debug
 */

import { CLI } from '../../src/cli.js';

const cli = new CLI();

// Simulate the command line arguments
const argv = [
  'node', 'index.js',
  '--ticker', 'NQ',
  '--start', '2025-01-02',
  '--end', '2025-01-05',
  '--strategy', 'lt-failed-breakdown',
  '--timeframe', '1m'
];

async function main() {
  console.log('Simulating CLI...');
  await cli.run(argv);
}

main().catch(console.error);
