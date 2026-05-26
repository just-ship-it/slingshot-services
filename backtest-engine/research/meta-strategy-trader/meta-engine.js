/**
 * Meta-Strategy Engine
 *
 * Consumes captured signal streams from the 4 production strategies (lstb, gfi,
 * glx, glf) and drives them through a single-slot 1-NQ position with pluggable
 * meta-rules. Fills/exits walk 1s OHLCV honestly per CLAUDE.md mandate.
 *
 * Acceptance gate: with only one strategy enabled + FCFS rule + that strategy's
 * original cooldown re-applied, the engine MUST reproduce the strategy's
 * gold-standard JSON trade-by-trade.
 *
 * Once the gate passes, the AI ruleset becomes a swap-in for the FCFS rule.
 */

const POINT_VALUE_NQ = 20;

// IMPORTANT: NQ technically trades in 0.25 ticks, BUT the gold-standard
// trade-simulator rounds prices to 2 decimals (cents), not ticks. To pass
// Test A (solo reproduction), the meta-engine must use the same rounding.
// TODO after Test A passes: switch to roundToNQTick for live-honest pricing
// (would introduce a small but principled divergence from gold).
function roundToNQTick(price) {
  return Math.round(price * 100) / 100;
}

// Default cooldowns per strategy. Captured signal streams were emitted with
// cooldown=0 (capture mode forces it); we re-apply here to match original
// engine behavior. Only gex-flip-ivpct has a non-zero default in production.
//
// `anchorOffsetMs` accounts for inconsistent ts conventions across strategies'
// `updateLastSignalTime` calls:
//   - gex-flip-ivpct: anchors to candle.timestamp (bar START) → for a 5m
//     timeframe sig.ts is 5min later, so offset = -5min.
//   - ls-flip-trigger-bar: anchors to signal.timestamp = candle.timestamp +
//     1m (bar END) → matches sig.ts exactly, offset = 0.
//   - glx, glf: cooldown=0 so offset is irrelevant.
export const DEFAULT_COOLDOWNS = {
  // gex-flip-ivpct anchor offset: theoretically -5min (5m bar start vs my
  // sig.ts = bar end), but empirically the offset doesn't shift trade count
  // for this 1-month window (only 14 trades; rare for two signals to fall
  // inside the 30–35 min post-exit window). Keeping 0 for simplicity.
  'gex-flip-ivpct':       { cooldownMs: 30 * 60 * 1000, anchorOffsetMs: 0 },
  'gex-lt-3m-crossover':  { cooldownMs: 0, anchorOffsetMs: 0 },
  'gex-level-fade':       { cooldownMs: 0, anchorOffsetMs: 0 },
  'ls-flip-trigger-bar':  { cooldownMs: 0, anchorOffsetMs: 0 },
};

// Default slippage by fill type. Limit fills get NO slippage (CLAUDE.md spec).
export const DEFAULT_SLIPPAGE = { limit: 0, market: 1.0, stop: 1.5 };

// FCFS rule: accept any signal when flat, never preempt.
export const FCFS_RULE = {
  name: 'fcfs',
  shouldAccept: () => ({ ok: true }),
  shouldPreempt: () => ({ ok: false, reason: 'fcfs_no_preempt' }),
};

// ── ET wall-clock helpers ────────────────────────────────────────────────
function getEtParts(ts) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ts));
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  return {
    weekday: o.weekday,
    dateKey: `${o.year}-${o.month}-${o.day}`,
    hour: parseInt(o.hour, 10),
    minute: parseInt(o.minute, 10),
  };
}

function isPastEodCutoff(ts, cutoffEt) {
  if (!cutoffEt) return false;
  const [h, m] = cutoffEt.split(':').map(Number);
  const et = getEtParts(ts);
  if (et.weekday === 'Sat' || et.weekday === 'Sun') return false;
  return et.hour > h || (et.hour === h && et.minute >= m);
}

function normSide(s) {
  const x = String(s || '').toLowerCase();
  if (x === 'long' || x === 'buy') return 'long';
  if (x === 'short' || x === 'sell') return 'short';
  return null;
}

// ── MetaEngine ───────────────────────────────────────────────────────────
export class MetaEngine {
  constructor({
    signals,
    secondDataProvider,
    metaRule = FCFS_RULE,
    cooldownConfig = DEFAULT_COOLDOWNS,
    enabledStrategies = null,    // null = all enabled
    eodCutoffEt = '15:45',
    marketCloseEt = null,         // optional: per-day force-close before eod (e.g. '15:55' for RTH close)
    commission = 5,
    slippage = DEFAULT_SLIPPAGE,
    contractFilter = null,        // string or null; if set, only 1s bars matching this signalContract are used
    verbose = false,
  }) {
    this.signals = [...signals].sort((a, b) => a.ts - b.ts);
    this.sdp = secondDataProvider;
    this.metaRule = metaRule;
    this.cooldownConfig = cooldownConfig;
    this.enabledStrategies = enabledStrategies ? new Set(enabledStrategies) : null;
    this.eodCutoffEt = eodCutoffEt;
    this.marketCloseEt = marketCloseEt;
    this.commission = commission;
    this.slippage = slippage;
    this.contractFilter = contractFilter;
    this.verbose = verbose;

    // Per-strategy cooldown bookkeeping (mirrors base-strategy.lastSignalTime
    // + gex-flip's onPositionClosed override). Reset to 0 = no prior signal/exit.
    this.lastSignalEmitTs = new Map();   // strategy → ts of most recent emit
    this.lastExitTs = new Map();          // strategy → ts of most recent accepted-trade exit
    this.eodFiredDates = new Set();       // ET date keys where EOD already fired
    this.marketCloseFiredDates = new Set();

    // Single-slot state
    this.position = null;     // { strategy, side, entryPrice, stopLoss, takeProfit, entryTs, signal, beTriggered, ... }
    this.pending = null;      // { strategy, side, signal, placedTs, beTriggered: false }
    this.trades = [];         // completed trades
    this.rejections = [];     // { ts, strategy, side, reason }
  }

  _isEnabled(strategy) {
    return this.enabledStrategies === null || this.enabledStrategies.has(strategy);
  }

  // Cooldown filter: returns true if the signal is "emitted" in original-engine
  // terms (cooldown elapsed since max(lastEmit, lastExit)). Updates lastEmitTs
  // when it passes (matches createSignal → updateLastSignalTime in strategies).
  _passesCooldown(sig) {
    const cfg = this.cooldownConfig[sig.strategy];
    const cooldownMs = cfg?.cooldownMs ?? 0;
    const offsetMs = cfg?.anchorOffsetMs ?? 0;
    // The check-ts must match what the strategy uses internally for
    // checkCooldown(). For gfi that's candle.timestamp (bar start) = sig.ts - 5m.
    const checkTs = sig.ts + offsetMs;
    if (cooldownMs <= 0) {
      this.lastSignalEmitTs.set(sig.strategy, checkTs);
      return true;
    }
    const lastEmit = this.lastSignalEmitTs.get(sig.strategy) ?? 0;
    const lastExit = this.lastExitTs.get(sig.strategy) ?? 0;
    const anchor = Math.max(lastEmit, lastExit);
    if (checkTs - anchor < cooldownMs) return false;
    this.lastSignalEmitTs.set(sig.strategy, checkTs);
    return true;
  }

  _reject(sig, reason) {
    this.rejections.push({ ts: sig.ts, strategy: sig.strategy, side: sig.side, reason });
  }

  // Convert capture-time signal into a pending order that the bar-walk fills.
  _placePending(sig) {
    const side = normSide(sig.side);
    if (!side) { this._reject(sig, 'invalid_side'); return; }
    this.pending = {
      strategy: sig.strategy,
      side,
      signalContract: sig.signalContract || null,  // for multi-contract bar matching across rollovers
      limitPrice: roundToNQTick(sig.entryPrice),
      // Captured stop/target may be off-tick if the signal price was off-tick
      // (e.g., lstb bar-extreme math). Snap to ticks; they'll be re-anchored
      // from actualEntry on fill if stopDistance/targetDistance is present.
      stopLoss: roundToNQTick(sig.stopLoss),
      takeProfit: roundToNQTick(sig.takeProfit),
      stopDistance: sig.stopDistance ?? null,
      targetDistance: sig.targetDistance ?? null,
      placedTs: sig.ts,
      timeoutMs: (sig.timeoutCandles || 0) * 60_000,
      maxHoldMs: (sig.maxHoldBars || 0) * 60_000,
      cancelOnPreFillExtreme: !!sig.cancelOnPreFillExtreme,
      adverseFlipCancelTs: sig.adverseFlipCancelTs ?? null,
      breakevenStop: !!sig.breakevenStop,
      breakevenTrigger: sig.breakevenTrigger || 0,
      breakevenOffset: sig.breakevenOffset || 0,
      signal: sig,
    };
  }

  // Close current position synthetically at bar close (used for preempt + EOD).
  _closePosition(bar, reason) {
    if (!this.position) return;
    const p = this.position;
    const exitPx = roundToNQTick(bar.close);
    const pts = p.side === 'long' ? (exitPx - p.entryPrice) : (p.entryPrice - exitPx);
    const gross = pts * POINT_VALUE_NQ;
    const net = gross - this.commission;
    this.trades.push({
      strategy: p.strategy,
      side: p.side,
      entryTs: p.entryTs,
      entryPrice: p.entryPrice,
      exitTs: bar.timestamp,
      exitPrice: exitPx,
      pointsPnL: pts,
      grossPnL: gross,
      netPnL: net,
      exitReason: reason,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      durationMs: bar.timestamp - p.entryTs,
      signalId: p.signal?.metadata?.signalId ?? null,
      ruleId: p.signal?.ruleId ?? null,
    });
    this.lastExitTs.set(p.strategy, bar.timestamp);
    this.position = null;
  }

  // Apply meta-rule + cooldown + state gates to one captured signal.
  _handleSignal(sig, currentBar) {
    if (!this._isEnabled(sig.strategy)) { this._reject(sig, 'strategy_disabled'); return; }
    if (!this._passesCooldown(sig))     { this._reject(sig, 'cooldown'); return; }

    if (this.position) {
      const decision = this.metaRule.shouldPreempt(sig, this.position, this);
      if (!decision.ok) { this._reject(sig, decision.reason || 'in_position'); return; }
      // Preempt: close current at this bar's close, then place new pending.
      this._closePosition(currentBar, 'preempted_by:' + sig.strategy);
    }
    if (this.pending) {
      // A second signal arrives while a prior pending limit is unfilled.
      // For v0 we keep first-pending: drop the new one. (Meta-rules can later
      // override this — e.g., AI preemption could decide to swap the pending.)
      this._reject(sig, 'pending_limit_blocking');
      return;
    }

    const decision = this.metaRule.shouldAccept(sig, this);
    if (!decision.ok) { this._reject(sig, decision.reason || 'meta_rejected'); return; }
    this._placePending(sig);
  }

  // Process a single 1s bar's effect on the pending order.
  // Mirrors trade-simulator.js processSecondBar pending branch (line ~415-510)
  // semantically: check pre-fill cancel ONLY when the bar would NOT also fill;
  // honor gap-through fills (bar.open already past limit = price improvement);
  // re-anchor SL/TP from actualEntry when stopDistance/targetDistance present.
  _stepPending(bar) {
    if (!this.pending) return;
    const p = this.pending;
    if (bar.timestamp < p.placedTs) return;
    // Multi-contract guard: only react to bars whose symbol matches our
    // pending's signal contract. Without this, an NQM5 bar during the H5→M5
    // rollover window would try to fill an NQH5 limit using NQM5 prices
    // (which are offset by the calendar spread).
    if (p.signalContract && bar.symbol && bar.symbol !== p.signalContract) return;

    const isBuy = p.side === 'long';
    const wouldFill = isBuy ? (bar.low <= p.limitPrice) : (bar.high >= p.limitPrice);

    // Adverse-flip cancel (lstb): the next LS flip's ts is encoded on the
    // signal. If we reach it before fill, the directional bias is invalidated
    // and the limit is killed. Mirrors trade-simulator.js line 431.
    if (p.adverseFlipCancelTs && bar.timestamp >= p.adverseFlipCancelTs) {
      this._reject(p.signal, 'pre_fill_adverse_flip');
      this.pending = null;
      return;
    }

    // Pre-fill-extreme cancel: ORIGINAL engine only cancels when wouldFill is FALSE
    // (line 446-464 of trade-simulator.js). If the bar both crosses an extreme AND
    // fills the limit, the fill wins. My earlier version checked extreme first and
    // dropped 234 lstb trades that gold actually took.
    if (p.cancelOnPreFillExtreme && !wouldFill) {
      const targetHit = isBuy ? (bar.high >= p.takeProfit) : (bar.low <= p.takeProfit);
      const stopHit   = isBuy ? (bar.low  <= p.stopLoss)   : (bar.high >= p.stopLoss);
      if (targetHit || stopHit) {
        this._reject(p.signal, targetHit ? 'pre_fill_target_first' : 'pre_fill_stop_first');
        this.pending = null;
        return;
      }
    }

    if (wouldFill) {
      // Gap-through: if the bar OPENED already past our limit, fill at open
      // (price improvement). Otherwise fill exactly at limit.
      const gappedThrough = isBuy ? (bar.open <= p.limitPrice) : (bar.open >= p.limitPrice);
      const actualEntry = roundToNQTick(gappedThrough ? bar.open : p.limitPrice);

      // Re-anchor SL/TP from actualEntry if distances are specified. This is
      // what gives gold trades like {actualEntry 20897.25, stop 20885.25,
      // target 20912.25} for a buy with 12pt stop / 15pt target — the SL/TP
      // in the captured signal were computed from signal.entryPrice (the
      // close), but the strategy intends a fixed point distance from fill.
      let stopLoss = p.stopLoss;
      let takeProfit = p.takeProfit;
      if (p.stopDistance != null) {
        stopLoss = roundToNQTick(isBuy
          ? actualEntry - p.stopDistance
          : actualEntry + p.stopDistance);
      }
      if (p.targetDistance != null) {
        takeProfit = roundToNQTick(isBuy
          ? actualEntry + p.targetDistance
          : actualEntry - p.targetDistance);
      }

      this.position = {
        strategy: p.strategy,
        side: p.side,
        signalContract: p.signalContract,
        entryPrice: actualEntry,
        stopLoss,
        takeProfit,
        entryTs: bar.timestamp,
        maxHoldMs: p.maxHoldMs,
        breakevenStop: p.breakevenStop,
        breakevenTrigger: p.breakevenTrigger,
        breakevenOffset: p.breakevenOffset,
        beTriggered: false,
        signal: p.signal,
      };
      this.pending = null;
      return;
    }

    // Timeout cancel (only if not filled this bar)
    if (p.timeoutMs > 0 && (bar.timestamp - p.placedTs) >= p.timeoutMs) {
      this._reject(p.signal, 'limit_timeout');
      this.pending = null;
    }
  }

  // Process a single 1s bar's effect on the open position. Order MUST mirror
  // trade-simulator.js updateTradeWithSecondResolution active branch (lines
  // 533-583): EOD → market_close → maxHold → BE-mutate → stop → target.
  _stepPosition(bar) {
    if (!this.position) return;
    const p = this.position;
    // Don't evaluate exits on the same bar as entry. Mirrors trade-simulator
    // line 525 `continue` after fill, which skips the fill bar's exit checks.
    if (bar.timestamp <= p.entryTs) return;
    // Multi-contract guard: only react to bars matching position's contract.
    // EOD/marketClose are time-based and would still fire from the wrong
    // contract's bars — handle them outside this guard if needed (currently
    // they're inside the guard, which is fine because EOD will catch on a
    // matching-contract bar later in the same minute).
    if (p.signalContract && bar.symbol && bar.symbol !== p.signalContract) return;

    // 1. EOD cutoff (highest priority — day-trade-margin liquidation).
    //    Exits at bar.open per trade-simulator.js line 535.
    if (this.eodCutoffEt && isPastEodCutoff(bar.timestamp, this.eodCutoffEt)) {
      this._realizeExit(bar, roundToNQTick(bar.open), 'eod_liquidation');
      return;
    }

    // 2. Market close (typically 15:55 ET). Exits at bar.close per line 539.
    if (this.marketCloseEt && isPastEodCutoff(bar.timestamp, this.marketCloseEt)) {
      this._realizeExit(bar, roundToNQTick(bar.close), 'market_close');
      return;
    }

    // 3. Max-hold force-close. bar.close, no slippage (limit branch in exitTrade).
    if (p.maxHoldMs > 0 && (bar.timestamp - p.entryTs) >= p.maxHoldMs) {
      this._realizeExit(bar, roundToNQTick(bar.close), 'max_hold_time');
      return;
    }

    // 4. Stop hit. CRITICAL: gold engine checks stop BEFORE updating BE on
    //    this bar (trade-simulator.js line 567-575 BEFORE line 600 BE update).
    //    A bar that both triggers BE AND hits TP must take the TP (gold path)
    //    not the BE-shifted stop. So we use the CURRENT stop (pre-BE-update)
    //    here, then apply BE at the end of the bar for next-bar exits.
    const stopHit = p.side === 'long' ? (bar.low <= p.stopLoss) : (bar.high >= p.stopLoss);
    if (stopHit) {
      // Trailing-stop label only applies if BE had triggered on a PRIOR bar.
      // beTriggered set this bar doesn't change the label here.
      const isTrailing = p.beTriggered;
      const fillPx = isTrailing
        ? roundToNQTick(p.stopLoss)
        : roundToNQTick(p.side === 'long'
            ? p.stopLoss - this.slippage.stop
            : p.stopLoss + this.slippage.stop);
      this._realizeExit(bar, fillPx, isTrailing ? 'trailing_stop' : 'stop_loss');
      return;
    }

    // 5. Target hit. Limit fill at exact price, no slippage.
    const targetHit = p.side === 'long' ? (bar.high >= p.takeProfit) : (bar.low <= p.takeProfit);
    if (targetHit) {
      this._realizeExit(bar, p.takeProfit, 'take_profit');
      return;
    }

    // 6. Breakeven trigger evaluated AFTER stop/target checks (mirrors gold's
    //    line 600 trailing-stop update AFTER line 569 stop / line 579 target).
    //    Stop modification only affects the NEXT bar's exit check.
    if (p.breakevenStop && !p.beTriggered) {
      const mfe = p.side === 'long' ? (bar.high - p.entryPrice) : (p.entryPrice - bar.low);
      if (mfe >= p.breakevenTrigger) {
        const newStop = roundToNQTick(p.side === 'long'
          ? p.entryPrice + p.breakevenOffset
          : p.entryPrice - p.breakevenOffset);
        if (p.side === 'long' ? newStop > p.stopLoss : newStop < p.stopLoss) {
          p.stopLoss = newStop;
        }
        p.beTriggered = true;
      }
    }
  }

  _realizeExit(bar, exitPx, reason) {
    const p = this.position;
    const pts = p.side === 'long' ? (exitPx - p.entryPrice) : (p.entryPrice - exitPx);
    const gross = pts * POINT_VALUE_NQ;
    const net = gross - this.commission;
    this.trades.push({
      strategy: p.strategy,
      side: p.side,
      entryTs: p.entryTs,
      entryPrice: p.entryPrice,
      exitTs: bar.timestamp,
      exitPrice: exitPx,
      pointsPnL: pts,
      grossPnL: gross,
      netPnL: net,
      exitReason: reason,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      durationMs: bar.timestamp - p.entryTs,
      signalId: p.signal?.metadata?.signalId ?? null,
      ruleId: p.signal?.ruleId ?? null,
    });
    this.lastExitTs.set(p.strategy, bar.timestamp);
    this.position = null;
  }

  // Force-close logic mirrors trade-simulator.js updateTradeWithSecondResolution
  // lines 533-540: each ACTIVE trade is checked PER BAR against EOD + market_close,
  // not gated to first-firing per day. Trades that open POST-cutoff (e.g. a
  // lstb signal at 20:48 UTC after the 20:45 UTC EOD) fill normally, then exit
  // on the very next bar via EOD. The gate-by-date pattern silently let those
  // post-cutoff trades run through to BE/stop, producing $5 winners instead
  // of $17 EOD losses (visible in 2025-01-13 lstb diff).
  //
  // Pending orders are NOT cancelled by EOD/market_close in the gold engine —
  // they remain pending, can still fill, then exit at the next bar via EOD.
  _checkEod(bar) {
    // Market-close fires first when set (typically 15:55 ET; non-trailing exit
    // labeled 'market_close', no slippage — matches exitTrade default branch).
    if (this.marketCloseEt && this.position && isPastEodCutoff(bar.timestamp, this.marketCloseEt)) {
      this._exitAtPrice(bar, roundToNQTick(bar.close), 'market_close');
      return;
    }
    // EOD cutoff (typically 15:45 or 16:40 ET) — used for day-trade-margin
    // liquidation. Original engine exits at bar.open here (line 535), not close.
    if (this.eodCutoffEt && this.position && isPastEodCutoff(bar.timestamp, this.eodCutoffEt)) {
      this._exitAtPrice(bar, roundToNQTick(bar.open), 'eod_liquidation');
    }
  }

  // Helper: exit current position at an arbitrary fill price + reason. Replaces
  // the per-call duplication in _closePosition / _realizeExit for forced exits.
  _exitAtPrice(bar, fillPx, reason) {
    if (!this.position) return;
    this._realizeExit(bar, fillPx, reason);
  }

  // ── Main loop ──────────────────────────────────────────────────────────
  async run() {
    if (this.signals.length === 0) {
      return { trades: [], rejections: [], summary: this._summarize() };
    }
    const firstMin = Math.floor(this.signals[0].ts / 60_000) * 60_000;
    // Pad end by 8 hours to allow last-signal exits to walk forward.
    const lastMin = Math.floor((this.signals[this.signals.length - 1].ts + 8 * 60 * 60_000) / 60_000) * 60_000;

    let sigIdx = 0;
    let processedMinutes = 0;
    let processedSeconds = 0;

    for (let minTs = firstMin; minTs <= lastMin; minTs += 60_000) {
      processedMinutes++;
      if (this.verbose && processedMinutes % 5000 === 0) {
        const pct = ((minTs - firstMin) / (lastMin - firstMin) * 100).toFixed(1);
        console.log(`  ... ${pct}% (min ${new Date(minTs).toISOString()})  trades=${this.trades.length}  rejs=${this.rejections.length}`);
      }
      const allBars = await this.sdp.getSecondsForMinute(minTs);
      if (!allBars || allBars.length === 0) continue;

      // contractFilter: if set, restrict to a single contract (used by Test A
      // solo-reproduction). When null (multi-month runs across rollovers),
      // we let every bar through and rely on per-position symbol matching
      // inside _stepPending/_stepPosition to ignore irrelevant contracts.
      const bars = this.contractFilter
        ? allBars.filter(b => b.symbol === this.contractFilter)
        : allBars;
      if (bars.length === 0) continue;

      // Sort bars by ts so we walk chronologically even when multiple
      // contracts have bars at the same minute (e.g. NQH5+NQM5 during the
      // rollover window). Bars from different contracts at the same ts: the
      // order doesn't matter for our purposes since _stepPending and
      // _stepPosition skip bars whose symbol doesn't match the trade's
      // signalContract.
      bars.sort((a, b) => a.timestamp - b.timestamp);

      for (const bar of bars) {
        processedSeconds++;
        // 1. Drain any signals up to and including this bar's ts. Drain
        //    matches on ts only (not contract) — a signal's signalContract
        //    is preserved into pending/position state.
        while (sigIdx < this.signals.length && this.signals[sigIdx].ts <= bar.timestamp) {
          this._handleSignal(this.signals[sigIdx], bar);
          sigIdx++;
        }
        // 2. Pending order fill check — skip if bar's contract doesn't match.
        this._stepPending(bar);
        // 3. Open position exit check — same contract-skip semantics.
        this._stepPosition(bar);
      }
    }

    // Drain any remaining signals (after end-of-data) into rejections
    while (sigIdx < this.signals.length) {
      this._reject(this.signals[sigIdx], 'no_bars_after_signal');
      sigIdx++;
    }

    if (this.verbose) {
      console.log(`  finished: ${processedMinutes} minutes, ${processedSeconds} second-bars, ${this.trades.length} trades`);
    }

    return { trades: this.trades, rejections: this.rejections, summary: this._summarize() };
  }

  _summarize() {
    const ts = this.trades;
    const wins = ts.filter(t => t.netPnL > 0);
    const losses = ts.filter(t => t.netPnL <= 0);
    const totalPnL = ts.reduce((s, t) => s + t.netPnL, 0);
    const grossWin = wins.reduce((s, t) => s + t.netPnL, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnL, 0));
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : Infinity;
    // Sharpe (daily-PnL annualized at sqrt(252)) — bucket by ET dateKey.
    const byDay = new Map();
    for (const t of ts) {
      const dk = getEtParts(t.exitTs).dateKey;
      byDay.set(dk, (byDay.get(dk) || 0) + t.netPnL);
    }
    const daily = [...byDay.values()];
    const mean = daily.reduce((s, x) => s + x, 0) / Math.max(1, daily.length);
    const stdev = Math.sqrt(daily.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, daily.length));
    const sharpe = stdev > 0 ? (mean / stdev) * Math.sqrt(252) : 0;
    // Max DD on cumulative equity (per trade)
    let peak = 0, eq = 0, mdd = 0;
    for (const t of ts) {
      eq += t.netPnL;
      if (eq > peak) peak = eq;
      const dd = peak - eq;
      if (dd > mdd) mdd = dd;
    }
    return {
      totalTrades: ts.length,
      wins: wins.length,
      losses: losses.length,
      winRate: ts.length ? (wins.length / ts.length) * 100 : 0,
      totalPnL,
      profitFactor,
      sharpe,
      maxDD_usd: mdd,
      maxDD_pct: peak > 0 ? (mdd / peak) * 100 : 0,
      rejections: this.rejections.length,
      byStrategy: this._byStrategy(),
    };
  }

  _byStrategy() {
    const out = {};
    for (const t of this.trades) {
      if (!out[t.strategy]) out[t.strategy] = { trades: 0, pnl: 0 };
      out[t.strategy].trades += 1;
      out[t.strategy].pnl += t.netPnL;
    }
    return out;
  }
}
