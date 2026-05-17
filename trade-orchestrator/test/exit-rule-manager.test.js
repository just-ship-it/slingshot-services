/**
 * Smoke test for the exit-rule manager.
 *
 * No test framework — just runs through scenarios and asserts. Run from the
 * trade-orchestrator/ directory:
 *   node test/exit-rule-manager.test.js
 *
 * If all checks pass, exits 0 with a single line of output. Any failure
 * prints the failing scenario and exits 1.
 */

import { createExitRuleManager, captureRuleFromSignal } from '../src/exit-rule-manager.js';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

// The manager publishes via Promise.resolve().then(...) to keep the price
// tick loop fast (fire-and-forget HTTP). Tests need to flush the microtask
// queue before checking calls.length.
function flush() { return new Promise(r => setImmediate(r)); }

function makeMgr() {
  const modifyStopCalls = [];
  const closePositionCalls = [];
  const mgr = createExitRuleManager({
    logger: noopLogger,
    extractUnderlying: (sym) => {
      if (sym === 'MNQM6' || sym === 'NQM6') return 'NQ';
      if (sym === 'MESM6' || sym === 'ESM6') return 'ES';
      return null;
    },
    publishModifyStop: async (payload) => modifyStopCalls.push(payload),
    publishClosePosition: async (payload) => closePositionCalls.push(payload),
  });
  return { mgr, modifyStopCalls, closePositionCalls };
}

// --- Scenario 1: BE rule capture ---
{
  const rules = captureRuleFromSignal({
    breakeven_stop: true,
    breakeven_trigger: 70,
    breakeven_offset: 5,
  });
  assert(Array.isArray(rules), 'returns array');
  assert(rules.length === 1, `expected 1 rule, got ${rules.length}`);
  assert(rules[0].type === 'breakeven', `BE rule type=${rules[0].type}`);
  assert(rules[0].trigger === 70, 'BE trigger=70');
  assert(rules[0].offset === 5, 'BE offset=5');
}

// --- Scenario 2: empty array when no rules ---
{
  const rules = captureRuleFromSignal({ side: 'long' });
  assert(Array.isArray(rules) && rules.length === 0, 'no rules → empty array');
}

// --- Scenario 3: ratchet rule capture ---
{
  const rules = captureRuleFromSignal({
    mfeRatchet: true,
    mfeRatchetConfig: {
      tiers: [{ minMFE: 70, lockPct: 0.4 }, { minMFE: 100, lockPct: 0.6 }],
      fixedPerTier: false,
    },
  });
  assert(rules.length === 1, 'ratchet captured');
  assert(rules[0].type === 'mfeRatchet', `rule type=${rules[0].type}`);
  assert(rules[0].tiers.length === 2, `tiers.length=${rules[0].tiers.length}`);
  assert(rules[0].tiers[0].minMFE === 100, 'tiers sorted highest first');
}

// --- Scenario 4: fibRetrace rule capture ---
{
  const rules = captureRuleFromSignal({
    fibRetrace: true,
    fibRetraceConfig: { retracePct: 0.618, activationMFE: 40 },
  });
  assert(rules.length === 1, 'fib captured');
  assert(rules[0].type === 'fibRetrace', `rule type=${rules[0].type}`);
  assert(rules[0].retracePct === 0.618, `retracePct=${rules[0].retracePct}`);
  assert(rules[0].activationMFE === 40, `activationMFE=${rules[0].activationMFE}`);
}

// --- Scenario 5: composite BE + fib rules (the live two-layer config) ---
{
  const rules = captureRuleFromSignal({
    breakeven_stop: true,
    breakeven_trigger: 80,
    breakeven_offset: 10,
    fibRetrace: true,
    fibRetraceConfig: { retracePct: 0.618, activationMFE: 40 },
  });
  assert(rules.length === 2, `expected 2 rules, got ${rules.length}`);
  const types = rules.map(r => r.type).sort();
  assert(types[0] === 'breakeven' && types[1] === 'fibRetrace', `composite types=${types.join(',')}`);
}

// --- Scenario 6: invalid fib config rejected ---
{
  // retracePct must be 0 < r < 1
  let rules = captureRuleFromSignal({ fibRetrace: true, fibRetraceConfig: { retracePct: 1.5, activationMFE: 40 } });
  assert(rules.length === 0, 'invalid retracePct rejected');
  rules = captureRuleFromSignal({ fibRetrace: true, fibRetraceConfig: { retracePct: 0.618 } });
  assert(rules.length === 0, 'missing activationMFE rejected');
  rules = captureRuleFromSignal({ fibRetrace: true, fibRetraceConfig: { retracePct: 0.618, activationMFE: 0 } });
  assert(rules.length === 0, 'zero activationMFE rejected');
}

async function run() {
  // --- Scenario 7: SHORT BE — MFE crosses trigger, modify-stop fires once ---
  {
    const { mgr, modifyStopCalls } = makeMgr();
    mgr.register({
      accountId: 'acct1', strategy: 'GEX_FLIP_IVPCT', symbol: 'MNQM6',
      side: 'short', entryPrice: 29733, signalId: 'sig-1',
      originalStop: 29793,
      rules: [{ type: 'breakeven', trigger: 70, offset: 5 }],
    });
    assert(mgr.size() === 1, 'one position tracked');

    mgr.onPriceTick({ baseSymbol: 'NQ', high: 29733, low: 29703, close: 29710 });
    await flush();
    assert(modifyStopCalls.length === 0, 'no fire below trigger');

    mgr.onPriceTick({ baseSymbol: 'NQ', high: 29733, low: 29664, close: 29680 });
    await flush();
    assert(modifyStopCalls.length === 0, 'no fire just below trigger');

    mgr.onPriceTick({ baseSymbol: 'NQ', high: 29733, low: 29663, close: 29680 });
    await flush();
    assert(modifyStopCalls.length === 1, `expected 1 fire, got ${modifyStopCalls.length}`);
    const call = modifyStopCalls[0];
    assert(call.newStopPrice === 29728, `short BE+5 newStop expected 29728, got ${call.newStopPrice}`);
    assert(call.mfe === 70, `mfe=70, got ${call.mfe}`);

    mgr.onPriceTick({ baseSymbol: 'NQ', high: 29733, low: 29595, close: 29600 });
    await flush();
    assert(modifyStopCalls.length === 1, 'no re-fire after BE triggered');
  }

  // --- Scenario 8: LONG BE — symmetric ---
  {
    const { mgr, modifyStopCalls } = makeMgr();
    mgr.register({
      accountId: 'acct1', strategy: 'GEX_FLIP_IVPCT', symbol: 'MNQM6',
      side: 'long', entryPrice: 29000, signalId: 'sig-2',
      originalStop: 28940,
      rules: [{ type: 'breakeven', trigger: 70, offset: 5 }],
    });
    mgr.onPriceTick({ baseSymbol: 'NQ', high: 29080, low: 29000, close: 29050 });
    await flush();
    assert(modifyStopCalls.length === 1, `LONG fire expected, got ${modifyStopCalls.length}`);
    assert(modifyStopCalls[0].newStopPrice === 29005, `long BE+5 newStop expected 29005, got ${modifyStopCalls[0].newStopPrice}`);
  }

  // --- Scenario 9: unregister stops tracking ---
  {
    const { mgr, modifyStopCalls } = makeMgr();
    mgr.register({
      accountId: 'acct1', strategy: 'GEX_FLIP_IVPCT', symbol: 'MNQM6',
      side: 'short', entryPrice: 29733, signalId: 'sig-3',
      rules: [{ type: 'breakeven', trigger: 70, offset: 5 }],
    });
    mgr.unregister({ accountId: 'acct1', strategy: 'GEX_FLIP_IVPCT', symbol: 'MNQM6' });
    assert(mgr.size() === 0, 'unregister cleared state');
    mgr.onPriceTick({ baseSymbol: 'NQ', high: 29733, low: 29500, close: 29550 });
    await flush();
    assert(modifyStopCalls.length === 0, 'no fire after unregister');
  }

  // --- Scenario 10: no rule → no tracking (passive mode) ---
  {
    const { mgr, modifyStopCalls } = makeMgr();
    mgr.register({
      accountId: 'acct1', strategy: 'GEX_FLIP_IVPCT', symbol: 'MNQM6',
      side: 'short', entryPrice: 29733, signalId: 'sig-4',
      rules: [],
    });
    assert(mgr.size() === 0, 'no rules → not registered');
    mgr.onPriceTick({ baseSymbol: 'NQ', high: 29733, low: 29500, close: 29550 });
    await flush();
    assert(modifyStopCalls.length === 0, 'no rules → no fire');
  }

  // --- Scenario 11: multiple positions, only matching underlying ticks ---
  {
    const { mgr, modifyStopCalls } = makeMgr();
    mgr.register({
      accountId: 'acct1', strategy: 'A', symbol: 'MNQM6',
      side: 'short', entryPrice: 29733, signalId: 'sig-A',
      rules: [{ type: 'breakeven', trigger: 70, offset: 5 }],
    });
    mgr.register({
      accountId: 'acct2', strategy: 'B', symbol: 'MESM6',
      side: 'long', entryPrice: 5800, signalId: 'sig-B',
      rules: [{ type: 'breakeven', trigger: 10, offset: 1 }],
    });
    mgr.onPriceTick({ baseSymbol: 'NQ', high: 29733, low: 29660, close: 29670 });
    await flush();
    assert(modifyStopCalls.length === 1, `expected one fire from NQ tick, got ${modifyStopCalls.length}`);
    assert(modifyStopCalls[0].signalId === 'sig-A', 'NQ tick fired the NQ position');

    mgr.onPriceTick({ baseSymbol: 'ES', high: 5815, low: 5800, close: 5810 });
    await flush();
    assert(modifyStopCalls.length === 2, `expected two fires total, got ${modifyStopCalls.length}`);
    assert(modifyStopCalls[1].signalId === 'sig-B', 'ES tick fired the ES position');
  }

  // --- Scenario 12: extractUnderlying nil → skip registration ---
  {
    const calls = [];
    const mgr = createExitRuleManager({
      logger: noopLogger,
      extractUnderlying: () => null,
      publishModifyStop: async (p) => calls.push(p),
      publishClosePosition: async () => {},
    });
    mgr.register({
      accountId: 'a', strategy: 's', symbol: 'WEIRD',
      side: 'long', entryPrice: 100, signalId: 'x',
      rules: [{ type: 'breakeven', trigger: 5, offset: 1 }],
    });
    assert(mgr.size() === 0, 'no underlying → not registered');
  }

  // --- Scenario 13: fibRetrace activation gate ---
  {
    const { mgr, closePositionCalls } = makeMgr();
    mgr.register({
      accountId: 'a1', strategy: 'GEX_FLIP_IVPCT', symbol: 'MNQM6',
      side: 'short', entryPrice: 29665.5, signalId: 'sig-fib',
      originalStop: 29725.5,
      rules: [{ type: 'fibRetrace', retracePct: 0.618, activationMFE: 40 }],
    });

    // Bar 1: MFE only +20, below activation → no fire even on bad close
    mgr.onCandleClose({ product: 'NQ', high: 29665.5, low: 29645, close: 29660 });
    await flush();
    assert(closePositionCalls.length === 0, 'fib dormant below activation');

    // Bar 2: MFE +138, activation hit but close is at extreme (no retrace yet)
    mgr.onCandleClose({ product: 'NQ', high: 29665.5, low: 29527.5, close: 29528 });
    await flush();
    assert(closePositionCalls.length === 0, 'fib activated but no retrace yet');

    // Bar 3: price retraces. MFE still 138 (highWater unchanged), but close
    // is at 29615 which is ABOVE fibLevel = 29665.5 - 138 * 0.382 = 29612.78
    mgr.onCandleClose({ product: 'NQ', high: 29620, low: 29560, close: 29615 });
    await flush();
    assert(closePositionCalls.length === 1, `fib fire expected on close > fibLevel, got ${closePositionCalls.length}`);
    const call = closePositionCalls[0];
    assert(call.exitPrice === 29615, `exitPrice=${call.exitPrice}`);
    assert(call.side === 'short', `side=${call.side}`);
    assert(call.signalId === 'sig-fib', 'signalId carries through');

    // Bar 4: more retracement, but already closed
    mgr.onCandleClose({ product: 'NQ', high: 29650, low: 29615, close: 29640 });
    await flush();
    assert(closePositionCalls.length === 1, 'no re-fire after fib closed');
  }

  // --- Scenario 14: fibRetrace bar-close confirmation (wick must NOT trigger) ---
  {
    const { mgr, closePositionCalls } = makeMgr();
    mgr.register({
      accountId: 'a1', strategy: 'GEX_FLIP_IVPCT', symbol: 'MNQM6',
      side: 'short', entryPrice: 29665.5, signalId: 'sig-fib2',
      originalStop: 29725.5,
      rules: [{ type: 'fibRetrace', retracePct: 0.618, activationMFE: 40 }],
    });

    // Build MFE
    mgr.onCandleClose({ product: 'NQ', high: 29665.5, low: 29527.5, close: 29530 });
    await flush();
    // Wick up to 29620 but bar CLOSES at 29570 (still below fibLevel 29612.78)
    mgr.onCandleClose({ product: 'NQ', high: 29620, low: 29560, close: 29570 });
    await flush();
    assert(closePositionCalls.length === 0, 'wick above fibLevel must not trigger');

    // Now a bar that CLOSES past fibLevel
    mgr.onCandleClose({ product: 'NQ', high: 29650, low: 29570, close: 29618 });
    await flush();
    assert(closePositionCalls.length === 1, `fire expected on bar close past fibLevel, got ${closePositionCalls.length}`);
  }

  // --- Scenario 15: LONG fibRetrace symmetric ---
  {
    const { mgr, closePositionCalls } = makeMgr();
    mgr.register({
      accountId: 'a1', strategy: 'GEX_FLIP_IVPCT', symbol: 'MNQM6',
      side: 'long', entryPrice: 29000, signalId: 'sig-fib-long',
      originalStop: 28940,
      rules: [{ type: 'fibRetrace', retracePct: 0.618, activationMFE: 40 }],
    });

    // MFE +100. fibLevel = 29000 + 100*0.382 = 29038.2
    mgr.onCandleClose({ product: 'NQ', high: 29100, low: 29000, close: 29100 });
    await flush();
    assert(closePositionCalls.length === 0, 'long: no retrace yet');

    // Retrace, close at 29030 (below fibLevel 29038.2)
    mgr.onCandleClose({ product: 'NQ', high: 29080, low: 29020, close: 29030 });
    await flush();
    assert(closePositionCalls.length === 1, 'long fib fire on close below fibLevel');
    assert(closePositionCalls[0].side === 'long', 'side=long');
  }

  // --- Scenario 16: composite BE + fib — whichever fires first wins ---
  {
    const { mgr, modifyStopCalls, closePositionCalls } = makeMgr();
    mgr.register({
      accountId: 'a1', strategy: 'GEX_FLIP_IVPCT', symbol: 'MNQM6',
      side: 'short', entryPrice: 29665.5, signalId: 'sig-twolayer',
      originalStop: 29725.5,
      rules: [
        { type: 'breakeven', trigger: 80, offset: 10 },
        { type: 'fibRetrace', retracePct: 0.618, activationMFE: 40 },
      ],
    });

    // Tick: MFE hits 80 (price 29585.5) → BE fires modifyStop
    mgr.onPriceTick({ baseSymbol: 'NQ', high: 29665.5, low: 29585.5, close: 29600 });
    await flush();
    assert(modifyStopCalls.length === 1, `BE should fire at MFE=80, got ${modifyStopCalls.length}`);
    assert(modifyStopCalls[0].newStopPrice === 29655.5, `short BE+10 = entry-10 = 29655.5, got ${modifyStopCalls[0].newStopPrice}`);

    // MFE continues to +138
    mgr.onCandleClose({ product: 'NQ', high: 29610, low: 29527.5, close: 29530 });
    await flush();
    // No fib fire yet (close at extreme)
    assert(closePositionCalls.length === 0, 'no fib fire at extreme');

    // Bar closes above fibLevel → fib fires closePosition
    mgr.onCandleClose({ product: 'NQ', high: 29620, low: 29560, close: 29615 });
    await flush();
    assert(closePositionCalls.length === 1, `fib should fire on retrace close, got ${closePositionCalls.length}`);

    // After fib fires, position is "closed" — further bars don't re-trigger
    mgr.onCandleClose({ product: 'NQ', high: 29650, low: 29615, close: 29640 });
    mgr.onPriceTick({ baseSymbol: 'NQ', high: 29650, low: 29615, close: 29640 });
    await flush();
    assert(closePositionCalls.length === 1, 'no re-fire after closed');
    assert(modifyStopCalls.length === 1, 'no extra BE re-fire');
  }

  // --- Scenario 17: ratchet single tier ---
  {
    const { mgr, modifyStopCalls } = makeMgr();
    mgr.register({
      accountId: 'a1', strategy: 'GEX_FLIP_IVPCT', symbol: 'MNQM6',
      side: 'short', entryPrice: 29665.5, signalId: 'sig-ratchet',
      originalStop: 29725.5,
      rules: [{
        type: 'mfeRatchet',
        tiers: [{ minMFE: 70, lockPct: 0.4 }],
        fixedPerTier: false,
      }],
    });
    // MFE +70 → lock 40% = 28 pts. newStop = 29665.5 - 28 = 29637.5
    mgr.onPriceTick({ baseSymbol: 'NQ', high: 29665.5, low: 29595.5, close: 29600 });
    await flush();
    assert(modifyStopCalls.length === 1, `ratchet fire at MFE=70, got ${modifyStopCalls.length}`);
    assert(modifyStopCalls[0].newStopPrice === 29637.5, `lockPct=0.4 of MFE=70 → entry-28 = 29637.5, got ${modifyStopCalls[0].newStopPrice}`);
  }

  // --- Scenario 18: ratchet multi-tier — upgrades on higher MFE ---
  {
    const { mgr, modifyStopCalls } = makeMgr();
    mgr.register({
      accountId: 'a1', strategy: 'GEX_FLIP_IVPCT', symbol: 'MNQM6',
      side: 'short', entryPrice: 29665.5, signalId: 'sig-ratchet2',
      originalStop: 29725.5,
      rules: [{
        type: 'mfeRatchet',
        tiers: [
          { minMFE: 100, lockPct: 0.6 },
          { minMFE: 70, lockPct: 0.4 },
        ],
        fixedPerTier: false,
      }],
    });
    // MFE +70 → tier1 (70/0.4)
    mgr.onPriceTick({ baseSymbol: 'NQ', high: 29665.5, low: 29595.5, close: 29600 });
    await flush();
    assert(modifyStopCalls.length === 1, `tier1 fire, got ${modifyStopCalls.length}`);
    assert(modifyStopCalls[0].newStopPrice === 29637.5, `tier1 stop`);

    // Another tick at same MFE → no upgrade
    mgr.onPriceTick({ baseSymbol: 'NQ', high: 29665.5, low: 29595.5, close: 29600 });
    await flush();
    assert(modifyStopCalls.length === 1, 'no re-fire same tier');

    // MFE jumps to +100 → tier0 (100/0.6) → lock 60 pts → 29605.5
    mgr.onPriceTick({ baseSymbol: 'NQ', high: 29665.5, low: 29565.5, close: 29570 });
    await flush();
    assert(modifyStopCalls.length === 2, `tier0 upgrade, got ${modifyStopCalls.length}`);
    assert(modifyStopCalls[1].newStopPrice === 29605.5, `tier0 stop=29605.5, got ${modifyStopCalls[1].newStopPrice}`);

    // No tier3 — further MFE doesn't add more fires
    mgr.onPriceTick({ baseSymbol: 'NQ', high: 29665.5, low: 29500, close: 29510 });
    await flush();
    assert(modifyStopCalls.length === 2, 'no further upgrades');
  }

  // --- Scenario 19: fib + back-compat single `rule` parameter ---
  {
    const { mgr, closePositionCalls } = makeMgr();
    // Older callers passed `rule` (singular). Verify back-compat.
    mgr.register({
      accountId: 'a1', strategy: 'X', symbol: 'MNQM6',
      side: 'short', entryPrice: 29665.5, signalId: 'sig-compat',
      rule: { type: 'fibRetrace', retracePct: 0.618, activationMFE: 40 },
    });
    mgr.onCandleClose({ product: 'NQ', high: 29665.5, low: 29527.5, close: 29530 });
    mgr.onCandleClose({ product: 'NQ', high: 29620, low: 29560, close: 29615 });
    await flush();
    assert(closePositionCalls.length === 1, 'back-compat single-rule call works');
  }

  console.log('exit-rule-manager: all 19 scenarios pass');
}

run().catch(err => { console.error('test error:', err); process.exit(1); });
