/**
 * GEX-FLIP-IVPCT Strategy
 *
 * A 6-rule, day-trade-friendly multi-edge strategy. Combines GEX walls
 * (call/put wall proximity), gamma-flip side, regime classification, IV
 * percentile (rolling 20 calendar days), and skew sign into priority-ordered
 * entry rules. Each rule has its own MFE/MAE-derived stop and target.
 *
 * Origin: Phase 2 multi-edge research, variant V7DTSP13. The strategy is
 * intentionally restricted to entries between 04:00 and 13:00 ET to match
 * the user's day-trade margin window — broker liquidates open positions at
 * 4:45 PM ET, so morning-only entries leave room for targets to fill.
 *
 * Components in the name:
 *   GEX  — call/put wall proximity + regime + total gamma side
 *   FLIP — gamma flip (above vs below)
 *   IVPCT — rolling 20d IV percentile (low IV = drift longs; high IV = mean-revert shorts)
 *
 * Reference standalone results (V7DTSP13, Jan 2025–Apr 2026):
 *   197 trades, 78.9% WR, PF 5.87, $333,225 net, $6,065 max DD.
 *
 * Active rules (priority desc within side, side ties broken by priority then iteration):
 *   L1 (long, p100): putWall<=50 + ivPctile.low + skew.positive   stop 113 / tgt 198
 *   L4 (long, p90):  gex.neutral + above.gammaFlip + ivPctile.low stop 106 / tgt 187
 *   L3 (long, p80):  gex.strong_negative + above.gammaFlip        stop 184 / tgt 278
 *   S3 (short,p100): callWall<=50 + below.gammaFlip               stop 114 / tgt 196
 *   S1 (short,p90):  callWall<=50 + ivPctile.high + skew.positive stop 131 / tgt 211
 *   S2 (short,p80):  callWall<=50 + ivPctile.high                 stop 129 / tgt 211
 */

import { BaseStrategy } from './base-strategy.js';

const RULES = [
  { id: 'L1', side: 'long',  priority: 100, stopPts: 113, targetPts: 198, description: 'putWall<=50 + ivPctile.low + skew.positive' },
  { id: 'L4', side: 'long',  priority: 90,  stopPts: 106, targetPts: 187, description: 'gex.neutral + above.gammaFlip + ivPctile.low' },
  { id: 'L3', side: 'long',  priority: 80,  stopPts: 184, targetPts: 278, description: 'gex.strong_negative + above.gammaFlip' },
  { id: 'S3', side: 'short', priority: 100, stopPts: 114, targetPts: 196, description: 'callWall<=50 + below.gammaFlip' },
  { id: 'S1', side: 'short', priority: 90,  stopPts: 131, targetPts: 211, description: 'callWall<=50 + ivPctile.high + skew.positive' },
  { id: 'S2', side: 'short', priority: 80,  stopPts: 129, targetPts: 211, description: 'callWall<=50 + ivPctile.high' },
];

const DAY_MS = 24 * 60 * 60 * 1000;

export class GexFlipIvpctStrategy extends BaseStrategy {
  static getDataRequirements() {
    return {
      candles: {
        baseSymbol: 'NQ',
        quoteSymbols: ['CME_MINI:NQ1!', 'CME_MINI:MNQ1!', 'NASDAQ:QQQ']
      },
      gex: { etfSymbol: 'QQQ', futuresSymbol: 'NQ', defaultMultiplier: 41.5 },
      lt: false,
      tradier: true,
      tradierSymbols: ['QQQ'],
      ivSkew: true
    };
  }

  constructor(params = {}) {
    super(params);

    // Wall-proximity gate (used by L1, S1, S2, S3)
    this.params.wallProximity = params.wallProximity ?? 50;

    // IV percentile thresholds (rolling 20 calendar days)
    this.params.ivPctileWindowDays = params.ivPctileWindowDays ?? 20;
    this.params.ivPctileLowMax = params.ivPctileLowMax ?? 0.20;   // L1, L4: ivPctile <= 0.20
    this.params.ivPctileHighMin = params.ivPctileHighMin ?? 0.80; // S1, S2: ivPctile >= 0.80

    // Skew gate (positive skew = puts expensive)
    this.params.skewPositiveMin = params.skewPositiveMin ?? 0.015;

    // Regime gates
    this.params.neutralRegime = params.neutralRegime ?? 'neutral';
    this.params.strongNegativeRegime = params.strongNegativeRegime ?? 'strong_negative';

    // Entry window (ET hour-of-day, half-open: [start, end))
    this.params.entryWindowStartHour = params.entryWindowStartHour ?? 4;
    this.params.entryWindowEndHour = params.entryWindowEndHour ?? 13;

    // Additional hour blacklist within the window. e.g. [6,7,8] to skip ET 06-08.
    this.params.blockedHoursEt = new Set(params.blockedHoursEt ?? []);

    // Cooldown between trades — V7DTSP13 production run used 6 5m bars = 30 minutes
    this.params.signalCooldownMs = params.signalCooldownMs ?? 30 * 60 * 1000;

    // Per-rule overrides: { [ruleId]: { stopPts?, targetPts?, priority? } }
    // and a blacklist of rule IDs to disable entirely.
    this.params.ruleOverrides = params.ruleOverrides ?? {};
    this.params.disabledRules = new Set(params.disabledRules ?? []);

    // Global stop/target overrides apply to ALL rules when set.
    // Per-rule overrides in ruleOverrides take precedence over these.
    this.params.globalStopPts = params.globalStopPts ?? null;
    this.params.globalTargetPts = params.globalTargetPts ?? null;

    // Breakeven stop (forwarded to trade-simulator on each signal)
    this.params.breakevenStop = params.breakevenStop ?? false;
    this.params.breakevenTrigger = params.breakevenTrigger ?? null;
    this.params.breakevenOffset = params.breakevenOffset ?? 0;

    // LS-BE-on-flip overlay (research/ls-overlay, 2026-05-19).
    // When enabled, the trade-orchestrator arms a breakeven stop on the
    // first adverse LS flip during the trade (adverse for LONG = state→
    // BULLISH; for SHORT = state→BEARISH). The offset is points to lock
    // above/below entry (0 = pure breakeven). Per Phase 5/7, gex-flip-
    // ivpct prefers BE+0; the structural BE rule above is independent
    // and coexists (whichever stop is hit first wins).
    this.params.lsBeOnFlip = params.lsBeOnFlip ?? false;
    this.params.lsBeOffset = params.lsBeOffset ?? 0;

    // Trailing stop (forwarded to trade-simulator on each signal)
    this.params.trailingTrigger = params.trailingTrigger ?? null;
    this.params.trailingOffset = params.trailingOffset ?? null;

    // Default max hold. The slingshot trade simulator increments barsSinceEntry
    // per-1m candle regardless of strategy timeframe, so this value is in MINUTES.
    // V7DTSP13's 120 5m bars = 600 minutes.
    // The trade-orchestrator should also force-flat at 4:45 PM ET as a
    // service-level safety against the broker auto-liquidating.
    this.params.maxHoldBars = params.maxHoldBars ?? 600;

    // Structural-magnet ratchet: when enabled, the strategy computes 1m
    // 9/9 swing pivots in the trade's profit region at signal time and
    // emits per-signal mfeRatchetConfig.tiers anchored at those swings.
    // Each magnet becomes a tier with the same lockPct. The engine's
    // existing MFE ratchet code (trade-simulator.js:1138) consumes the
    // tiers unchanged.
    this.params.magnetRatchet = params.magnetRatchet ?? false;
    this.params.magnetLockPct = params.magnetLockPct ?? 0.75;
    this.params.magnetRecencyMs = params.magnetRecencyMs ?? 4 * 60 * 60 * 1000;
    // When true, each tier's stop is fixed at (tier.minMFE × lockPct) and
    // does NOT track running MFE between tiers. Lets trades breathe to
    // reach the next magnet. Matches the user's intuition: "lock at the
    // magnet, hold until the next magnet."
    this.params.magnetFixedPerTier = params.magnetFixedPerTier ?? false;
    // When set, trades with no magnets in profit region fall back to this
    // pure-MFE ratchet tier set. Format: same as mfeRatchetConfig.tiers.
    // Example: `[{ minMFE: 70, lockPct: 0.40 }]` matches the s1-m70l40 pure
    // ratchet config from Wave 1's sweep.
    this.params.magnetFallbackTiers = params.magnetFallbackTiers ?? null;

    // Fibonacci-retracement bar-close exit (additive to hard SL):
    //   - Tracks favorable extreme since fill.
    //   - Once MFE >= fibActivationMFE, exit on a 1m bar CLOSE through the
    //     entry ± mfe × (1 − fibRetracePct) level.
    //   - Hard SL at fill ± stopPts stays in place.
    this.params.fibRetrace = params.fibRetrace ?? false;
    this.params.fibRetracePct = params.fibRetracePct ?? 0.786;
    this.params.fibActivationMFE = params.fibActivationMFE ?? 40;

    // Regime-conditional fib config: when enabled, per-signal fib params
    // are chosen based on the entry-time regime classification derived from
    // the 172-trade baseline separation analysis (research/mfe-ratchet-gfi/
    // regime-analysis.md). Trades that already capture well (mid IV, S2 rule)
    // get fib disabled. Wave-prone trades (negative GEX, L4, S1) get tighter
    // fib. Everything else uses the baseline 0.618/40 config.
    this.params.fibConditional = params.fibConditional ?? false;
    // 'full' (default): disable fib for S2 + mid-IV, tighten for wave-prone.
    // 's2-only': disable fib for S2 only; everything else uses default.
    // 'tighten-only': no disables, just tighten wave-prone (L4/S1/neg-GEX).
    // 'mild-tighten': like tighten-only but with a softer tighten (0.58/40).
    this.params.fibConditionalMode = params.fibConditionalMode ?? 'full';

    // Informational: the trade-orchestrator's EOD force-flat time. The
    // strategy itself does not act on this — it's plumbed through so the
    // dashboard panel renders the same value the orchestrator is using.
    // Empty string means orchestrator-side EOD flat is disabled.
    this.params.eodCutoffEt = params.eodCutoffEt ?? '16:40';

    // Trading symbol
    this.params.tradingSymbol = params.tradingSymbol ?? 'NQ';
    this.params.defaultQuantity = params.defaultQuantity ?? 1;

    // Debug / live mode
    this.params.debug = params.debug ?? false;
    this.params.liveMode = params.liveMode ?? false;

    // Swing pivot loader (for magnet ratchet)
    this.swingLoader = null;    // backtest path
    this.liveSwingProvider = null; // live path: pluggable (not yet wired)

    // IV data sources
    this.ivLoader = null;       // backtest path
    this.liveIVData = null;     // live path: most recent IV record
    this.liveIVHistory = [];    // live path: rolling buffer of {timestamp, iv}

    // Redis persistence (optional — populated via attachRedis)
    this.redis = null;
    this.redisKey = null;
    this._redisErrorLoggedAt = 0;

    // Evaluation log for dashboard
    this.evaluationLog = [];
  }

  /**
   * Attach a node-redis v4 client for persisting the rolling IV history so
   * it survives service restarts. Call hydrateFromRedis() after attaching to
   * load whatever samples are already stored.
   *
   * Failures here are logged but never thrown — the strategy keeps working
   * from its in-memory buffer if Redis is unreachable.
   *
   * @param {object} redisClient — node-redis v4 connected client
   * @param {{ key?: string }} opts
   */
  attachRedis(redisClient, opts = {}) {
    this.redis = redisClient;
    this.redisKey = opts.key || `strategy:${this.getName()}:iv_history`;
  }

  /**
   * Load any persisted samples from Redis into liveIVHistory. Idempotent —
   * call after attachRedis() and once per process start.
   */
  async hydrateFromRedis() {
    if (!this.redis || !this.redisKey) return false;
    try {
      const cutoffMs = Date.now() - this.params.ivPctileWindowDays * DAY_MS;
      // node-redis v4 zRangeByScore returns array of member strings (no scores)
      const rows = await this.redis.zRangeByScore(this.redisKey, cutoffMs, '+inf');
      const samples = [];
      for (const raw of rows) {
        try {
          const o = JSON.parse(raw);
          if (o && o.ts != null && o.iv != null) {
            samples.push({ timestamp: o.ts, iv: o.iv, skew: o.skew ?? null });
          }
        } catch (_) { /* skip malformed */ }
      }
      // Merge with anything already in memory and dedupe by timestamp
      const seen = new Set(this.liveIVHistory.map(s => s.timestamp));
      for (const s of samples) {
        if (!seen.has(s.timestamp)) this.liveIVHistory.push(s);
      }
      this.liveIVHistory.sort((a, b) => a.timestamp - b.timestamp);
      console.log(`[${this.getName()}] Rehydrated IV history from Redis: ${samples.length} samples (buffer now ${this.liveIVHistory.length})`);
      return true;
    } catch (err) {
      console.warn(`[${this.getName()}] Redis hydrate failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Persist a single sample to the Redis sorted set and prune entries older
   * than the rolling window. Fire-and-forget; logs at most once per minute on
   * sustained failure to avoid spam.
   */
  _persistSampleToRedis(sample) {
    if (!this.redis || !this.redisKey) return;
    const member = JSON.stringify({ ts: sample.timestamp, iv: sample.iv, skew: sample.skew });
    const cutoffMs = Date.now() - this.params.ivPctileWindowDays * DAY_MS;
    Promise.resolve()
      .then(() => this.redis.zAdd(this.redisKey, { score: sample.timestamp, value: member }))
      .then(() => this.redis.zRemRangeByScore(this.redisKey, '-inf', cutoffMs))
      .catch(err => {
        const now = Date.now();
        if (now - this._redisErrorLoggedAt > 60_000) {
          console.warn(`[${this.getName()}] Redis IV-history persist failed: ${err.message}`);
          this._redisErrorLoggedAt = now;
        }
      });
  }

  loadIVData(ivLoader) {
    this.ivLoader = ivLoader;
    if (this.params.debug) {
      const stats = ivLoader.getStats();
      console.log(`[GEX-FLIP-IVPCT] IV data loaded: ${stats.count} records, ${stats.startDate} → ${stats.endDate}`);
    }
  }

  loadSwingPivots(swingLoader) {
    this.swingLoader = swingLoader;
    if (this.params.debug || true) {
      const stats = swingLoader.getStats?.() ?? { count: '?' };
      console.log(`[GEX-FLIP-IVPCT] Swing pivots loaded: ${stats.count} records (${stats.highs}H/${stats.lows}L)`);
    }
  }

  /**
   * Build per-signal MFE ratchet tiers from active swing magnets in the
   * trade's profit region. Returns null if magnet ratchet is disabled, no
   * loader is attached, or no magnets are within the profit region.
   *
   * For a SHORT at entryPrice with targetPts TP distance: profit region is
   * (entryPrice − targetPts, entryPrice), so we look at swing LOWS in that
   * band. Symmetric for LONGs (swing HIGHs above entry).
   */
  buildMagnetTiers(timestamp, side, entryPrice, targetPts) {
    if (!this.params.magnetRatchet) return null;
    if (!this.swingLoader) return null;

    const isShort = side === 'short';
    const swingType = isShort ? 'low' : 'high';
    const swings = this.swingLoader.getActiveSwings(timestamp, swingType, this.params.magnetRecencyMs);
    if (!swings || swings.length === 0) return null;

    // Filter to profit region. Exclude swings at or beyond TP — TP already
    // closes the trade there, so an additional tier is redundant.
    const lo = isShort ? entryPrice - targetPts : entryPrice;
    const hi = isShort ? entryPrice : entryPrice + targetPts;
    const magnets = swings.filter(s => s.price > lo && s.price < hi);
    if (magnets.length === 0) return null;

    // Build tiers: each magnet → { minMFE, lockPct }. Highest minMFE first.
    const tiers = magnets.map(m => {
      const mfeAtMagnet = Math.abs(entryPrice - m.price);
      return { minMFE: mfeAtMagnet, lockPct: this.params.magnetLockPct, label: `magnet@${m.price.toFixed(2)}` };
    }).sort((a, b) => b.minMFE - a.minMFE);

    // Deduplicate: identical minMFE collapses to one tier
    const seen = new Set();
    const unique = [];
    for (const t of tiers) {
      const key = `${t.minMFE.toFixed(2)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(t);
    }
    return unique;
  }

  /**
   * Per-signal fib config selector, used when --gfi-fib-conditional is on.
   * Returns null to DISABLE fib for trades whose baseline capture is already
   * strong (mid-IV, S2 rule). Returns a tight config for wave-prone trades
   * (negative-GEX or L4/S1 rule). Defaults to the user-configured fib
   * params for everything else.
   *
   * Rules derived from research/mfe-ratchet-gfi/regime-analysis.md (172
   * baseline trades, BE 70/+5).
   */
  resolveConditionalFibConfig(rule, features, iv) {
    const mode = this.params.fibConditionalMode || 'full';
    const ivPct = features?.ivPctile;
    const isWaveProne =
      features?.regime === 'negative' ||
      rule.id === 'L4' ||
      rule.id === 'S1';

    const defaultCfg = {
      retracePct: this.params.fibRetracePct,
      activationMFE: this.params.fibActivationMFE,
      label: 'default',
    };

    if (mode === 's2-only') {
      // Disable only S2 (n=7, 92.7% capture). Everything else default.
      if (rule.id === 'S2') return null;
      return defaultCfg;
    }

    if (mode === 'tighten-only') {
      // No disables. Tighten wave-prone trades only.
      if (isWaveProne) return { retracePct: 0.55, activationMFE: 35, label: 'tight' };
      return defaultCfg;
    }

    if (mode === 'mild-tighten') {
      // No disables. Soft tighten wave-prone.
      if (isWaveProne) return { retracePct: 0.58, activationMFE: 40, label: 'mild-tight' };
      return defaultCfg;
    }

    // mode === 'full' (default): disable for S2 + mid-IV, tighten for wave-prone
    if (rule.id === 'S2') return null;
    if (ivPct != null && ivPct >= 0.33 && ivPct < 0.67) return null;
    if (isWaveProne) return { retracePct: 0.55, activationMFE: 35, label: 'tight' };
    return defaultCfg;
  }

  setLiveIVData(ivData) {
    this.liveIVData = ivData;
    if (ivData && ivData.iv != null) {
      const sample = { timestamp: Date.now(), iv: ivData.iv, skew: ivData.skew ?? null };
      this.liveIVHistory.push(sample);
      // Keep rolling 20-day window plus a small buffer
      const cutoff = Date.now() - (this.params.ivPctileWindowDays + 1) * DAY_MS;
      this.liveIVHistory = this.liveIVHistory.filter(s => s.timestamp >= cutoff);
      // Mirror to Redis so the buffer survives service restarts
      this._persistSampleToRedis(sample);
    }
  }

  getIVAtTime(timestamp) {
    if (this.liveIVData) return this.liveIVData;
    if (this.ivLoader) return this.ivLoader.getIVAtTime(timestamp);
    return null;
  }

  /**
   * Rolling IV percentile over last N calendar days at-or-before the
   * reference timestamp. Returns the fraction of samples with iv <= current iv.
   */
  computeIVPercentile(timestamp) {
    const cur = this.getIVAtTime(timestamp);
    if (!cur || cur.iv == null) return null;

    const lookbackMs = this.params.ivPctileWindowDays * DAY_MS;
    const startTs = timestamp - lookbackMs;

    let samples;
    if (this.ivLoader && Array.isArray(this.ivLoader.ivData)) {
      // Backtest: scan series in window [startTs, timestamp]
      const arr = this.ivLoader.ivData;
      // Binary search lower bound
      let lo = 0, hi = arr.length - 1, startIdx = arr.length;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (arr[m].timestamp >= startTs) { startIdx = m; hi = m - 1; }
        else lo = m + 1;
      }
      samples = [];
      for (let i = startIdx; i < arr.length && arr[i].timestamp <= timestamp; i++) {
        samples.push(arr[i].iv);
      }
    } else if (this.liveIVHistory.length > 0) {
      samples = this.liveIVHistory
        .filter(s => s.timestamp >= startTs && s.timestamp <= timestamp)
        .map(s => s.iv);
    } else {
      return null;
    }

    if (samples.length === 0) return null;

    let below = 0;
    for (const v of samples) if (v <= cur.iv) below++;
    return below / samples.length;
  }

  /**
   * Get ET hour-of-day for a timestamp.
   */
  getETHour(timestamp) {
    const date = new Date(timestamp);
    return parseInt(date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hour12: false
    }));
  }

  /**
   * Half-open entry window check: entryWindowStartHour <= hour < entryWindowEndHour,
   * with optional hour blacklist via blockedHoursEt.
   */
  isInEntryWindow(timestamp) {
    const h = this.getETHour(timestamp);
    if (this.params.blockedHoursEt.has(h)) return false;
    return h >= this.params.entryWindowStartHour && h < this.params.entryWindowEndHour;
  }

  /**
   * Resolve a rule's effective stop/target/priority after applying global
   * overrides and per-rule overrides. Per-rule overrides win.
   */
  _resolvedRule(rule) {
    const o = this.params.ruleOverrides[rule.id] || {};
    const stopPts = o.stopPts ?? this.params.globalStopPts ?? rule.stopPts;
    const targetPts = o.targetPts ?? this.params.globalTargetPts ?? rule.targetPts;
    const priority = o.priority ?? rule.priority;
    return { ...rule, stopPts, targetPts, priority };
  }

  /**
   * Evaluate every rule and return the highest-priority one whose conditions fire.
   * Returns the rule with overrides applied (stop/target/priority).
   */
  findFiringRule(features) {
    let best = null;
    for (const rule of RULES) {
      if (this.params.disabledRules.has(rule.id)) continue;
      if (!this._ruleFires(rule, features)) continue;
      const resolved = this._resolvedRule(rule);
      if (!best || resolved.priority > best.priority) best = resolved;
    }
    return best;
  }

  _ruleFires(rule, f) {
    const { close, gamma_flip, call_wall, put_wall, regime, ivPctile, skew } = f;

    switch (rule.id) {
      case 'L1':
        return put_wall != null
          && Math.abs(close - put_wall) <= this.params.wallProximity
          && ivPctile != null && ivPctile <= this.params.ivPctileLowMax
          && skew != null && skew > this.params.skewPositiveMin;

      case 'L4':
        return regime === this.params.neutralRegime
          && gamma_flip != null && (close - gamma_flip) > 0
          && ivPctile != null && ivPctile <= this.params.ivPctileLowMax;

      case 'L3':
        return regime === this.params.strongNegativeRegime
          && gamma_flip != null && (close - gamma_flip) > 0;

      case 'S3':
        return call_wall != null
          && Math.abs(close - call_wall) <= this.params.wallProximity
          && gamma_flip != null && (close - gamma_flip) < 0;

      case 'S1':
        return call_wall != null
          && Math.abs(close - call_wall) <= this.params.wallProximity
          && ivPctile != null && ivPctile >= this.params.ivPctileHighMin
          && skew != null && skew > this.params.skewPositiveMin;

      case 'S2':
        return call_wall != null
          && Math.abs(close - call_wall) <= this.params.wallProximity
          && ivPctile != null && ivPctile >= this.params.ivPctileHighMin;

      default:
        return false;
    }
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const timestamp = this.toMs(candle.timestamp);
    const gexLevels = marketData?.gexLevels;
    const iv = this.getIVAtTime(timestamp);

    // Cooldown
    if (!this.checkCooldown(timestamp, this.params.signalCooldownMs)) {
      this.logEval(candle, iv, gexLevels, null, 'cooldown active');
      return null;
    }

    // Entry window (04:00–13:00 ET)
    if (!this.isInEntryWindow(timestamp)) {
      this.logEval(candle, iv, gexLevels, null, `outside entry window (${this.getETHour(timestamp)} ET)`);
      return null;
    }

    if (!gexLevels) {
      this.logEval(candle, iv, gexLevels, null, 'no GEX levels');
      return null;
    }
    if (!iv) {
      this.logEval(candle, iv, gexLevels, null, 'no IV data');
      return null;
    }

    const ivPctile = this.computeIVPercentile(timestamp);

    const features = {
      close: candle.close,
      gamma_flip: gexLevels.gamma_flip ?? gexLevels.gammaFlip ?? null,
      call_wall: gexLevels.call_wall ?? gexLevels.callWall ?? null,
      put_wall: gexLevels.put_wall ?? gexLevels.putWall ?? null,
      regime: gexLevels.regime ?? null,
      ivPctile,
      skew: iv.skew ?? null,
    };

    const rule = this.findFiringRule(features);
    if (!rule) {
      this.logEval(candle, iv, gexLevels, null, `no rule fires (regime=${features.regime}, ivPctile=${ivPctile?.toFixed(2)})`);
      return null;
    }

    const signal = this.createSignal(rule, candle, features, iv, gexLevels);
    this.logEval(candle, iv, gexLevels, signal, null);
    return signal;
  }

  createSignal(rule, candle, features, iv, gexLevels) {
    const timestamp = this.toMs(candle.timestamp);
    this.updateLastSignalTime(timestamp);

    const entryPrice = candle.close;
    const sign = rule.side === 'long' ? 1 : -1;
    const stopLoss = entryPrice - sign * rule.stopPts;
    const takeProfit = entryPrice + sign * rule.targetPts;

    if (this.params.debug) {
      console.log(`[GEX-FLIP-IVPCT] ${rule.id} ${rule.side.toUpperCase()} @ ${entryPrice.toFixed(2)} ` +
        `stop=${stopLoss.toFixed(2)} tgt=${takeProfit.toFixed(2)} ` +
        `ivPct=${features.ivPctile?.toFixed(2)} regime=${features.regime}`);
    }

    const signal = {
      timestamp,
      side: rule.side,
      price: entryPrice,
      strategy: 'GEX_FLIP_IVPCT',
      action: 'place_limit',
      symbol: this.params.tradingSymbol,
      quantity: this.params.defaultQuantity,
      stopLoss,
      takeProfit,
      maxHoldBars: this.params.maxHoldBars,

      // Rule metadata
      ruleId: rule.id,
      ruleDescription: rule.description,
      rulePriority: rule.priority,
      stopPoints: rule.stopPts,
      targetPoints: rule.targetPts,

      // Feature snapshot
      ivValue: iv.iv,
      ivSkew: iv.skew,
      ivPercentile: features.ivPctile,
      gexRegime: features.regime,
      gammaFlip: features.gamma_flip,
      callWall: features.call_wall,
      putWall: features.put_wall,

      // Snake_case for trade orchestrator bracket orders
      stop_loss: stopLoss,
      take_profit: takeProfit,
    };

    if (this.params.breakevenStop) {
      const trig = this.params.breakevenTrigger ?? Math.max(20, Math.round(rule.targetPts * 0.25));
      signal.breakeven_stop = true;
      signal.breakevenStop = true;
      signal.breakeven_trigger = trig;
      signal.breakevenTrigger = trig;
      signal.breakeven_offset = this.params.breakevenOffset;
      signal.breakevenOffset = this.params.breakevenOffset;
    }

    if (this.params.trailingTrigger != null && this.params.trailingOffset != null) {
      signal.trailing_trigger = this.params.trailingTrigger;
      signal.trailingTrigger = this.params.trailingTrigger;
      signal.trailing_offset = this.params.trailingOffset;
      signal.trailingOffset = this.params.trailingOffset;
    }

    if (this.params.lsBeOnFlip) {
      signal.lsBeOnFlip = true;
      signal.lsBeOffset = this.params.lsBeOffset;
    }

    // Structural-magnet MFE ratchet: each in-profit-region swing low/high
    // becomes a tier in the engine's mfeRatchet code path. Locks magnetLockPct
    // of current MFE once MFE crosses the shallowest magnet's distance.
    // Fibonacci-retracement bar-close exit
    if (this.params.fibRetrace) {
      const fibCfg = this.params.fibConditional
        ? this.resolveConditionalFibConfig(rule, features, iv)
        : { retracePct: this.params.fibRetracePct, activationMFE: this.params.fibActivationMFE, label: 'static' };

      if (fibCfg) {
        signal.fibRetrace = true;
        signal.fibRetraceConfig = {
          retracePct: fibCfg.retracePct,
          activationMFE: fibCfg.activationMFE,
        };
        signal.fibConditionalLabel = fibCfg.label;
        if (this.params.debug) {
          console.log(`[GEX-FLIP-IVPCT] Fib retrace ${rule.side} @${entryPrice.toFixed(2)} ` +
            `[${fibCfg.label}]: retrace=${fibCfg.retracePct} activation=${fibCfg.activationMFE}`);
        }
      } else {
        // Conditional rules said "no fib for this trade" (e.g., S2 or mid-IV).
        // Must set fibRetrace = false explicitly so the engine's CLI-flag
        // passthrough doesn't re-enable it.
        signal.fibRetrace = false;
        signal.fibConditionalLabel = 'disabled';
        if (this.params.debug) {
          console.log(`[GEX-FLIP-IVPCT] Fib retrace SKIPPED for ${rule.id} ${rule.side} — ` +
            `regime says capture is already strong`);
        }
      }
    }

    if (this.params.magnetRatchet) {
      let tiers = this.buildMagnetTiers(timestamp, rule.side, entryPrice, rule.targetPts);
      let usedFallback = false;
      if ((!tiers || tiers.length === 0) && this.params.magnetFallbackTiers) {
        // No magnets in profit region — apply the configured pure-MFE fallback
        // so the trade still gets some ratchet protection rather than riding
        // only the original SL.
        tiers = this.params.magnetFallbackTiers
          .map(t => ({ minMFE: t.minMFE, lockPct: t.lockPct, label: `fallback-lock-${Math.round(t.lockPct * 100)}%-mfe${t.minMFE}` }))
          .sort((a, b) => b.minMFE - a.minMFE);
        usedFallback = true;
      }
      if (tiers && tiers.length > 0) {
        signal.mfeRatchet = true;
        // Fallback uses running-mode (continuous tightening) regardless of
        // the per-tier magnet semantic — there are no actual magnets to be
        // anchored to.
        signal.mfeRatchetConfig = {
          tiers,
          fixedPerTier: usedFallback ? false : this.params.magnetFixedPerTier,
        };
        if (this.params.debug) {
          console.log(`[GEX-FLIP-IVPCT] ${usedFallback ? 'Fallback' : 'Magnet'} ratchet ${rule.side} @${entryPrice.toFixed(2)}` +
            `${this.params.magnetFixedPerTier && !usedFallback ? ' [fixed]' : ''}: ` +
            tiers.map(t => `${t.label}(MFE>=${t.minMFE.toFixed(1)})`).join(', '));
        }
      }
    }

    return signal;
  }

  reset() {
    super.reset();
  }

  /**
   * Anchor the cooldown timer to the exit timestamp instead of the signal
   * timestamp. The standalone V7DTSP13 simulator counts cooldown from the
   * last exit, not from the last entry signal — so signals fired *during*
   * an open position should not reset cooldown. The engine already rejects
   * them as "position already active"; we additionally push lastSignalTime
   * forward to the exit time so cooldown unblocks at exit + cooldownMs.
   * @param {{pnl, timestamp, metadata}} info
   */
  onPositionClosed(info) {
    if (info && info.timestamp) {
      this.lastSignalTime = this.toMs(info.timestamp);
    }
  }

  getName() {
    return 'GEX_FLIP_IVPCT';
  }

  getInternalState() {
    // Compute current IV percentile so the dashboard can render it.
    let ivPercentile = null;
    try {
      ivPercentile = this.computeIVPercentile(Date.now());
    } catch (_) { /* ignore */ }

    return {
      // Config (used by the panel to render rule conditions)
      wallProximity: this.params.wallProximity,
      ivPctileWindowDays: this.params.ivPctileWindowDays,
      ivPctileLowMax: this.params.ivPctileLowMax,
      ivPctileHighMin: this.params.ivPctileHighMin,
      skewPositiveMin: this.params.skewPositiveMin,
      neutralRegime: this.params.neutralRegime,
      strongNegativeRegime: this.params.strongNegativeRegime,
      entryWindowStartHour: this.params.entryWindowStartHour,
      entryWindowEndHour: this.params.entryWindowEndHour,
      blockedHoursEt: Array.from(this.params.blockedHoursEt).sort((a, b) => a - b),
      signalCooldownMs: this.params.signalCooldownMs,
      maxHoldBars: this.params.maxHoldBars,
      eodCutoffEt: this.params.eodCutoffEt,
      // Tight-stop refit settings (active overrides)
      globalStopPts: this.params.globalStopPts,
      globalTargetPts: this.params.globalTargetPts,
      breakevenStop: this.params.breakevenStop,
      breakevenTrigger: this.params.breakevenTrigger,
      breakevenOffset: this.params.breakevenOffset,
      trailingTrigger: this.params.trailingTrigger,
      trailingOffset: this.params.trailingOffset,
      // Fibonacci-retrace bar-close exit (additive to BE)
      fibRetrace: this.params.fibRetrace,
      fibRetracePct: this.params.fibRetracePct,
      fibActivationMFE: this.params.fibActivationMFE,
      // Active rule set (after disabledRules filter)
      activeRules: RULES.filter(r => !this.params.disabledRules.has(r.id)).map(r => ({
        id: r.id,
        side: r.side,
        priority: r.priority,
        stopPts: this.params.ruleOverrides[r.id]?.stopPts ?? this.params.globalStopPts ?? r.stopPts,
        targetPts: this.params.ruleOverrides[r.id]?.targetPts ?? this.params.globalTargetPts ?? r.targetPts,
        description: r.description,
      })),
      disabledRules: Array.from(this.params.disabledRules),

      // Live state
      ivPercentile,
      liveIVSamples: this.liveIVHistory.length,
      ivHistoryOldest: this.liveIVHistory.length > 0 ? this.liveIVHistory[0].timestamp : null,
      ivHistoryNewest: this.liveIVHistory.length > 0 ? this.liveIVHistory[this.liveIVHistory.length - 1].timestamp : null,
      redisAttached: !!this.redis,
      redisKey: this.redisKey,
      evaluationLog: this.evaluationLog.slice(-10),
    };
  }

  logEval(candle, iv, gexLevels, signal, reason) {
    if (!this.params.liveMode && !this.params.debug) return;

    const ts = this.toMs(candle.timestamp);
    const timeStr = new Date(ts).toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit', minute: '2-digit', hour12: false
    });

    const ivStr = iv ? `IV:${(iv.iv * 100).toFixed(1)}% Skew:${(iv.skew * 100).toFixed(2)}%` : 'IV:N/A';
    const result = signal
      ? `→ ${signal.ruleId} ${signal.side.toUpperCase()} SIGNAL`
      : `→ no signal: ${reason}`;

    this.evaluationLog.push({
      time: timeStr,
      price: candle.close,
      iv: iv?.iv ?? null,
      skew: iv?.skew ?? null,
      result: signal ? `${signal.ruleId} ${signal.side.toUpperCase()}` : reason,
      fired: !!signal,
    });
    if (this.evaluationLog.length > 15) {
      this.evaluationLog = this.evaluationLog.slice(-15);
    }

    console.log(`[GEX-FLIP-IVPCT] ${timeStr} | ${candle.close.toFixed(2)} | ${ivStr} | ${result}`);
  }
}

export default GexFlipIvpctStrategy;
