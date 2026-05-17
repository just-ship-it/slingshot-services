/**
 * Exit Rule Manager — orchestrator-side post-fill exit management.
 *
 * Each trade signal can carry one or more exit-management rules that the
 * orchestrator enforces on the broker side. The manager owns three event
 * loops:
 *
 *   - `onPriceTick` runs on every price.update (tick-level granularity).
 *     Used by `breakeven` and `mfeRatchet` rules.
 *   - `onCandleClose` runs on every candle.close (1m granularity).
 *     Used by `fibRetrace` (bar-close confirmation is essential —
 *     intra-bar wicks must NOT trigger).
 *   - `register` / `unregister` manage per-position state.
 *
 * The module does NOT subscribe to the message bus itself — index.js owns
 * the subscriptions and forwards events into here. That keeps testing easy
 * and keeps lifecycle handling in one place.
 *
 *  Lifecycle:
 *    orderRequest built  → captureRuleFromSignal(signal) → returns Rule[]
 *                          to stash on the pendingOrder
 *    position.opened     → register(...) creates RuleState from the rules
 *    price.update        → onPriceTick(...) updates MFE/MAE and evaluates
 *                          tick-driven rules (BE, ratchet)
 *    candle.close        → onCandleClose(...) evaluates bar-close-driven
 *                          rules (fibRetrace) using the bar's close price
 *    position.closed     → unregister(...) drops state
 *
 *  Rule actions:
 *    BE / ratchet → publishModifyStop  (move the broker SL)
 *    fibRetrace   → publishClosePosition (flatten + cancel brackets)
 *
 *  Both publishers are fire-and-forget HTTP POSTs in production. The
 *  manager doesn't wait for broker acks to keep evaluation loops fast.
 */

const RULE_TYPES = Object.freeze({
  BREAKEVEN: 'breakeven',
  FIB_RETRACE: 'fibRetrace',
  MFE_RATCHET: 'mfeRatchet',
});

/**
 * Extract Rule[] from a strategy's signal payload. Returns [] (empty) if
 * the signal carries no exit-management rules, in which case the orchestrator
 * stays passive on this position (hard SL/TP only).
 *
 * Multiple rule types can co-exist on the same signal — e.g. the live
 * two-layer config emits BE + fibRetrace. They run independently and
 * whichever fires first ends the trade.
 */
export function captureRuleFromSignal(signal) {
  if (!signal) return [];
  const rules = [];

  const beEnabled = signal.breakeven_stop === true || signal.breakevenStop === true;
  if (beEnabled) {
    const trigger = Number(signal.breakeven_trigger ?? signal.breakevenTrigger);
    const offset = Number(signal.breakeven_offset ?? signal.breakevenOffset ?? 0);
    if (Number.isFinite(trigger) && trigger > 0) {
      rules.push({
        type: RULE_TYPES.BREAKEVEN,
        trigger,
        offset: Number.isFinite(offset) ? offset : 0,
      });
    }
  }

  if (signal.fibRetrace === true && signal.fibRetraceConfig) {
    const retracePct = Number(signal.fibRetraceConfig.retracePct);
    const activationMFE = Number(signal.fibRetraceConfig.activationMFE);
    if (Number.isFinite(retracePct) && retracePct > 0 && retracePct < 1
        && Number.isFinite(activationMFE) && activationMFE > 0) {
      rules.push({
        type: RULE_TYPES.FIB_RETRACE,
        retracePct,
        activationMFE,
      });
    }
  }

  if (signal.mfeRatchet === true && signal.mfeRatchetConfig?.tiers?.length) {
    const tiers = signal.mfeRatchetConfig.tiers
      .map(t => ({
        minMFE: Number(t.minMFE),
        lockPct: Number(t.lockPct),
        label: t.label || null,
      }))
      .filter(t => Number.isFinite(t.minMFE) && Number.isFinite(t.lockPct))
      .sort((a, b) => b.minMFE - a.minMFE);   // highest-MFE tier first
    if (tiers.length > 0) {
      rules.push({
        type: RULE_TYPES.MFE_RATCHET,
        tiers,
        fixedPerTier: signal.mfeRatchetConfig.fixedPerTier === true,
      });
    }
  }

  return rules;
}

/**
 * Create the exit-rule manager.
 *
 * @param {object} deps
 * @param {object} deps.logger
 * @param {(payload) => Promise<void>} deps.publishModifyStop
 *   Called when BE / ratchet rules fire. payload = { accountId, strategy,
 *   symbol, signalId, newStopPrice, reason, mfe, originalStop, entryPrice,
 *   side }.
 * @param {(payload) => Promise<void>} deps.publishClosePosition
 *   Called when fibRetrace fires. payload = { accountId, strategy, symbol,
 *   signalId, reason, mfe, exitPrice, entryPrice, side }.
 * @param {(symbol: string) => string|null} deps.extractUnderlying
 *   Maps broker contract symbol → root (e.g. MNQH6 → NQ) so price.update's
 *   `baseSymbol` and candle.close's `product` can be matched against open
 *   positions.
 */
export function createExitRuleManager({ logger, publishModifyStop, publishClosePosition, extractUnderlying }) {
  if (!logger) throw new Error('exit-rule-manager: logger required');
  if (typeof publishModifyStop !== 'function') {
    throw new Error('exit-rule-manager: publishModifyStop required');
  }
  if (typeof publishClosePosition !== 'function') {
    throw new Error('exit-rule-manager: publishClosePosition required');
  }
  if (typeof extractUnderlying !== 'function') {
    throw new Error('exit-rule-manager: extractUnderlying required');
  }

  // Map<posKey, RuleState>
  // RuleState shape:
  //   {
  //     posKey, accountId, strategy, symbol, underlying,
  //     side: 'long' | 'short',
  //     entryPrice, originalStop,
  //     signalId,
  //     rules: [Rule],                       // captured rules (array)
  //     ruleStates: [PerRuleState],          // parallel array, fired flags, etc.
  //     highWaterMark, lowWaterMark,          // running extremes since fill
  //     closed: boolean,                      // set true once fibRetrace fires
  //                                            // (prevents double-fire from a
  //                                            // late price tick before
  //                                            // position.closed arrives)
  //     openedAt: epoch ms
  //   }
  const state = new Map();

  // Reverse lookups for fast event routing.
  const byUnderlying = new Map(); // underlying → Set<posKey>

  function makePosKey(accountId, strategy, symbol) {
    return `${accountId}|${strategy}|${symbol}`;
  }
  function indexAdd(rs) {
    if (!byUnderlying.has(rs.underlying)) byUnderlying.set(rs.underlying, new Set());
    byUnderlying.get(rs.underlying).add(rs.posKey);
  }
  function indexRemove(rs) {
    const set = byUnderlying.get(rs.underlying);
    if (!set) return;
    set.delete(rs.posKey);
    if (set.size === 0) byUnderlying.delete(rs.underlying);
  }

  function initRuleState(rule) {
    if (rule.type === RULE_TYPES.BREAKEVEN) {
      return { fired: false };
    }
    if (rule.type === RULE_TYPES.FIB_RETRACE) {
      return { activated: false, fired: false };
    }
    if (rule.type === RULE_TYPES.MFE_RATCHET) {
      return { currentTierIdx: -1, fired: false };  // -1 = no tier engaged yet
    }
    return { fired: false };
  }

  /**
   * Begin tracking a position. Called from handlePositionOpened (or
   * snapshot restore) once we know the actual fill price.
   *
   * @param {object} params
   * @param {string} params.accountId
   * @param {string} params.strategy
   * @param {string} params.symbol         broker symbol (e.g. MNQM6)
   * @param {'long'|'short'} params.side
   * @param {number} params.entryPrice
   * @param {string|null} params.signalId
   * @param {number|null} params.originalStop  the static SL placed on entry
   * @param {Rule[]|object|null} params.rules   captured rules (may also accept
   *                                            a legacy single rule object;
   *                                            null or [] = no tracking)
   */
  function register({ accountId, strategy, symbol, side, entryPrice, signalId, originalStop, rules, rule }) {
    if (!accountId || !strategy || !symbol) return;
    // Back-compat: caller might pass `rule` (single) or `rules` (array).
    let ruleList = [];
    if (Array.isArray(rules)) ruleList = rules.filter(Boolean);
    else if (rules) ruleList = [rules];
    else if (Array.isArray(rule)) ruleList = rule.filter(Boolean);
    else if (rule) ruleList = [rule];

    if (ruleList.length === 0) return; // passive mode

    if (!Number.isFinite(entryPrice)) {
      logger.warn(`[ExitRule] register ${strategy} ${symbol}: invalid entryPrice ${entryPrice} — skipping`);
      return;
    }

    const posKey = makePosKey(accountId, strategy, symbol);
    const underlying = extractUnderlying(symbol);
    if (!underlying) {
      logger.warn(`[ExitRule] register ${strategy} ${symbol}: cannot resolve underlying — skipping`);
      return;
    }

    const rs = {
      posKey,
      accountId, strategy, symbol, underlying,
      side,
      entryPrice,
      originalStop: Number.isFinite(originalStop) ? originalStop : null,
      signalId: signalId || null,
      rules: ruleList,
      ruleStates: ruleList.map(initRuleState),
      highWaterMark: entryPrice,
      lowWaterMark: entryPrice,
      closed: false,
      openedAt: Date.now(),
    };
    state.set(posKey, rs);
    indexAdd(rs);

    const summary = ruleList.map(r => describeRule(r)).join(', ');
    logger.info(`[ExitRule] tracking ${strategy} ${symbol} ${side} @${entryPrice} rules=[${summary}]`);
  }

  function describeRule(r) {
    if (r.type === RULE_TYPES.BREAKEVEN) return `BE(trig=${r.trigger}, off=${r.offset})`;
    if (r.type === RULE_TYPES.FIB_RETRACE) return `fib(retr=${r.retracePct}, act=${r.activationMFE})`;
    if (r.type === RULE_TYPES.MFE_RATCHET) return `ratchet(${r.tiers.length}t)`;
    return r.type;
  }

  function unregister({ accountId, strategy, symbol }) {
    if (!accountId || !strategy || !symbol) return;
    const posKey = makePosKey(accountId, strategy, symbol);
    const rs = state.get(posKey);
    if (!rs) return;
    state.delete(posKey);
    indexRemove(rs);
    const elapsed = ((Date.now() - rs.openedAt) / 60_000).toFixed(1);
    const fired = rs.ruleStates.map((s, i) => s.fired ? rs.rules[i].type : null).filter(Boolean);
    logger.info(`[ExitRule] untracked ${strategy} ${symbol} after ${elapsed}min (fired=[${fired.join(',') || 'none'}])`);
  }

  function updateExtremes(rs, { high, low }) {
    if (high != null && high > rs.highWaterMark) rs.highWaterMark = high;
    if (low != null && low < rs.lowWaterMark) rs.lowWaterMark = low;
  }

  function currentMFE(rs) {
    return rs.side === 'long'
      ? rs.highWaterMark - rs.entryPrice
      : rs.entryPrice - rs.lowWaterMark;
  }

  /**
   * price.update handler. Updates MFE/MAE on every registered position
   * whose underlying matches, evaluates tick-driven rules (BE, ratchet).
   * Does NOT evaluate fibRetrace — that uses bar-close only.
   *
   * @param {object} msg the price.update payload
   *                      { baseSymbol, high, low, close, timestamp, ... }
   */
  function onPriceTick(msg) {
    if (!msg) return;
    const baseSymbol = msg.baseSymbol;
    if (!baseSymbol) return;
    const set = byUnderlying.get(baseSymbol);
    if (!set || set.size === 0) return;

    const high = numericOr(msg.high, null);
    const low = numericOr(msg.low, null);
    if (high == null && low == null) return;

    for (const posKey of set) {
      const rs = state.get(posKey);
      if (!rs || rs.closed) continue;
      updateExtremes(rs, { high, low });
      evaluateTickRules(rs);
    }
  }

  /**
   * candle.close handler. Updates MFE/MAE from the bar's high/low and
   * evaluates fibRetrace rules using the bar's CLOSE price.
   *
   * @param {object} msg the candle.close payload
   *                      { product, symbol, timestamp, open, high, low, close, volume }
   */
  function onCandleClose(msg) {
    if (!msg) return;
    const product = msg.product;
    if (!product) return;
    const set = byUnderlying.get(product);
    if (!set || set.size === 0) return;

    const high = numericOr(msg.high, null);
    const low = numericOr(msg.low, null);
    const close = numericOr(msg.close, null);
    if (close == null) return;

    for (const posKey of set) {
      const rs = state.get(posKey);
      if (!rs || rs.closed) continue;
      updateExtremes(rs, { high, low });
      evaluateBarCloseRules(rs, close);
    }
  }

  function evaluateTickRules(rs) {
    const mfe = currentMFE(rs);
    if (mfe <= 0) return;
    for (let i = 0; i < rs.rules.length; i++) {
      const rule = rs.rules[i];
      const rstate = rs.ruleStates[i];
      if (rstate.fired) continue;
      if (rule.type === RULE_TYPES.BREAKEVEN) {
        evaluateBE(rs, rule, rstate, mfe);
      } else if (rule.type === RULE_TYPES.MFE_RATCHET) {
        evaluateRatchet(rs, rule, rstate, mfe);
      }
    }
  }

  function evaluateBarCloseRules(rs, barClose) {
    const mfe = currentMFE(rs);
    if (mfe <= 0) return;
    for (let i = 0; i < rs.rules.length; i++) {
      const rule = rs.rules[i];
      const rstate = rs.ruleStates[i];
      if (rstate.fired) continue;
      if (rule.type === RULE_TYPES.FIB_RETRACE) {
        evaluateFib(rs, rule, rstate, mfe, barClose);
      }
    }
  }

  function evaluateBE(rs, rule, rstate, mfe) {
    if (mfe < rule.trigger) return;
    const newStop = rs.side === 'long'
      ? rs.entryPrice + rule.offset
      : rs.entryPrice - rule.offset;
    rstate.fired = true;
    rstate.publishedStop = newStop;
    fireModifyStop(rs, newStop,
      `BE trigger MFE=${mfe.toFixed(1)} → entry${rule.offset >= 0 ? '+' : ''}${rule.offset}`);
  }

  function evaluateRatchet(rs, rule, rstate, mfe) {
    // Walk tiers highest→lowest (already sorted). First tier whose minMFE
    // is reached is the active tier. Skip if same or lower-priority tier
    // than the current one (ratchet only moves UP, never DOWN).
    for (let i = 0; i < rule.tiers.length; i++) {
      const tier = rule.tiers[i];
      if (mfe < tier.minMFE) continue;
      // Found highest tier reached. Engage if not already at it.
      if (i === rstate.currentTierIdx) return; // already engaged this tier
      rstate.currentTierIdx = i;
      // Lock lockPct of MFE: newStop = entry ± mfe × lockPct
      // (clamped so we never move stop AGAINST us — should be moot since
      // each tier engages at higher MFE than the last)
      const lockedPts = mfe * tier.lockPct;
      const newStop = rs.side === 'long'
        ? rs.entryPrice + lockedPts
        : rs.entryPrice - lockedPts;
      rstate.publishedStop = newStop;
      // ratchet rule "fires" repeatedly (one fire per tier upgrade), but
      // ratchet rules don't stay "fired" — the inner currentTierIdx
      // tracks which tier we're on. We only set rstate.fired = true on
      // the highest tier (so the next evaluator pass skips this rule).
      if (i === 0) rstate.fired = true;
      fireModifyStop(rs, newStop,
        `ratchet tier=${tier.label || i} MFE=${mfe.toFixed(1)} → lock ${(tier.lockPct * 100).toFixed(0)}% = entry${rs.side === 'long' ? '+' : '-'}${lockedPts.toFixed(1)}`);
      return; // only one fire per tick
    }
  }

  function evaluateFib(rs, rule, rstate, mfe, barClose) {
    if (!rstate.activated) {
      if (mfe < rule.activationMFE) return;
      rstate.activated = true;
      logger.info(`[ExitRule] fib activated ${rs.strategy} ${rs.symbol} ${rs.side} @MFE=${mfe.toFixed(1)} (act=${rule.activationMFE})`);
    }
    // fibLevel = entry ± mfe × (1 − retracePct)
    const lockPts = mfe * (1 - rule.retracePct);
    const fibLevel = rs.side === 'long'
      ? rs.entryPrice + lockPts
      : rs.entryPrice - lockPts;
    const breached = rs.side === 'long' ? barClose < fibLevel : barClose > fibLevel;
    if (!breached) return;
    rstate.fired = true;
    rs.closed = true; // prevent any further evaluator runs
    fireClosePosition(rs, barClose,
      `fib retrace MFE=${mfe.toFixed(1)} barClose=${barClose} fibLevel=${fibLevel.toFixed(2)} (retr=${rule.retracePct})`);
  }

  function fireModifyStop(rs, newStopPrice, reason) {
    const payload = {
      accountId: rs.accountId,
      strategy: rs.strategy,
      symbol: rs.symbol,
      signalId: rs.signalId,
      newStopPrice,
      reason,
      mfe: currentMFE(rs),
      originalStop: rs.originalStop,
      entryPrice: rs.entryPrice,
      side: rs.side,
    };
    logger.info(`[ExitRule] FIRE modifyStop ${rs.strategy} ${rs.symbol} ${rs.side}: ${reason}; newStop=${newStopPrice}`);
    Promise.resolve()
      .then(() => publishModifyStop(payload))
      .catch(err => logger.error(`[ExitRule] publishModifyStop failed: ${err.message}`));
  }

  function fireClosePosition(rs, exitPrice, reason) {
    const payload = {
      accountId: rs.accountId,
      strategy: rs.strategy,
      symbol: rs.symbol,
      signalId: rs.signalId,
      reason,
      mfe: currentMFE(rs),
      exitPrice,
      entryPrice: rs.entryPrice,
      side: rs.side,
    };
    logger.info(`[ExitRule] FIRE closePosition ${rs.strategy} ${rs.symbol} ${rs.side}: ${reason}`);
    Promise.resolve()
      .then(() => publishClosePosition(payload))
      .catch(err => logger.error(`[ExitRule] publishClosePosition failed: ${err.message}`));
  }

  function numericOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  // Diagnostics
  function getState() {
    return [...state.values()].map(rs => ({
      posKey: rs.posKey,
      strategy: rs.strategy,
      symbol: rs.symbol,
      side: rs.side,
      entryPrice: rs.entryPrice,
      mfe: currentMFE(rs),
      mae: rs.side === 'long' ? rs.entryPrice - rs.lowWaterMark : rs.highWaterMark - rs.entryPrice,
      rules: rs.rules.map((r, i) => ({ ...r, ...rs.ruleStates[i] })),
      closed: rs.closed,
    }));
  }

  function size() { return state.size; }

  return {
    register, unregister,
    onPriceTick, onCandleClose,
    getState, size,
    RULE_TYPES,
  };
}
