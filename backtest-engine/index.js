#!/usr/bin/env node

/**
 * Slingshot Backtesting Engine
 *
 * Professional backtesting suite for trading strategies
 * Command-line interface for running historical strategy analysis
 */

import { CLI } from './src/cli.js';

async function main() {
  try {
    const cli = new CLI();
    await cli.run(process.argv);
  } catch (error) {
    console.error('❌ Backtesting failed:', error.message);
    if (process.env.NODE_ENV === 'development') {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

main();