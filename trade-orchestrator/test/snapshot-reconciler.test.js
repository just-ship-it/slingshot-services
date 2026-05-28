/**
 * Smoke test for snapshot-reconciler.
 *
 * No framework — runs through scenarios and asserts. Run from trade-orchestrator/:
 *   node test/snapshot-reconciler.test.js
 *
 * Exit 0 with a single line on success; exit 1 with failing scenario name on failure.
 *
 * Scenarios cover the UNATTRIBUTED regression: every test asserts the
 * properties whose loss caused the prod bug (strategy attribution,
 * timeoutCandles, requestedAt, exitRules).
 */

import {
  reconcileOrdersSnapshot,
  reconcilePositionSnapshot,
  MISSING_OBSERVATIONS_BEFORE_DROP,
} from '../src/snapshot-reconciler.js';

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
}

const pendingKey = (acct, strat, sym) => `${acct}|${strat}|${sym}`;
const posKey     = (acct, strat, sym) => `${acct}|${strat}|${sym}`;

// ── Scenario 1: place → snapshot preserves attribution ─────────────────────
(function placeThenSnapshotPreserves() {
  const pendingOrders = new Map();
  const openPositions = new Map();
  const ACCT = 'tradovate-abc';
  const SIGNAL_ID = 'GEX_LT_3M_CROSSOVER-short-29681.25-1779466562694';

  // The orchestrator's handleTradeSignal records this from the strategy's signal.
  pendingOrders.set(pendingKey(ACCT, 'GEX_LT_3M_CROSSOVER', 'MNQM6'), {
    accountId: ACCT,
    strategy: 'GEX_LT_3M_CROSSOVER',
    symbol: 'MNQM6',
    direction: 'short',
    signalId: SIGNAL_ID,
    action: 'place_limit',
    requestedAt: 1779466562695,                // signal time
    timeoutCandles: 5,                         // ← the field that was getting lost
    maxHoldBars: 120,
    exitRules: [{ type: 'breakeven', triggerMFE: 70, offset: 10 }],
    cancelOnPreFillExtreme: false,
  });

  // Tradovate snapshot 30s later: entry order working, bracket children too.
  // With the connector's OSO field-name fix, the connector now classifies
  // role correctly. The orchestrator filters role=stop/target before this
  // reconciler sees the orders, but defense-in-depth: the reconciler also
  // accepts only entries it can match or marks others as orphans.
  const brokerOrders = [
    { orderId: 15541567510, role: 'entry', strategy: 'GEX_LT_3M_CROSSOVER', signalId: SIGNAL_ID, symbol: 'MNQM6', action: 'Sell', orderType: 'Limit', price: 29681.25 },
    { orderId: 15541567511, role: 'stop',   strategy: null, signalId: null, symbol: 'MNQM6', action: 'Buy',  orderType: 'Stop' },
    { orderId: 15541567512, role: 'target', strategy: null, signalId: null, symbol: 'MNQM6', action: 'Buy',  orderType: 'Limit' },
  ];

  const result = reconcileOrdersSnapshot(pendingOrders, ACCT, brokerOrders, openPositions, pendingKey);

  assert(result.preserved === 1, `expected 1 preserved, got ${result.preserved}`);
  assert(result.orphaned === 0,  `expected 0 orphaned, got ${result.orphaned}`);
  assert(result.dropped === 0,   `expected 0 dropped, got ${result.dropped}`);

  const entry = pendingOrders.get(pendingKey(ACCT, 'GEX_LT_3M_CROSSOVER', 'MNQM6'));
  assert(entry, 'pending entry should still exist under GEX_LT_3M_CROSSOVER key');
  assert(entry.strategy === 'GEX_LT_3M_CROSSOVER', `strategy must be preserved, got ${entry.strategy}`);
  assert(entry.timeoutCandles === 5, `timeoutCandles must be preserved, got ${entry.timeoutCandles}`);
  assert(entry.maxHoldBars === 120, `maxHoldBars must be preserved`);
  assert(entry.exitRules?.length === 1, `exitRules must be preserved`);
  assert(entry.requestedAt === 1779466562695, `requestedAt must NOT be reset (checkStaleLimits depends on it)`);
  assert(entry.orderId === 15541567510, `orderId should be updated from broker (was undefined locally)`);
  assert(entry.signalId === SIGNAL_ID, `signalId preserved`);

  // The UNATTRIBUTED keys must not exist.
  assert(!pendingOrders.has(pendingKey(ACCT, 'UNATTRIBUTED', 'MNQM6')),
         'no UNATTRIBUTED pending entry should be created when entry was matched');

  console.log('  ✓ place → snapshot preserves strategy/timeout/requestedAt');
})();

// ── Scenario 2: snapshot doesn't reset requestedAt across multiple polls ───
(function multipleSnapshotsKeepRequestedAt() {
  const pendingOrders = new Map();
  const openPositions = new Map();
  const ACCT = 'tradovate-abc';

  pendingOrders.set(pendingKey(ACCT, 'GEX_LT_3M_CROSSOVER', 'MNQM6'), {
    accountId: ACCT, strategy: 'GEX_LT_3M_CROSSOVER', symbol: 'MNQM6',
    direction: 'short', signalId: 'sig1', orderId: null,
    requestedAt: 1779466562695, timeoutCandles: 5, maxHoldBars: 120,
  });

  const broker = [{ orderId: 1, role: 'entry', strategy: 'GEX_LT_3M_CROSSOVER', signalId: 'sig1', symbol: 'MNQM6', action: 'Sell' }];

  reconcileOrdersSnapshot(pendingOrders, ACCT, broker, openPositions, pendingKey);
  reconcileOrdersSnapshot(pendingOrders, ACCT, broker, openPositions, pendingKey);
  reconcileOrdersSnapshot(pendingOrders, ACCT, broker, openPositions, pendingKey);

  const entry = pendingOrders.get(pendingKey(ACCT, 'GEX_LT_3M_CROSSOVER', 'MNQM6'));
  assert(entry.requestedAt === 1779466562695, 'requestedAt must survive repeated snapshots');
  assert(entry.missingFromBroker === 0, 'missingFromBroker should reset whenever broker confirms');
  console.log('  ✓ requestedAt survives repeated reconciliations');
})();

// ── Scenario 3: genuinely orphan broker order becomes UNATTRIBUTED ─────────
(function orphanBrokerOrderUnattributed() {
  const pendingOrders = new Map();
  const openPositions = new Map();
  const ACCT = 'tradovate-abc';

  // No local pending state. Broker shows an order we don't know about
  // (e.g. placed by another instance, manual order, or post-restart with
  // lost mapping). Reconciler should attribute it to UNATTRIBUTED.
  const broker = [{ orderId: 999, role: 'entry', strategy: null, signalId: null, symbol: 'MNQM6', action: 'Sell' }];
  const result = reconcileOrdersSnapshot(pendingOrders, ACCT, broker, openPositions, pendingKey);
  assert(result.orphaned === 1, 'orphan order should be counted');
  assert(pendingOrders.has(pendingKey(ACCT, 'UNATTRIBUTED', 'MNQM6')), 'UNATTRIBUTED entry should be created');
  const orphan = pendingOrders.get(pendingKey(ACCT, 'UNATTRIBUTED', 'MNQM6'));
  assert(orphan.timeoutCandles == null, 'orphan should NOT have an invented timeout');
  console.log('  ✓ truly orphan broker order → UNATTRIBUTED');
})();

// ── Scenario 4: entry missing for 1 snapshot is NOT immediately dropped ────
(function noImmediateDropOnTransientMiss() {
  const pendingOrders = new Map();
  const openPositions = new Map();
  const ACCT = 'tradovate-abc';
  const KEY = pendingKey(ACCT, 'GEX_LT_3M_CROSSOVER', 'MNQM6');

  pendingOrders.set(KEY, {
    accountId: ACCT, strategy: 'GEX_LT_3M_CROSSOVER', symbol: 'MNQM6',
    direction: 'short', signalId: 'sig1', requestedAt: 1779466562695,
    timeoutCandles: 5,
  });

  // Snapshot arrives with no orders for this account (race: broker hadn't
  // received our placement yet). Reconciler should NOT delete on first miss.
  for (let i = 0; i < MISSING_OBSERVATIONS_BEFORE_DROP - 1; i++) {
    reconcileOrdersSnapshot(pendingOrders, ACCT, [], openPositions, pendingKey);
    assert(pendingOrders.has(KEY), `entry must survive miss #${i + 1}`);
  }
  // After the Nth miss, it should drop.
  const result = reconcileOrdersSnapshot(pendingOrders, ACCT, [], openPositions, pendingKey);
  assert(!pendingOrders.has(KEY), `entry must drop after ${MISSING_OBSERVATIONS_BEFORE_DROP} consecutive misses`);
  assert(result.dropped === 1, 'dropped counter must increment');
  console.log(`  ✓ transient miss tolerated up to ${MISSING_OBSERVATIONS_BEFORE_DROP - 1}; drops on ${MISSING_OBSERVATIONS_BEFORE_DROP}`);
})();

// ── Scenario 5: bracket children skipped when position exists ──────────────
(function skipBracketChildrenWhenPositionOpen() {
  const pendingOrders = new Map();
  const openPositions = new Map();
  const ACCT = 'tradovate-abc';

  // Position already open from a prior fill.
  openPositions.set(posKey(ACCT, 'GEX_LT_3M_CROSSOVER', 'MNQM6'), {
    accountId: ACCT, strategy: 'GEX_LT_3M_CROSSOVER', symbol: 'MNQM6',
    side: 'short', netPos: -1, entryPrice: 29681.25, signalId: 'sig1',
  });

  // Broker snapshot: stop + target are working (bracket children of the open position).
  // No entry order. These must NOT become pending entries.
  const broker = [
    { orderId: 511, role: 'stop',   strategy: null, signalId: null, symbol: 'MNQM6', action: 'Buy' },
    { orderId: 512, role: 'target', strategy: null, signalId: null, symbol: 'MNQM6', action: 'Buy' },
  ];
  const result = reconcileOrdersSnapshot(pendingOrders, ACCT, broker, openPositions, pendingKey);
  assert(result.orphaned === 0, 'bracket children of open position must not orphan');
  assert(pendingOrders.size === 0, 'pendingOrders must stay empty');
  console.log('  ✓ bracket children of open position are skipped');
})();

// ── Scenario 6: position snapshot preserves strategy + exitRules ───────────
(function positionSnapshotPreserves() {
  const openPositions = new Map();
  const ACCT = 'tradovate-abc';

  openPositions.set(posKey(ACCT, 'GEX_FLIP_IVPCT', 'MNQM6'), {
    accountId: ACCT, strategy: 'GEX_FLIP_IVPCT', symbol: 'MNQM6',
    side: 'long', netPos: 1, entryPrice: 29500, signalId: 'sigX',
    openedAt: '2026-05-22T16:00:00Z', maxHoldBars: 600,
    exitRules: [{ type: 'breakeven', triggerMFE: 80, offset: 10 }, { type: 'fibRetrace', pct: 0.618, activationMFE: 40 }],
    originalStop: 29440,
  });

  const broker = [{ symbol: 'MNQM6', netPos: 1, entryPrice: 29500, strategy: null }];
  const result = reconcilePositionSnapshot(openPositions, ACCT, broker, posKey);
  assert(result.preserved === 1, 'position should be preserved');
  const pos = openPositions.get(posKey(ACCT, 'GEX_FLIP_IVPCT', 'MNQM6'));
  assert(pos, 'position must still be keyed by GEX_FLIP_IVPCT');
  assert(pos.strategy === 'GEX_FLIP_IVPCT', 'strategy preserved');
  assert(pos.exitRules?.length === 2, 'exitRules preserved');
  assert(pos.maxHoldBars === 600, 'maxHoldBars preserved');
  assert(pos.openedAt === '2026-05-22T16:00:00Z', 'openedAt preserved');
  assert(pos.signalId === 'sigX', 'signalId preserved');
  assert(!openPositions.has(posKey(ACCT, 'UNATTRIBUTED', 'MNQM6')), 'no UNATTRIBUTED dup');
  console.log('  ✓ position snapshot preserves strategy/exitRules/maxHoldBars');
})();

// ── Scenario 7: match by orderId when strategy/signalId both missing ───────
(function matchByOrderIdAlone() {
  const pendingOrders = new Map();
  const openPositions = new Map();
  const ACCT = 'tradovate-abc';

  pendingOrders.set(pendingKey(ACCT, 'GEX_LT_3M_CROSSOVER', 'MNQM6'), {
    accountId: ACCT, strategy: 'GEX_LT_3M_CROSSOVER', symbol: 'MNQM6',
    direction: 'short', signalId: 'sig1', orderId: 15541567510,
    requestedAt: 1779466562695, timeoutCandles: 5,
  });

  // Broker snapshot lost the strategy/signalId mapping (connector restart)
  // but the brokerOrderId is the same.
  const broker = [{ orderId: 15541567510, role: 'entry', strategy: null, signalId: null, symbol: 'MNQM6', action: 'Sell' }];
  const result = reconcileOrdersSnapshot(pendingOrders, ACCT, broker, openPositions, pendingKey);
  assert(result.preserved === 1, 'must match by orderId alone');
  assert(result.orphaned === 0, 'must NOT create a duplicate UNATTRIBUTED entry');
  const entry = pendingOrders.get(pendingKey(ACCT, 'GEX_LT_3M_CROSSOVER', 'MNQM6'));
  assert(entry.timeoutCandles === 5, 'timeoutCandles preserved via orderId match');
  console.log('  ✓ orderId match works even when strategy/signalId stripped');
})();

// ── Scenario 8: orphan adoption recovers maxHold/exitRules via signalId ────
// Regression test for the 2026-05-28 incident: WS executionReport dropped the
// fill, the 5-min reconciler adopted the broker position as an orphan, but
// adopted entries had maxHoldBars=null so checkMaxHold silently skipped them.
(function orphanAdoptionResolvesBySignalId() {
  const openPositions = new Map();
  const ACCT = 'tradovate-abc';
  const SIGNAL_ID = 'GEX_LT_3M_CROSSOVER-short-30284-1779985142202';

  // Broker reports an attributed position the orchestrator never registered
  // locally (POSITION_OPENED was dropped). signalId comes through via the
  // connector's clOrdId text recovery.
  const broker = [{
    symbol: 'MNQM6', netPos: -1, entryPrice: 30299.5,
    strategy: 'GEX_LT_3M_CROSSOVER', signalId: SIGNAL_ID,
  }];

  const registry = new Map([[SIGNAL_ID, {
    strategy: 'GEX_LT_3M_CROSSOVER',
    maxHoldBars: 120,
    exitRules: [{ type: 'breakeven', triggerMFE: 80, offset: 20 }],
    originalStop: 30354,
  }]]);

  const resolveDefaults = ({ signalId }) => {
    const entry = registry.get(signalId);
    return entry ? { ...entry, source: 'signalId' } : null;
  };

  const result = reconcilePositionSnapshot(
    openPositions, ACCT, broker, posKey, { resolveDefaults }
  );

  assert(result.orphaned === 1, 'orphan must be counted');
  assert(Array.isArray(result.adopted) && result.adopted.length === 1, 'adopted list returned');

  const pos = openPositions.get(posKey(ACCT, 'GEX_LT_3M_CROSSOVER', 'MNQM6'));
  assert(pos, 'orphan adopted under GEX_LT_3M_CROSSOVER key');
  assert(pos.maxHoldBars === 120, `maxHoldBars must be recovered, got ${pos.maxHoldBars}`);
  assert(pos.exitRules?.length === 1, 'exitRules recovered');
  assert(pos.exitRules[0].type === 'breakeven', 'exit rule details preserved');
  assert(pos.originalStop === 30354, 'originalStop recovered');
  assert(pos.signalId === SIGNAL_ID, 'signalId carried through');
  assert(pos.defaultsSource === 'signalId', 'defaultsSource tagged for observability');
  console.log('  ✓ orphan adoption recovers protection metadata via signalId');
})();

// ── Scenario 9: orphan adoption falls back to per-strategy defaults ────────
(function orphanAdoptionFallsBackToStrategy() {
  const openPositions = new Map();
  const ACCT = 'tradovate-abc';
  // Broker recovered strategy but signalId is missing (connector cache miss
  // older than what /orderVersion can return, or a malformed clOrdId).
  const broker = [{
    symbol: 'MNQM6', netPos: -1, entryPrice: 30299.5,
    strategy: 'GEX_LT_3M_CROSSOVER', signalId: null,
  }];

  const resolveDefaults = ({ strategy, signalId }) => {
    if (signalId) return null;
    if (strategy === 'GEX_LT_3M_CROSSOVER') {
      return { maxHoldBars: 90, exitRules: [], originalStop: null, source: 'strategy' };
    }
    return null;
  };

  const result = reconcilePositionSnapshot(
    openPositions, ACCT, broker, posKey, { resolveDefaults }
  );
  assert(result.orphaned === 1, 'orphan counted');
  const pos = openPositions.get(posKey(ACCT, 'GEX_LT_3M_CROSSOVER', 'MNQM6'));
  assert(pos.maxHoldBars === 90, `strategy-fallback maxHold applied, got ${pos.maxHoldBars}`);
  assert(pos.defaultsSource === 'strategy', 'source tagged strategy');
  console.log('  ✓ orphan adoption falls back to per-strategy defaults');
})();

// ── Scenario 10: no resolver / no match → adopted with null protection ─────
// Verifies the legacy behavior still works (so a deploy with the registry
// empty doesn't crash) — but the caller is expected to log loudly.
(function orphanAdoptionWithoutResolver() {
  const openPositions = new Map();
  const ACCT = 'tradovate-abc';
  const broker = [{ symbol: 'MNQM6', netPos: -1, entryPrice: 30299.5, strategy: 'GEX_LT_3M_CROSSOVER', signalId: null }];

  // No opts at all — must not throw, must still adopt.
  const result = reconcilePositionSnapshot(openPositions, ACCT, broker, posKey);
  assert(result.orphaned === 1, 'orphan adopted even without resolver');
  const pos = openPositions.get(posKey(ACCT, 'GEX_LT_3M_CROSSOVER', 'MNQM6'));
  assert(pos.maxHoldBars === null, 'maxHoldBars left null (caller must surface)');
  assert(pos.defaultsSource === null, 'source null indicates no recovery');
  console.log('  ✓ orphan adoption without resolver leaves null + tags source=null');
})();

console.log('snapshot-reconciler: all scenarios passed');
