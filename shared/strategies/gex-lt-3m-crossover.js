/**
 * GEX × LT 3-min Crossover Strategy (gex-lt-3m-crossover)
 *
 * Detects sign flips of (gex_level − lt_level) at 3-minute snapshot
 * boundaries between 13 GEX levels (call_wall, put_wall, gamma_flip,
 * R1-R5, S1-S5) and 5 LT_1m levels — a 65-pair grid. When a configured
 * (gex_type, direction) pair crosses, a rule fires with per-rule
 * stop/target derived from Track E4's MFE/MAE distributions.
 *
 * Solo / confirmed filter: some rules require NO same-direction 15m
 * crossover in the past 30 min ("solo"). Others require ANY same-direction
 * 15m crossover in the past 30 min ("confirmed"). Past-only check, not
 * ±window — the strategy must be live-tradable.
 *
 * Aliasing: call_wall ≡ R1 and put_wall ≡ S1 always. The rules treat them
 * as one logical setup (rule fires on `call_wall` matches `R1` matches).
 *
 * Per Track E4 (TRACK-E4-FINDINGS.md, 2026-05-07):
 *   Idealized 16-month opportunity: ~84,000 pts on 1 NQ contract.
 *   Realistic post-execution: $420-670k.
 *
 * Engine integration notes (per memory/gex-flip-ivpct-strategy.md):
 *   - Engine increments barsSinceEntry per 1-minute candle regardless of
 *     timeframe → maxHoldBars is in MINUTES.
 *   - Use `--timeframe 1m --raw-contracts --gex-dir data/gex/nq-cbbo
 *     --lt-1m-file …` for parity. The strategy gates internally on 3m
 *     boundaries.
 *   - --eod-cutoff-et 16:40 should still be used to avoid overnight risk.
 */

import { BaseStrategy } from './base-strategy.js';

// ──────────────────────────────────────────────────────────────────────────
// Rule whitelist from Track E4 sweep (TRACK-E4-FINDINGS.md)
// Each rule fires when:
//   - gex_type matches the rule's gex_type AND
//   - crossover direction matches the rule's direction AND
//   - filter condition is satisfied (solo/confirmed/any against 15m feed)
// Stop/target are in NQ points, applied symmetrically based on side.
// ──────────────────────────────────────────────────────────────────────────
const RULES = [
  // Long rules (gex_above_lt = GEX support level rose above LT level)
  { id: 'L_S3',      side: 'long',  gexType: 'S3',        direction: 'gex_above_lt', filter: 'confirmed', stopPts: 50, targetPts: 80, priority: 90 },
  { id: 'L_S4',      side: 'long',  gexType: 'S4',        direction: 'gex_above_lt', filter: 'confirmed', stopPts: 50, targetPts: 80, priority: 90 },
  { id: 'L_S5_SOLO', side: 'long',  gexType: 'S5',        direction: 'gex_above_lt', filter: 'solo',      stopPts: 50, targetPts: 60, priority: 100 },
  { id: 'L_PW',      side: 'long',  gexType: 'put_wall',  direction: 'gex_above_lt', filter: 'confirmed', stopPts: 10, targetPts: 80, priority: 80 },

  // Short rules (gex_below_lt = GEX resistance level dropped below LT level)
  { id: 'S_CW',      side: 'short', gexType: 'call_wall', direction: 'gex_below_lt', filter: 'confirmed', stopPts: 50, targetPts: 80, priority: 100 },
  { id: 'S_R3',      side: 'short', gexType: 'R3',        direction: 'gex_below_lt', filter: 'confirmed', stopPts: 50, targetPts: 80, priority: 90 },
  { id: 'S_R4',      side: 'short', gexType: 'R4',        direction: 'gex_below_lt', filter: 'confirmed', stopPts: 50, targetPts: 80, priority: 90 },
  { id: 'S_R5',      side: 'short', gexType: 'R5',        direction: 'gex_below_lt', filter: 'confirmed', stopPts: 40, targetPts: 60, priority: 80 },
  { id: 'S_GF_SOLO', side: 'short', gexType: 'gamma_flip', direction: 'gex_below_lt', filter: 'solo',     stopPts: 50, targetPts: 60, priority: 100 },
  { id: 'S_S2_SOLO', side: 'short', gexType: 'S2',        direction: 'gex_below_lt', filter: 'solo',      stopPts: 40, targetPts: 60, priority: 80 },
  { id: 'S_PW_SOLO', side: 'short', gexType: 'put_wall',  direction: 'gex_below_lt', filter: 'solo',      stopPts: 50, targetPts: 50, priority: 70 },
];

// gex_type → array of equivalent aliases (call_wall ≡ R1, put_wall ≡ S1)
function expandAliases(type) {
  if (type === 'call_wall' || type === 'R1') return ['call_wall', 'R1'];
  if (type === 'put_wall' || type === 'S1') return ['put_wall', 'S1'];
  return [type];
}

const THREE_MIN_MS = 3 * 60 * 1000;
const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const HALF_HOUR_MS = 30 * 60 * 1000;

export class GexLt3mCrossoverStrategy extends BaseStrategy {
  static getDataRequirements() {
    return {
      candles: { baseSymbol: 'NQ', quoteSymbols: ['CME_MINI:NQ1!'] },
      gex: { etfSymbol: 'QQQ', futuresSymbol: 'NQ', defaultMultiplier: 41.5 },
      lt: true,        // 15m LT (existing feed)
      lt1m: true,      // 1m LT (new requirement; engine reads --lt-1m-file)
      tradier: false,
      ivSkew: false,
    };
  }

  constructor(params = {}) {
    super(params);

    this.params.tradingSymbol = params.tradingSymbol ?? 'NQ';
    this.params.defaultQuantity = params.defaultQuantity ?? 1;

    // No cooldown by default — the strategy already has 1-position-at-a-time
    // concurrency and a 5-min limit timeout, which together provide enough
    // friction. Adding a cooldown blocked legitimate signals from independent
    // (gex_type × lt_idx) pairs and reduced Sharpe from 2.95 → 2.76.
    // Set via --glx-cooldown-ms if a specific config wants one.
    this.params.signalCooldownMs = params.signalCooldownMs ?? 0;

    // Max hold in MINUTES (engine counts barsSinceEntry per 1m candle)
    this.params.maxHoldBars = params.maxHoldBars ?? 60;

    // 15m-confirmed window for solo/confirmed filter (past-only)
    this.params.confirmWindowMs = params.confirmWindowMs ?? HALF_HOUR_MS;

    // Entry window (ET, half-open). Default = W12 gold-standard window
    // 7:00-16:00 ET, which empirically captures the strong 8am pre-market
    // hour and the morning RTH session while excluding overnight/after-close
    // hours that have negative expectancy. Override via --glx-entry-window
    // or --glx-no-entry-window to test other ranges.
    this.params.entryWindowStartHour = params.entryWindowStartHour ?? 7;
    this.params.entryWindowEndHour = params.entryWindowEndHour ?? 16;
    this.params.entryWindowStartMinute = params.entryWindowStartMinute ?? 0;
    this.params.disableEntryWindow = params.disableEntryWindow ?? false;
    // Default to skipping 13:00 ET (lunch hour) — consistently the worst
    // hour in the per-hour PnL breakdown across rules. Pass --glx-blocked-hours
    // with a different list (or empty) to override.
    this.params.blockedHoursEt = new Set(
      params.blockedHoursEt !== undefined ? params.blockedHoursEt : [13]
    );

    this.params.debug = params.debug ?? false;

    // W12 gold-standard rule set: drops the 7 PF<1.0 rules (re-enable any
    // by passing --glx-disable-rules with a custom list). Rule-defined
    // solo/confirmed filters dropped by default (force-any) — empirically
    // they reduced Sharpe from 5.62 → 4.69. Per-rule TP/SL/maxHold tuned
    // against engine MFE/MAE distributions, not research's biased grid.
    this.params.forceFilterAny = params.forceFilterAny ?? true;
    const DEFAULT_DISABLED_RULES = [
      'L_S3', 'L_S5_SOLO', 'L_PW', 'S_S2_SOLO',
      'S_R3', 'S_R5', 'S_PW_SOLO',
    ];
    this.params.disabledRules = new Set(
      params.disabledRules !== undefined ? params.disabledRules : DEFAULT_DISABLED_RULES
    );
    const DEFAULT_RULE_OVERRIDES = {
      L_S4:      { targetPts: 120, maxHoldBars: 90 },
      S_GF_SOLO: {                  maxHoldBars: 90 },
      // S_CW: huge edge in the morning (PF 2.08, +$48k Jan'25-Apr'26) but
      // catastrophic in afternoon (PF 0.29, -$10.5k on 25 trades, WR 32%).
      // Block it 14:00-15:59 ET specifically — the other 3 rules continue
      // to trade afternoon where they're more efficient than morning.
      S_CW:      { targetPts: 120, maxHoldBars: 90, blockedHoursEt: [14, 15] },
      // S_R4 keeps research defaults (TP=80, mh=60). TP=120 hurts it
      // (ran $5k vs $10k) — its breakdown plays out faster than longs.
    };
    this.params.ruleOverrides = params.ruleOverrides ?? DEFAULT_RULE_OVERRIDES;

    // How many 1m candles to wait for a limit fill before cancelling.
    // Default 5: gives price 5 minutes to retrace to the signal candle's
    // close. If it never retraces, the signal is "running away" — skip it.
    this.params.limitTimeoutCandles = params.limitTimeoutCandles ?? 5;

    // Trailing stop (universal, applied to every rule unless explicitly
    // disabled per-rule via ruleOverrides). Engine ratchets the stop:
    // once MFE >= trailingTrigger, stop moves to (entry +/- (MFE - trailingOffset)).
    // Set both to 0/null to disable (default).
    this.params.trailingTrigger = params.trailingTrigger ?? 0;
    this.params.trailingOffset = params.trailingOffset ?? 0;

    // Breakeven stop (orthogonal to trailing — can layer them). Once
    // MFE >= breakevenTrigger, stop moves to (entry +/- breakevenOffset),
    // locking in `breakevenOffset` points of profit. Set to 0 to disable.
    this.params.breakevenTrigger = params.breakevenTrigger ?? 0;
    this.params.breakevenOffset = params.breakevenOffset ?? 0;

    // LS-BE-on-flip overlay (research/ls-overlay, 2026-05-19). When enabled,
    // the trade-orchestrator arms a breakeven stop on the first adverse LS
    // flip during the trade. Phase 5 winner for gex-lt-3m: BE_1m only (no
    // entry filter) → $179k → $274k, PF 1.44 → 1.87, DD 4.55% → 2.08%.
    this.params.lsBeOnFlip = params.lsBeOnFlip ?? false;
    this.params.lsBeOffset = params.lsBeOffset ?? 0;

    // Mirror of trade-orchestrator's EOD_CUTOFF_ET — purely for the panel
    // (the strategy doesn't enforce EOD itself).
    this.params.eodCutoffEt = params.eodCutoffEt ?? '16:40';

    // ──────────────────────────────────────────────────────────────────
    // Internal state
    // ──────────────────────────────────────────────────────────────────
    // Pair-sign tracking — one map per timeframe.
    // Key = `${gexType}|${ltIdx}` → { sign: -1|0|1, ts, lastFlipTs }
    this.prev3mSigns = new Map();
    this.prev15mSigns = new Map();

    // Rolling history of recent 15m crossovers (for solo/confirmed filter).
    // Each entry: { ts, gexType, ltIdx, direction }. Pruned to past 30 min.
    this.recent15mCrossovers = [];

    // For boundary detection
    this.lastProcessed3mBucket = null;   // floor(ts / 3min)
    this.lastProcessed15mBucket = null;  // floor(ts / 15min)

    // Live snapshots captured each evaluation — used by getInternalState
    // to render the dashboard panel's pair-sign grid.
    this.lastGexLevels = null;   // [{ type, price }]
    this.lastLt1m = null;         // [p1, p2, p3, p4, p5]
    this.lastUpdateTs = null;

    // Per-3m-boundary evaluation log: last ~15 boundaries with the flips
    // detected and whether any rule fired (and why if blocked).
    this.evaluationLog = [];
  }

  reset() {
    super.reset();
    this.prev3mSigns.clear();
    this.prev15mSigns.clear();
    this.recent15mCrossovers = [];
    this.lastProcessed3mBucket = null;
    this.lastProcessed15mBucket = null;
    this.lastGexLevels = null;
    this.lastLt1m = null;
    this.lastUpdateTs = null;
    this.evaluationLog = [];
  }

  // ────────────────────────────────────────────────────────────────────────
  // Helpers — extract level list from a GEX snapshot
  // Returns [{ type, price }]
  // ────────────────────────────────────────────────────────────────────────
  _gexLevels(g) {
    const out = [];
    if (!g) return out;

    // Snapshots from cbbo loader use snake_case; live exposure-calc uses camelCase.
    const cw = g.call_wall ?? g.callWall;
    const pw = g.put_wall ?? g.putWall;
    const gf = g.gamma_flip ?? g.gammaFlip;
    if (cw != null) out.push({ type: 'call_wall', price: cw });
    if (pw != null) out.push({ type: 'put_wall', price: pw });
    if (gf != null) out.push({ type: 'gamma_flip', price: gf });

    const resistance = g.resistance || [];
    for (let i = 0; i < resistance.length; i++) {
      if (resistance[i] != null) out.push({ type: `R${i + 1}`, price: resistance[i] });
    }
    const support = g.support || [];
    for (let i = 0; i < support.length; i++) {
      if (support[i] != null) out.push({ type: `S${i + 1}`, price: support[i] });
    }
    return out;
  }

  _ltLevelsArray(lt) {
    if (!lt) return null;
    const arr = [
      lt.level_1, lt.level_2, lt.level_3, lt.level_4, lt.level_5,
    ].map(v => (v == null || isNaN(v)) ? null : v);
    if (arr.every(v => v == null)) return null;
    return arr;
  }

  // ────────────────────────────────────────────────────────────────────────
  // 15m crossover tracking — runs at 15m boundaries.
  // Updates prev15mSigns and pushes flips into recent15mCrossovers.
  // ────────────────────────────────────────────────────────────────────────
  _update15mSigns(ts, gexLevels, lt15m) {
    // Prune recent buffer
    const cutoff = ts - this.params.confirmWindowMs;
    while (this.recent15mCrossovers.length && this.recent15mCrossovers[0].ts < cutoff) {
      this.recent15mCrossovers.shift();
    }

    if (!gexLevels.length || !lt15m) return;

    for (const g of gexLevels) {
      for (let li = 0; li < lt15m.length; li++) {
        const ltP = lt15m[li];
        if (ltP == null) continue;
        const diff = g.price - ltP;
        const sign = diff > 0 ? 1 : diff < 0 ? -1 : 0;
        const key = `${g.type}|${li}`;
        const prev = this.prev15mSigns.get(key);
        if (prev && prev.sign !== 0 && sign !== 0 && prev.sign !== sign) {
          const direction = sign > 0 ? 'gex_above_lt' : 'gex_below_lt';
          this.recent15mCrossovers.push({ ts, gexType: g.type, ltIdx: li, direction });
        }
        this.prev15mSigns.set(key, { sign, ts });
      }
    }
  }

  // Solo filter: returns TRUE if NO same-direction 15m crossover for the
  // canonical gex_type (with aliases) in the past confirmWindowMs.
  // Confirmed filter: returns TRUE if there IS such a crossover.
  _evaluateFilter(filter, gexType, direction, nowTs) {
    const aliases = expandAliases(gexType);
    const cutoff = nowTs - this.params.confirmWindowMs;
    let found = false;
    for (const ev of this.recent15mCrossovers) {
      if (ev.ts < cutoff) continue;
      if (ev.direction !== direction) continue;
      if (aliases.includes(ev.gexType)) { found = true; break; }
    }
    if (this.params.forceFilterAny) return true;
    if (filter === 'solo') return !found;
    if (filter === 'confirmed') return found;
    return true; // any/no filter
  }

  _resolvedRule(rule) {
    const o = this.params.ruleOverrides?.[rule.id];
    if (!o) return rule;
    return {
      ...rule,
      stopPts: o.stopPts ?? rule.stopPts,
      targetPts: o.targetPts ?? rule.targetPts,
      priority: o.priority ?? rule.priority,
      filter: o.filter ?? rule.filter,
      maxHoldBars: o.maxHoldBars ?? rule.maxHoldBars,
      trailingTrigger: o.trailingTrigger ?? rule.trailingTrigger,
      trailingOffset: o.trailingOffset ?? rule.trailingOffset,
      breakevenTrigger: o.breakevenTrigger ?? rule.breakevenTrigger,
      breakevenOffset: o.breakevenOffset ?? rule.breakevenOffset,
      // Per-rule time-of-day exclusion. Array of ET hours (0-23) during which
      // the rule will be skipped at the matching step (whole-strategy
      // `blockedHoursEt` still applies on top). null = no per-rule block.
      blockedHoursEt: o.blockedHoursEt ?? rule.blockedHoursEt ?? null,
    };
  }

  _isInEntryWindow(et) {
    if (this.params.blockedHoursEt.has(et.hour)) return false;
    if (this.params.disableEntryWindow) return true;
    // et = { hour, minute, timeInMinutes }
    const startMin = this.params.entryWindowStartHour * 60 + this.params.entryWindowStartMinute;
    const endMin = this.params.entryWindowEndHour * 60;
    return et.timeInMinutes >= startMin && et.timeInMinutes < endMin;
  }

  _toEt(ts) {
    // Lightweight ET conversion using Intl. We only need hour/minute.
    const d = new Date(ts);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour12: false,
      hour: '2-digit', minute: '2-digit',
    }).formatToParts(d);
    const hh = parts.find(p => p.type === 'hour')?.value || '0';
    const mm = parts.find(p => p.type === 'minute')?.value || '0';
    const hour = parseInt(hh, 10) % 24;  // Intl returns 24 for midnight in some locales
    const minute = parseInt(mm, 10);
    return { hour, minute, timeInMinutes: hour * 60 + minute };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Main evaluation — called per 1m candle by the engine
  // ────────────────────────────────────────────────────────────────────────
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const ts = this.toMs(candle.timestamp);

    const gexLevels = this._gexLevels(marketData?.gexLevels);
    const lt1m = this._ltLevelsArray(marketData?.ltLevels1m);
    const lt15m = this._ltLevelsArray(marketData?.ltLevels);

    // Capture snapshots for the panel even when we early-return below —
    // the panel still wants to show the latest grid state.
    if (gexLevels.length) this.lastGexLevels = gexLevels;
    if (lt1m) this.lastLt1m = lt1m;
    this.lastUpdateTs = ts;

    if (!gexLevels.length || !lt1m) return null;

    // ────────────────────────────────────────────────────────────────
    // ALWAYS update 15m sign history at 15m boundaries (UTC-aligned)
    // — runs even during cooldown / outside entry window so signs
    // stay current and don't produce spurious post-cooldown crossovers.
    // ────────────────────────────────────────────────────────────────
    const bucket15m = Math.floor(ts / FIFTEEN_MIN_MS);
    if (this.lastProcessed15mBucket !== bucket15m && lt15m) {
      this._update15mSigns(ts, gexLevels, lt15m);
      this.lastProcessed15mBucket = bucket15m;
    }

    // ────────────────────────────────────────────────────────────────
    // 3m boundary check — only update sign state once per bucket
    // ────────────────────────────────────────────────────────────────
    const bucket3m = Math.floor(ts / THREE_MIN_MS);
    if (this.lastProcessed3mBucket === bucket3m) return null;

    // Gather flips for this 3m boundary AND update prev3mSigns
    // unconditionally so cooldowns / off-hours don't desync state.
    const flips = [];
    for (const g of gexLevels) {
      for (let li = 0; li < lt1m.length; li++) {
        const ltP = lt1m[li];
        if (ltP == null) continue;
        const diff = g.price - ltP;
        const sign = diff > 0 ? 1 : diff < 0 ? -1 : 0;
        const key = `${g.type}|${li}`;
        const prev = this.prev3mSigns.get(key);
        const flipped = !!(prev && prev.sign !== 0 && sign !== 0 && prev.sign !== sign);
        if (flipped) {
          const direction = sign > 0 ? 'gex_above_lt' : 'gex_below_lt';
          flips.push({ gexType: g.type, ltIdx: li, direction, gexPrice: g.price, ltPrice: ltP });
        }
        this.prev3mSigns.set(key, {
          sign,
          ts,
          lastFlipTs: flipped ? ts : (prev?.lastFlipTs ?? null),
        });
      }
    }
    this.lastProcessed3mBucket = bucket3m;

    // ────────────────────────────────────────────────────────────────
    // Now gate signal generation. Sign state above is up-to-date.
    // ────────────────────────────────────────────────────────────────
    const inCooldown = !this.checkCooldown(ts, this.params.signalCooldownMs);
    const et = this._toEt(ts);
    const inWindow = this._isInEntryWindow(et);

    if (inCooldown) { this._logEval(candle, flips, null, 'cooldown'); return null; }
    if (!inWindow) { this._logEval(candle, flips, null, 'outside_window'); return null; }
    if (!flips.length) { this._logEval(candle, flips, null, 'no_flip'); return null; }

    // ────────────────────────────────────────────────────────────────
    // Match flips to rules; pick highest-priority firing rule
    // ────────────────────────────────────────────────────────────────
    let best = null;
    let filterFailedRule = null;
    let perRuleBlockedRule = null;
    for (const f of flips) {
      const fAliases = expandAliases(f.gexType);
      for (const baseRule of RULES) {
        if (this.params.disabledRules.has(baseRule.id)) continue;
        const rule = this._resolvedRule(baseRule);
        if (rule.direction !== f.direction) continue;
        const ruleAliases = expandAliases(rule.gexType);
        const match = ruleAliases.some(a => fAliases.includes(a));
        if (!match) continue;
        // Per-rule time-of-day exclusion (e.g. S_CW blocked 14:00-15:59 ET)
        if (Array.isArray(rule.blockedHoursEt) && rule.blockedHoursEt.includes(et.hour)) {
          perRuleBlockedRule = rule.id;
          continue;
        }
        if (!this._evaluateFilter(rule.filter, f.gexType, f.direction, ts)) {
          filterFailedRule = rule.id;
          continue;
        }
        if (!best || rule.priority > best.rule.priority) {
          best = { rule, flip: f };
        }
      }
    }

    if (!best) {
      const reason = perRuleBlockedRule
        ? `rule_hour_blocked:${perRuleBlockedRule}`
        : (filterFailedRule ? `filter_failed:${filterFailedRule}` : 'no_rule_match');
      this._logEval(candle, flips, null, reason);
      return null;
    }
    this._logEval(candle, flips, best, null);
    return this._createSignal(best, candle);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Evaluation logger — captures every 3m boundary where flips were checked
  // ────────────────────────────────────────────────────────────────────────
  _logEval(candle, flips, best, blockedReason) {
    const ts = this.toMs(candle.timestamp);
    const time = new Date(ts).toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    this.evaluationLog.push({
      ts,
      time,
      price: candle.close,
      flipCount: flips.length,
      flips: flips.slice(0, 5).map(f => `${f.gexType}|L${f.ltIdx + 1}${f.direction === 'gex_above_lt' ? '↑' : '↓'}`),
      fired: !!best,
      ruleId: best?.rule?.id ?? null,
      side: best?.rule?.side ?? null,
      blockedReason,
    });
    if (this.evaluationLog.length > 15) {
      this.evaluationLog = this.evaluationLog.slice(-15);
    }
  }

  _createSignal(best, candle) {
    const ts = this.toMs(candle.timestamp);
    this.updateLastSignalTime(ts);

    const { rule, flip } = best;
    const entryPrice = candle.close;
    const sign = rule.side === 'long' ? 1 : -1;
    const stopLoss = entryPrice - sign * rule.stopPts;
    const takeProfit = entryPrice + sign * rule.targetPts;

    if (this.params.debug) {
      console.log(`[GEX-LT-3M] ${rule.id} ${rule.side.toUpperCase()} @ ${entryPrice.toFixed(2)} ` +
        `flip=${flip.gexType}|LT${flip.ltIdx + 1} (${flip.direction}) ` +
        `stop=${stopLoss.toFixed(2)} tgt=${takeProfit.toFixed(2)}`);
    }

    const signal = {
      timestamp: ts,
      side: rule.side,
      price: entryPrice,
      strategy: 'GEX_LT_3M_CROSSOVER',
      // Limit at signal candle's close — fills at exactly that price (zero
      // slippage) when price retraces. If price runs away from the limit
      // for `limitTimeoutCandles` 1m candles without ever retracing, the
      // order expires unfilled. This is a quality filter: we only enter
      // trades where price gives us our price.
      action: 'place_limit',
      timeoutCandles: this.params.limitTimeoutCandles,
      symbol: this.params.tradingSymbol,
      quantity: this.params.defaultQuantity,
      stopLoss,
      takeProfit,
      maxHoldBars: rule.maxHoldBars ?? this.params.maxHoldBars,

      // Rule metadata
      ruleId: rule.id,
      ruleFilter: rule.filter,
      gexType: flip.gexType,
      ltIdx: flip.ltIdx,
      direction: flip.direction,
      gexPrice: flip.gexPrice,
      ltPrice: flip.ltPrice,
      stopPoints: rule.stopPts,
      targetPoints: rule.targetPts,

      stop_loss: stopLoss,
      take_profit: takeProfit,
    };

    // Trailing stop (engine ratchets stop once MFE >= trigger).
    const ttRaw = rule.trailingTrigger ?? this.params.trailingTrigger;
    const toRaw = rule.trailingOffset ?? this.params.trailingOffset;
    if (ttRaw && toRaw) {
      signal.trailingTrigger = ttRaw;
      signal.trailingOffset = toRaw;
    }

    // Breakeven stop (engine moves stop to entry + offset once MFE >= trigger).
    const beTrig = rule.breakevenTrigger ?? this.params.breakevenTrigger;
    const beOff = rule.breakevenOffset ?? this.params.breakevenOffset;
    if (beTrig) {
      signal.breakevenStop = true;
      signal.breakevenTrigger = beTrig;
      signal.breakevenOffset = beOff;
    }

    // LS-BE-on-flip (orchestrator-side; independent of structural BE above).
    if (this.params.lsBeOnFlip) {
      signal.lsBeOnFlip = true;
      signal.lsBeOffset = this.params.lsBeOffset;
    }

    return signal;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Cooldown anchored to exit (matches gex-flip-ivpct convention)
  // ────────────────────────────────────────────────────────────────────────
  onPositionClosed(info) {
    if (info && info.timestamp) {
      this.lastSignalTime = this.toMs(info.timestamp);
    }
  }

  getName() {
    return 'GEX_LT_3M_CROSSOVER';
  }

  getInternalState() {
    // Active rules (after disabledRules filter + per-rule overrides applied).
    // Sorted by priority desc so the panel shows highest-priority rules first.
    const activeRules = RULES
      .filter(r => !this.params.disabledRules.has(r.id))
      .map(r => this._resolvedRule(r))
      .sort((a, b) => b.priority - a.priority)
      .map(r => ({
        id: r.id,
        side: r.side,
        gexType: r.gexType,
        direction: r.direction,
        filter: r.filter,
        stopPts: r.stopPts,
        targetPts: r.targetPts,
        maxHoldBars: r.maxHoldBars ?? this.params.maxHoldBars,
        priority: r.priority,
        blockedHoursEt: r.blockedHoursEt ?? null,
      }));

    // Per-active-rule pair grid: 5 cells per rule (one per LT level).
    // Each cell carries the current sign + the last-known gex price /
    // lt price + lastFlipTs so the panel can render diff and time-since-flip.
    const pairGrid = activeRules.map(rule => {
      const aliases = expandAliases(rule.gexType);
      // Pick the gex level whose type matches (or its alias)
      const gx = (this.lastGexLevels || []).find(g => aliases.includes(g.type));
      const cells = [];
      for (let li = 0; li < 5; li++) {
        const key = `${rule.gexType}|${li}`;
        // For alias rules, the strategy actually tracks signs under BOTH
        // canonical names (call_wall and R1). Use either-or for display.
        let state = this.prev3mSigns.get(key);
        if (!state) {
          for (const a of aliases) {
            state = this.prev3mSigns.get(`${a}|${li}`);
            if (state) break;
          }
        }
        const ltPrice = this.lastLt1m?.[li] ?? null;
        const gexPrice = gx?.price ?? null;
        const diff = (gexPrice != null && ltPrice != null) ? gexPrice - ltPrice : null;
        cells.push({
          ltIdx: li,
          ltPrice,
          gexPrice,
          diff,
          sign: state?.sign ?? 0,
          lastFlipTs: state?.lastFlipTs ?? null,
        });
      }
      return { ruleId: rule.id, cells };
    });

    return {
      // Config (for panel rendering)
      maxHoldBars: this.params.maxHoldBars,
      signalCooldownMs: this.params.signalCooldownMs,
      confirmWindowMs: this.params.confirmWindowMs,
      entryWindowStartHour: this.params.entryWindowStartHour,
      entryWindowEndHour: this.params.entryWindowEndHour,
      blockedHoursEt: Array.from(this.params.blockedHoursEt),
      limitTimeoutCandles: this.params.limitTimeoutCandles,
      forceFilterAny: this.params.forceFilterAny,
      eodCutoffEt: this.params.eodCutoffEt,
      disabledRules: Array.from(this.params.disabledRules),

      // Snapshots
      lastUpdateTs: this.lastUpdateTs,
      gexLevelsSnapshot: this.lastGexLevels,
      lt1mSnapshot: this.lastLt1m,

      // Live state
      activeRules,
      pairGrid,
      recent15mCrossovers: this.recent15mCrossovers.length,
      tracked3mPairs: this.prev3mSigns.size,
      tracked15mPairs: this.prev15mSigns.size,
      evaluationLog: this.evaluationLog.slice(-10),
    };
  }
}

export default GexLt3mCrossoverStrategy;
