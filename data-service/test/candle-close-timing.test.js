/**
 * Bar-close timing on a forming-bar (TradingView) feed.
 *
 * Regression target: the shadow audit (2026-08-20) found PCC stamping 15:01 ET
 * instead of 15:00 because a forming bar was only sealed when the NEXT bar
 * arrived. Every live strategy fires on a specific bar close, so a full bar of
 * latency is a correctness bug, not a nicety.
 */
import assert from 'node:assert';
import { messageBus } from '../../shared/index.js';
import { CandleManager } from '../src/candle-manager.js';

const published = [];
messageBus.publish = async (ch, payload) => { published.push({ ch, payload }); return true; };

const MIN = 60_000;
const barAt = (iso, close) => ({
  baseSymbol: 'NQ', symbol: 'NQU6', candleTimestamp: iso,
  open: close, high: close, low: close, close, volume: 10,
});
let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); fail++; } };

// ── 1. forming feed: bar is sealed on the wall clock, not on the next bar
{
  published.length = 0;
  const cm = new CandleManager();
  const t0 = new Date('2026-08-20T19:00:00.000Z');            // 15:00 ET decision bar
  await cm.processQuote({ ...barAt(t0.toISOString(), 100) });
  const realNow = Date.now;
  // clock still inside the bar → must NOT seal
  Date.now = () => t0.getTime() + 30_000;
  let n = await cm.sweepFormingCloses();
  check('does not seal a bar while its minute is still running', () => assert.equal(n, 0));
  // clock past the boundary + grace → seals
  Date.now = () => t0.getTime() + MIN + 2_000;
  n = await cm.sweepFormingCloses();
  check('seals the bar ~2s after its close (no full-bar lag)', () => assert.equal(n, 1));
  check('published exactly one candle.close', () => assert.equal(published.length, 1));
  check('sealed bar carries the correct bar-start timestamp', () =>
    assert.equal(published[0].payload.timestamp, t0.toISOString()));
  // sweeping again must not re-publish
  n = await cm.sweepFormingCloses();
  check('sweep is idempotent (no duplicate publish)', () => assert.equal(n, 0) && assert.equal(published.length, 1));
  Date.now = realNow;
}

// ── 2. the next-bar backstop must not double-publish an already-sealed bar
{
  published.length = 0;
  const cm = new CandleManager();
  const t0 = new Date('2026-08-20T19:00:00.000Z');
  const t1 = new Date(t0.getTime() + MIN);
  await cm.processQuote({ ...barAt(t0.toISOString(), 100) });
  const realNow = Date.now;
  Date.now = () => t0.getTime() + MIN + 2_000;
  await cm.sweepFormingCloses();
  const afterSweep = published.length;
  // next bar arrives — old path would seal t0 again
  await cm.processQuote({ ...barAt(t1.toISOString(), 101) });
  check('next-bar arrival does not re-publish the sealed bar', () =>
    assert.equal(published.length, afterSweep));
  Date.now = realNow;
}

// ── 3. completed-bar feed (Schwab) still publishes immediately
{
  published.length = 0;
  const cm = new CandleManager();
  const t0 = new Date('2026-08-20T19:00:00.000Z');
  await cm.processQuote({ ...barAt(t0.toISOString(), 100), barClosed: true });
  check('completed-bar feed publishes on arrival', () => assert.equal(published.length, 1));
}

console.log(`\ncandle-close-timing: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
