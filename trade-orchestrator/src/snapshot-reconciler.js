/**
 * Snapshot reconciliation for pending orders and open positions.
 *
 * Background: tradovate-service publishes periodic `orders.snapshot` and
 * `position.snapshot` events (broker reality). Previously the orchestrator
 * wiped its local pendingOrders/openPositions for an account and rebuilt
 * from the broker snapshot. That wiped:
 *   - strategy attribution (broker has no concept of "strategy")
 *   - signal-supplied lifecycle metadata (timeoutCandles, maxHoldBars, exitRules)
 *   - the original `requestedAt` timestamp that checkStaleLimits depends on
 * Result: every limit order became UNATTRIBUTED within ~30s of placement,
 * stale-limit cancel never fired, and future signals got gated out by the
 * UNATTRIBUTED entry.
 *
 * The reconciler MERGES instead. For each broker order, it tries to find an
 * existing pending entry to update in-place. Matching priority:
 *   1. brokerOrderId (most durable)
 *   2. signalId (when both sides know it)
 *   3. accountId + strategy + symbol (the original pendingKey)
 * If no match, the broker order is added as a new entry, attributed to
 * whatever the snapshot provided or 'UNATTRIBUTED' as last resort.
 *
 * Existing entries not seen in the snapshot accumulate `missingFromBroker`
 * observations and are only dropped after `MISSING_OBSERVATIONS_BEFORE_DROP`
 * consecutive misses — guards against the race where the snapshot fires
 * between local-place and broker-ack.
 */

export const MISSING_OBSERVATIONS_BEFORE_DROP = 3; // ~90s at 30s polling

/**
 * Reconcile a single account's slice of pendingOrders against a fresh
 * orders snapshot from the broker. Mutates `pendingOrders` in place.
 *
 * @param {Map} pendingOrders   - state.pendingOrders (full multi-account map)
 * @param {string} accountId    - account this snapshot belongs to
 * @param {Array} brokerOrders  - the `orders` array from orders.snapshot
 * @param {Map} openPositions   - state.openPositions; used to skip rebuild
 *                                of entries when a position already exists
 * @param {Function} pendingKey - keyFn (accountId, strategy, symbol) → string
 * @returns {{ restored: number, preserved: number, dropped: number, orphaned: number }}
 */
export function reconcileOrdersSnapshot(pendingOrders, accountId, brokerOrders, openPositions, pendingKey) {
  if (!Array.isArray(brokerOrders)) return { restored: 0, preserved: 0, dropped: 0, orphaned: 0 };

  // Index broker orders we'll process: skip bracket legs (stop/target) and
  // skip anything for a symbol where we already hold an open position
  // (those broker orders are bracket children of the position, not entries).
  const entryOrders = [];
  for (const o of brokerOrders) {
    if (!o.symbol) continue;
    if (o.role === 'stop' || o.role === 'target') continue;
    const hasPosition = [...openPositions.values()].some(
      p => p.accountId === accountId && p.symbol === o.symbol
    );
    if (hasPosition) continue;
    entryOrders.push(o);
  }

  // Tag every account-scoped pending entry as "not yet seen this snapshot".
  // We'll clear the flag on entries we match below; survivors get an
  // increment to their missing counter.
  const accountPending = [];
  for (const [key, value] of pendingOrders.entries()) {
    if (value.accountId !== accountId) continue;
    value._seenThisSnapshot = false;
    accountPending.push({ key, value });
  }

  let restored = 0;
  let preserved = 0;
  let orphaned = 0;

  for (const o of entryOrders) {
    const existing = findExistingPending(accountPending, o);

    if (existing) {
      // PRESERVE: keep strategy/timeoutCandles/maxHoldBars/exitRules/requestedAt.
      // Only update fields that genuinely belong to broker truth: orderId, status.
      existing.value.orderId = o.orderId ?? existing.value.orderId;
      // Also stamp broker-known signalId if we didn't have one and broker does.
      if (!existing.value.signalId && o.signalId) {
        existing.value.signalId = o.signalId;
      }
      existing.value._seenThisSnapshot = true;
      existing.value.missingFromBroker = 0;
      preserved++;
    } else {
      // ORPHAN: broker reports an order we don't know about. Could be:
      //   - placed by another orchestrator instance
      //   - manually placed
      //   - persisted across our restart (we lost our local state)
      // Attribute to whatever the broker snapshot includes (the connector
      // now populates `strategy`/`signalId` when its mappings survive),
      // else mark UNATTRIBUTED. We do NOT make up a timeoutCandles here —
      // unattributed orders are best left alone for human inspection.
      const strategy = o.strategy || 'UNATTRIBUTED';
      const direction = o.action === 'Buy' ? 'long' : 'short';
      pendingOrders.set(pendingKey(accountId, strategy, o.symbol), {
        accountId, strategy, symbol: o.symbol, direction,
        signalId: o.signalId || null,
        orderId: o.orderId,
        requestedAt: Date.now(),
        source: 'broker_snapshot',
        missingFromBroker: 0,
        _seenThisSnapshot: true,
      });
      orphaned++;
      restored++;
    }
  }

  // Survivors: existing pending entries we didn't see in this snapshot.
  // Could be: (a) order filled or cancelled between snapshots, (b) race
  // where local-place happened after the broker computed this snapshot.
  // Increment missing counter; drop only after N consecutive misses.
  let dropped = 0;
  for (const { key, value } of accountPending) {
    const seen = value._seenThisSnapshot === true;
    delete value._seenThisSnapshot;
    if (seen) continue;
    value.missingFromBroker = (value.missingFromBroker || 0) + 1;
    if (value.missingFromBroker >= MISSING_OBSERVATIONS_BEFORE_DROP) {
      pendingOrders.delete(key);
      dropped++;
    }
  }

  return { restored, preserved, dropped, orphaned };
}

function findExistingPending(accountPending, brokerOrder) {
  // 1) orderId is the most reliable — once broker has assigned it, it's stable.
  if (brokerOrder.orderId != null) {
    const byOrderId = accountPending.find(e => e.value.orderId != null && String(e.value.orderId) === String(brokerOrder.orderId));
    if (byOrderId) return byOrderId;
  }
  // 2) signalId match — orchestrator stamps signalId at placement; if broker
  //    also knows it (via the connector's signalMap), the round-trip matches.
  if (brokerOrder.signalId) {
    const bySignalId = accountPending.find(e => e.value.signalId === brokerOrder.signalId);
    if (bySignalId) return bySignalId;
  }
  // 3) Fallback: (strategy + symbol) — only if broker tells us the strategy.
  //    Without strategy attribution there's no safe fallback — leave to orphan.
  if (brokerOrder.strategy) {
    const byPendingKey = accountPending.find(e =>
      e.value.strategy === brokerOrder.strategy && e.value.symbol === brokerOrder.symbol
    );
    if (byPendingKey) return byPendingKey;
  }
  return null;
}

/**
 * Reconcile open positions. Same MERGE principle: preserve local attribution
 * + maxHoldBars + exitRules + signalId when the broker confirms the same
 * (account, symbol) net position. Drop a position only after it's missing
 * from the broker for `MISSING_OBSERVATIONS_BEFORE_DROP` consecutive snapshots.
 *
 * When the snapshot reveals an orphan position (broker has it, local doesn't —
 * usually because the WS execution path dropped the entry fill), the caller's
 * `resolveDefaults({strategy, signalId})` callback is consulted to recover the
 * position's lifecycle metadata (maxHoldBars, exitRules, originalStop) from
 * the orchestrator's known signal registry. Without this, adopted positions
 * skip max-hold and exit-rule enforcement — a silent safety failure.
 *
 * Mutates `openPositions` in place. Returns counters plus an `adopted` array
 * of newly-restored entries so the caller can register their exit rules with
 * the exitRuleManager.
 *
 * @param {Map} openPositions
 * @param {string} accountId
 * @param {Array} brokerPositions
 * @param {Function} posKey
 * @param {object} [opts]
 * @param {Function} [opts.resolveDefaults] - ({strategy, signalId}) => {maxHoldBars, exitRules, originalStop} | null
 * @returns {{ restored: number, preserved: number, dropped: number, orphaned: number, adopted: Array }}
 */
export function reconcilePositionSnapshot(openPositions, accountId, brokerPositions, posKey, opts = {}) {
  if (!Array.isArray(brokerPositions)) {
    return { restored: 0, preserved: 0, dropped: 0, orphaned: 0, adopted: [] };
  }
  const resolveDefaults = typeof opts.resolveDefaults === 'function' ? opts.resolveDefaults : null;

  const accountPositions = [];
  for (const [key, value] of openPositions.entries()) {
    if (value.accountId !== accountId) continue;
    value._seenThisSnapshot = false;
    accountPositions.push({ key, value });
  }

  let restored = 0;
  let preserved = 0;
  let orphaned = 0;
  const adopted = [];

  for (const p of brokerPositions) {
    if (!p.symbol || !p.netPos) continue;
    const side = p.netPos > 0 ? 'long' : 'short';

    // Match by (accountId, symbol) — only one net position per account+symbol.
    // Strategy is what we preserve from local state.
    const existing = accountPositions.find(e =>
      e.value.symbol === p.symbol && Math.sign(e.value.netPos) === Math.sign(p.netPos)
    );

    if (existing) {
      // PRESERVE strategy / signalId / openedAt / maxHoldBars / exitRules.
      // Only update broker-truth fields: netPos and entryPrice (if broker has it).
      existing.value.netPos = p.netPos;
      if (p.entryPrice != null) existing.value.entryPrice = p.entryPrice;
      existing.value._seenThisSnapshot = true;
      existing.value.missingFromBroker = 0;
      preserved++;
    } else {
      const strategy = p.strategy || 'UNATTRIBUTED';
      const defaults = resolveDefaults
        ? (resolveDefaults({ strategy, signalId: p.signalId ?? null }) || null)
        : null;
      const entry = {
        accountId, strategy, symbol: p.symbol, side, netPos: p.netPos,
        entryPrice: p.entryPrice, signalId: p.signalId ?? null,
        openedAt: new Date().toISOString(),
        maxHoldBars: defaults?.maxHoldBars ?? null,
        exitRules: defaults?.exitRules ?? [],
        originalStop: defaults?.originalStop ?? null,
        source: 'broker_snapshot',
        defaultsSource: defaults?.source ?? null, // 'signalId' | 'strategy' | null
        missingFromBroker: 0,
        _seenThisSnapshot: true,
      };
      const key = posKey(accountId, strategy, p.symbol);
      openPositions.set(key, entry);
      adopted.push({ key, entry });
      orphaned++;
      restored++;
    }
  }

  let dropped = 0;
  for (const { key, value } of accountPositions) {
    const seen = value._seenThisSnapshot === true;
    delete value._seenThisSnapshot;
    if (seen) continue;
    value.missingFromBroker = (value.missingFromBroker || 0) + 1;
    if (value.missingFromBroker >= MISSING_OBSERVATIONS_BEFORE_DROP) {
      openPositions.delete(key);
      dropped++;
    }
  }

  return { restored, preserved, dropped, orphaned, adopted };
}
