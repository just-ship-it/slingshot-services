#!/usr/bin/env node
// Convenience: run the whole pipeline end to end.

import { main as step01 } from './01-build-overlap-tables.js';
import { main as step02 } from './02-classify-outcomes.js';
import { main as step03 } from './03-model-a-portfolio.js';
import { main as step04 } from './04-model-b-simulate.js';
import { main as step05 } from './05-write-summary.js';

step01();
console.log();
step02();
console.log();
step03();
console.log();
step04();
console.log();
step05();
console.log();
console.log('═══════════════════════════════════════════════════════════════════');
console.log('  ✓ Pipeline complete. See research/multi-strategy-rules/output/');
console.log('═══════════════════════════════════════════════════════════════════');
