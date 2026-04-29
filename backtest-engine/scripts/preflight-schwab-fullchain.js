#!/usr/bin/env node
/**
 * Pre-flight test: measure latency, contract count, and response size when
 * fetching the full Schwab options chain at varying DTE windows. This is
 * the load-test for Option A in the live-backtest parity work — extending
 * Schwab's chain pull from +50 DTE to +730 DTE so live GEX walls converge
 * to the backtest (which integrates LEAPS).
 *
 * Reads tokens from local Redis (same path the production signal-generator uses).
 * Read-only — bypasses the production cache, never mutates server state.
 *
 * Usage:
 *   node scripts/preflight-schwab-fullchain.js [--dte 50,180,365,730] [--symbol QQQ]
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import SchwabClient from '../../signal-generator/src/schwab/schwab-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../shared/.env') });

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { symbol: 'QQQ', dteList: [50, 180, 365, 730] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dte' && args[i + 1]) {
      out.dteList = args[++i].split(',').map(s => parseInt(s.trim()));
    }
    if (args[i] === '--symbol' && args[i + 1]) out.symbol = args[++i];
  }
  return out;
}

function countContracts(chain) {
  let calls = 0, puts = 0;
  for (const exp of Object.values(chain.callExpDateMap || {})) {
    for (const strikes of Object.values(exp)) calls += strikes.length;
  }
  for (const exp of Object.values(chain.putExpDateMap || {})) {
    for (const strikes of Object.values(exp)) puts += strikes.length;
  }
  return { calls, puts, total: calls + puts };
}

async function main() {
  const { symbol, dteList } = parseArgs();

  if (!process.env.SCHWAB_APP_KEY || !process.env.SCHWAB_APP_SECRET) {
    console.error('Missing SCHWAB_APP_KEY/SCHWAB_APP_SECRET in shared/.env');
    process.exit(1);
  }

  console.log(`Symbol: ${symbol}`);
  console.log(`DTE windows: ${dteList.join(', ')}`);
  console.log(`Markets are likely closed — bid/ask may be wider but contracts/OI/expirations are still returned.\n`);

  const results = [];

  for (const dte of dteList) {
    // Fresh client per run to bypass the 90-second cache
    const client = new SchwabClient({
      appKey: process.env.SCHWAB_APP_KEY,
      appSecret: process.env.SCHWAB_APP_SECRET,
      callbackUrl: process.env.SCHWAB_CALLBACK_URL,
      redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
      chainMaxDTE: dte
    });

    // Load tokens (Redis → file fallback)
    await client._loadTokens();

    process.stdout.write(`DTE ${String(dte).padStart(4)}d ... `);
    const t0 = Date.now();
    let chain;
    try {
      chain = await client._getFullChain(symbol);
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      continue;
    }
    const ms = Date.now() - t0;

    const expCount = Object.keys(chain.callExpDateMap || {}).length;
    const counts = countContracts(chain);
    const json = JSON.stringify(chain);
    const sizeMB = (json.length / 1024 / 1024).toFixed(2);

    console.log(`${ms.toString().padStart(6)}ms | ${expCount.toString().padStart(3)} expirations | ${counts.total.toString().padStart(6)} contracts (${counts.calls}C / ${counts.puts}P) | ${sizeMB} MB`);
    results.push({ dte, ms, expCount, ...counts, sizeMB: parseFloat(sizeMB) });

    // Cleanly disconnect Redis
    if (client._redis) await client._redis.quit().catch(() => {});
  }

  console.log(`\n=== Summary ===`);
  console.log(`Production refresh interval is ~3 min. Latency budget: target < 30s.`);
  if (results.length > 0) {
    console.log(`\nLatency progression:`);
    for (const r of results) {
      const verdict = r.ms < 30000 ? '✓ within budget' : r.ms < 60000 ? '⚠ tight' : '✗ over budget';
      console.log(`  +${r.dte}d: ${r.ms}ms (${(r.ms / 1000).toFixed(1)}s)  ${verdict}`);
    }
  }
  process.exit(0);
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
