/**
 * GEX-LEVEL-FADE — fade re-tests of structural levels.
 *
 * Trades the 2nd-or-later TOUCH EPISODE of a structural level within the
 * same RTH session. The thesis from the level-reaction research:
 *   - Session extremes (SH/SL) and prior-hour H/L (PRH/PRL) tend to be
 *     re-tested multiple times in the same hour/session.
 *   - Once a level has been touched once, subsequent retouches are
 *     high-probability fade entries.
 *   - Gamma regime gates execution: positive/neutral regimes favor
 *     mean reversion (dealers dampen). Negative regimes favor follow-
 *     through (dealers chase). Skip negative-regime entries.
 *
 * Touch definition: strict — 1m bar low <= level <= high.
 * Episode: contiguous run of touching bars; closes after EXIT_PERSISTENCE_BARS
 * non-touching bars.
 *
 * Levels supported (configurable via params.levels):
 *   - PRH (prior-hour high)   — SHORT fade
 *   - PRL (prior-hour low)    — LONG fade
 *   - SH  (session high)      — SHORT fade
 *   - SL  (session low)       — LONG fade
 *
 * Entry: place_limit at the exact level price (no slippage on fill).
 * Target/stop: configurable; defaults to 5pt target, 20pt stop per research.
 */
import { BaseStrategy } from './base-strategy.js';

const RTH_START_MIN = 9 * 60 + 30;
const RTH_END_MIN = 16 * 60;
const EXIT_PERSISTENCE_BARS = 5;

export class GexLevelFadeStrategy extends BaseStrategy {
  static getDataRequirements() {
    return {
      candles: { baseSymbol: 'NQ', quoteSymbols: ['CME_MINI:NQ1!'] },
      gex: { etfSymbol: 'QQQ', futuresSymbol: 'NQ', defaultMultiplier: 41.5 },
      lt: false, lt1m: false, tradier: false, ivSkew: false, s1Vwap: false,
    };
  }

  constructor(params = {}) {
    super(params);
    this.params.tradingSymbol = params.tradingSymbol ?? 'NQ';
    this.params.defaultQuantity = params.defaultQuantity ?? 1;
    this.params.levels = params.levels ?? ['PRH', 'PRL', 'SH', 'SL'];
    // Whether to include GEX levels (call_wall, put_wall, gamma_flip, S1-S5, R1-R5) from the snapshot
    this.params.includeGexLevels = params.includeGexLevels ?? false;
    // Which GEX level types to include when enabled
    this.params.gexLevelTypes = params.gexLevelTypes ?? ['call_wall', 'put_wall', 'S1', 'S2', 'S3', 'S4', 'S5', 'R1', 'R2', 'R3', 'R4', 'R5'];
    // 'fade' (default): short PRH/SH, long PRL/SL — bet the level holds (mean reversion).
    // 'continuation': flip — long PRH/SH on retest (bet the break extends),
    //   short PRL/SL on retest (bet the break extends).
    this.params.directionMode = params.directionMode ?? 'fade';
    this.params.targetPts = params.targetPts ?? 5;
    this.params.stopPts = params.stopPts ?? 20;
    this.params.maxHoldBars = params.maxHoldBars ?? 60;
    this.params.limitTimeoutBars = params.limitTimeoutBars ?? 1;
    this.params.eodCutoffEt = params.eodCutoffEt ?? '16:40';
    this.params.snapLagMin = params.snapLagMin ?? 16;
    // Regime gating: skip if regime is in this list. Default skips strong_negative only.
    this.params.blockedRegimes = params.blockedRegimes ?? ['strong_negative'];
    // Entry window in ET
    this.params.entryWindowStartHour = params.entryWindowStartHour ?? 7;
    this.params.entryWindowStartMinute = params.entryWindowStartMinute ?? 0;
    this.params.entryWindowEndHour = params.entryWindowEndHour ?? 16;
    this.params.entryWindowEndMinute = params.entryWindowEndMinute ?? 0;
    this.params.disableEntryWindow = params.disableEntryWindow ?? false;
    this.params.blockedHoursEt = params.blockedHoursEt ?? [];   // skip these ET hours
    this.params.minEpisodeNum = params.minEpisodeNum ?? 2;       // fire on episode N or later (default 2 = first retest)
    this.params.trailingTrigger = params.trailingTrigger ?? 0;   // pts MFE to arm trailing (0 = disabled)
    this.params.trailingOffset = params.trailingOffset ?? 0;     // pts behind MFE to trail
    this.params.breakevenTrigger = params.breakevenTrigger ?? 0; // pts MFE to arm breakeven (0 = disabled)
    this.params.breakevenOffset = params.breakevenOffset ?? 0;   // pts past entry for breakeven stop
    this.params.maxLastEpPenetrationPts = params.maxLastEpPenetrationPts ?? null;  // skip if last episode penetrated past level by more than X pts
    this.params.minLastEpBarsInZone = params.minLastEpBarsInZone ?? null;  // skip if last episode lasted fewer than N bars
    this.params.minLastEpRej5m = params.minLastEpRej5m ?? null;   // skip if last episode had fewer than N 5m rejection wicks
    this.params.minLastEpRej15m = params.minLastEpRej15m ?? null; // skip if last episode had fewer than N 15m rejection wicks
    this.params.rejectionWickMinPts = params.rejectionWickMinPts ?? 3;  // min wick size to count as a rejection wick
    // Volume-burst filter (1m proxy for institutional flow): a 1m bar with volume >= volBurstMult × trailing 30-bar mean
    this.params.volBurstMult = params.volBurstMult ?? 5;          // multiplier vs trailing mean to call a burst
    this.params.volBurstLookback = params.volBurstLookback ?? 30; // trailing window in bars
    this.params.minLastEpVolBursts = params.minLastEpVolBursts ?? null; // skip if last episode had fewer than N volume bursts
    this.params.signalCooldownMs = params.signalCooldownMs ?? 0;
    this.params.debug = params.debug ?? false;

    // Reset all stateful tracking
    this._reset();
    this.lastUpdateTs = null;
  }

  _reset() {
    // Per-RTH-session state
    this._sessionDate = null;
    this._sessionHigh = null;     // running max of RTH highs
    this._sessionLow = null;      // running min of RTH lows
    // Per-hour state
    this._curHourKey = null;
    this._curHourHigh = -Infinity;
    this._curHourLow = Infinity;
    this._prevHourHigh = null;
    this._prevHourLow = null;
    // Per (date, levelType) episode tracking
    this._levelState = new Map();  // key: `${date}|${levelType}` → { episodes, inEpisode, noTouchStreak }
    this._lastSymbol = null;
    // 1m bar rolling buffer (for 5m/15m aggregation)
    this._candleBuffer = [];
  }

  reset() {
    super.reset();
    this._reset();
  }

  _toEt(ts) {
    const d = new Date(ts);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short',
    }).formatToParts(d);
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10) % 24;
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
    const year = parts.find(p => p.type === 'year')?.value || '';
    const month = parts.find(p => p.type === 'month')?.value || '';
    const day = parts.find(p => p.type === 'day')?.value || '';
    const weekday = parts.find(p => p.type === 'weekday')?.value || '';
    return {
      hour, minute,
      timeInMinutes: hour * 60 + minute,
      date: `${year}-${month}-${day}`,
      weekday,
    };
  }

  _isInEntryWindow(et) {
    if (et.weekday === 'Sat' || et.weekday === 'Sun') return false;
    if (this.params.blockedHoursEt && this.params.blockedHoursEt.includes(et.hour)) return false;
    if (this.params.disableEntryWindow) return true;
    const startMin = this.params.entryWindowStartHour * 60 + this.params.entryWindowStartMinute;
    const endMin = this.params.entryWindowEndHour * 60 + this.params.entryWindowEndMinute;
    return et.timeInMinutes >= startMin && et.timeInMinutes < endMin;
  }

  // Update per-bar rolling state (BEFORE checking touches, but the level VALUES
  // used for the touch check are the pre-update values — so a candle that
  // pushes a new session high doesn't count as "touching" the old SH).
  _updateRollingState(c, et) {
    // Reset at ET day boundary
    if (this._sessionDate !== et.date) {
      this._sessionDate = et.date;
      this._sessionHigh = null;
      this._sessionLow = null;
      this._levelState = new Map();
      // Note: prev-hour H/L is preserved across day boundary on purpose
      // (overnight session pivots), but we'll only fire in entry window.
    }
    // Hour rollover
    const hourKey = `${et.date}T${String(et.hour).padStart(2, '0')}`;
    if (this._curHourKey !== hourKey) {
      if (this._curHourKey !== null && this._curHourHigh > -Infinity) {
        this._prevHourHigh = this._curHourHigh;
        this._prevHourLow = this._curHourLow;
      }
      this._curHourKey = hourKey;
      this._curHourHigh = -Infinity;
      this._curHourLow = Infinity;
    }
  }

  _commitBarToRollingState(c, et) {
    // Update hourly H/L AFTER touch check (so prior-hour H/L reflects the
    // previous hour, not this one)
    if (c.high > this._curHourHigh) this._curHourHigh = c.high;
    if (c.low < this._curHourLow) this._curHourLow = c.low;

    // Session H/L only during RTH
    const inRTH = et.timeInMinutes >= RTH_START_MIN && et.timeInMinutes < RTH_END_MIN;
    if (inRTH) {
      this._sessionHigh = this._sessionHigh == null ? c.high : Math.max(this._sessionHigh, c.high);
      this._sessionLow = this._sessionLow == null ? c.low : Math.min(this._sessionLow, c.low);
    }
  }

  _getActiveLevels(marketData, ts) {
    // In 'fade' mode: resistance levels (PRH/SH) → short; support levels (PRL/SL) → long
    // In 'continuation' mode: flip the side — bet the level breaks (retest entry in break direction)
    const flip = this.params.directionMode === 'continuation';
    const out = [];
    if (this.params.levels.includes('PRH') && this._prevHourHigh != null) {
      out.push({ type: 'PRH', price: this._prevHourHigh, side: flip ? 'long' : 'short' });
    }
    if (this.params.levels.includes('PRL') && this._prevHourLow != null) {
      out.push({ type: 'PRL', price: this._prevHourLow, side: flip ? 'short' : 'long' });
    }
    if (this.params.levels.includes('SH') && this._sessionHigh != null) {
      out.push({ type: 'SH', price: this._sessionHigh, side: flip ? 'long' : 'short' });
    }
    if (this.params.levels.includes('SL') && this._sessionLow != null) {
      out.push({ type: 'SL', price: this._sessionLow, side: flip ? 'short' : 'long' });
    }
    // GEX levels from snapshot (with snap_lag correction for lookahead)
    if (this.params.includeGexLevels && marketData && ts != null) {
      const lagTs = ts - this.params.snapLagMin * 60_000;
      const gexSnap = marketData.gexLoader?.getGexLevels?.(new Date(lagTs)) || marketData.gexLevels;
      if (gexSnap) {
        const want = this.params.gexLevelTypes;
        if (want.includes('call_wall') && gexSnap.call_wall != null) {
          out.push({ type: 'call_wall', price: gexSnap.call_wall, side: flip ? 'long' : 'short' });
        }
        if (want.includes('put_wall') && gexSnap.put_wall != null) {
          out.push({ type: 'put_wall', price: gexSnap.put_wall, side: flip ? 'short' : 'long' });
        }
        // Skip gamma_flip — unsided, complicates direction
        if (Array.isArray(gexSnap.resistance)) {
          for (let i = 0; i < gexSnap.resistance.length && i < 5; i++) {
            const t = `R${i + 1}`;
            if (want.includes(t) && gexSnap.resistance[i] != null) {
              out.push({ type: t, price: gexSnap.resistance[i], side: flip ? 'long' : 'short' });
            }
          }
        }
        if (Array.isArray(gexSnap.support)) {
          for (let i = 0; i < gexSnap.support.length && i < 5; i++) {
            const t = `S${i + 1}`;
            if (want.includes(t) && gexSnap.support[i] != null) {
              out.push({ type: t, price: gexSnap.support[i], side: flip ? 'short' : 'long' });
            }
          }
        }
      }
    }
    return out;
  }

  _getLevelState(levelType) {
    const key = `${this._sessionDate}|${levelType}`;
    if (!this._levelState.has(key)) {
      this._levelState.set(key, {
        episodes: 0,
        inEpisode: false,
        noTouchStreak: 0,
        curEpMaxPen: 0,        // current episode: max points past level reached
        curEpBars: 0,          // current episode: bars touching
        curEpRej5m: 0,         // current episode: 5m rejection wick count
        curEpRej15m: 0,        // current episode: 15m rejection wick count
        curEpVolBursts: 0,     // current episode: volume burst count
        lastEpMaxPen: null,    // last completed episode's max penetration
        lastEpBars: null,      // last completed episode's bar count
        lastEpRej5m: null,     // last completed episode's 5m rejection wicks
        lastEpRej15m: null,    // last completed episode's 15m rejection wicks
        lastEpVolBursts: null, // last completed episode's volume burst count
      });
    }
    return this._levelState.get(key);
  }

  // Aggregate N 1m bars into a single OHLCV bar
  _aggregateBars(bars) {
    if (!bars.length) return null;
    let high = -Infinity, low = Infinity, vol = 0;
    for (const b of bars) {
      if (b.high > high) high = b.high;
      if (b.low < low) low = b.low;
      vol += b.volume || 0;
    }
    return {
      open: bars[0].open,
      high,
      low,
      close: bars[bars.length - 1].close,
      volume: vol,
    };
  }

  // Is this aggregated bar a "rejection wick" at the level?
  //   side='short' (resistance-like): bar wicked above the level and closed back below
  //   side='long'  (support-like):    bar wicked below the level and closed back above
  _isRejectionWick(bar, levelPrice, side) {
    if (!bar) return false;
    const minWick = this.params.rejectionWickMinPts;
    if (side === 'short') {
      if (bar.high < levelPrice) return false;       // never reached level
      if (bar.close >= levelPrice) return false;     // didn't close back below
      const bodyTop = Math.max(bar.open, bar.close);
      return (bar.high - bodyTop) >= minWick;
    }
    if (side === 'long') {
      if (bar.low > levelPrice) return false;
      if (bar.close <= levelPrice) return false;
      const bodyBot = Math.min(bar.open, bar.close);
      return (bodyBot - bar.low) >= minWick;
    }
    return false;
  }

  _isRegimeAllowed(marketData, ts) {
    const blocked = this.params.blockedRegimes || [];
    if (blocked.length === 0) return true;
    const lagTs = ts - this.params.snapLagMin * 60_000;
    const snap = marketData?.gexLoader?.getGexLevels?.(new Date(lagTs)) || marketData?.gexLevels;
    const regime = snap?.regime || snap?.gex_regime || null;
    if (!regime) return true;  // no regime info → don't block
    return !blocked.includes(regime);
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    if (!candle) return null;
    const ts = this.toMs(candle.timestamp);
    this.lastUpdateTs = ts;

    // Reset rolling state on symbol change
    if (candle.symbol && this._lastSymbol && candle.symbol !== this._lastSymbol) {
      this._reset();
    }
    if (candle.symbol) this._lastSymbol = candle.symbol;

    const et = this._toEt(ts);
    this._updateRollingState(candle, et);

    // Maintain 1m bar buffer for 5m/15m aggregation + burst detection.
    // Hold lookback+1 to allow burst check (need lookback prior bars + current).
    const bufCap = Math.max(30, this.params.volBurstLookback + 1);
    this._candleBuffer.push({ timestamp: ts, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume || 0 });
    if (this._candleBuffer.length > bufCap) this._candleBuffer.shift();

    // Build active levels (using PRE-update values for derived; GEX from lookahead-corrected snap)
    const activeLevels = this._getActiveLevels(marketData, ts);

    // Check if a 5m or 15m bar just completed (using ET minute)
    // A 5m bar covers minutes [floor(T/5)*5, floor(T/5)*5+4]. It completes when T%5 == 4.
    // A 15m bar covers minutes [floor(T/15)*15, ...]. It completes when T%15 == 14.
    const finalized5m = (et.minute % 5 === 4) && this._candleBuffer.length >= 5
      ? this._aggregateBars(this._candleBuffer.slice(-5))
      : null;
    const finalized15m = (et.minute % 15 === 14) && this._candleBuffer.length >= 15
      ? this._aggregateBars(this._candleBuffer.slice(-15))
      : null;

    // For each active level whose state has an open episode: check if the just-completed
    // 5m or 15m bar was a rejection wick at this level → increment counter
    if (finalized5m || finalized15m) {
      for (const lvl of activeLevels) {
        const st = this._getLevelState(lvl.type);
        if (!st.inEpisode) continue;
        if (finalized5m && this._isRejectionWick(finalized5m, lvl.price, lvl.side)) {
          st.curEpRej5m++;
        }
        if (finalized15m && this._isRejectionWick(finalized15m, lvl.price, lvl.side)) {
          st.curEpRej15m++;
        }
      }
    }

    // Volume burst detection: is THIS 1m bar's volume >= volBurstMult × trailing mean?
    // Use the buffer's prior `volBurstLookback` bars (excluding current).
    let isBurst = false;
    const lookback = this.params.volBurstLookback;
    if (this._candleBuffer.length >= lookback + 1) {
      // Exclude current (last) bar from the mean
      const prior = this._candleBuffer.slice(-1 - lookback, -1);
      let sum = 0;
      for (const b of prior) sum += b.volume || 0;
      const mean = sum / prior.length;
      if (mean > 0 && (candle.volume || 0) >= this.params.volBurstMult * mean) {
        isBurst = true;
      }
    }

    // Process touches & advance episode state per level
    let candidateSignal = null;
    const windowOK = this._isInEntryWindow(et);

    for (const lvl of activeLevels) {
      const touches = candle.low <= lvl.price && lvl.price <= candle.high;
      const st = this._getLevelState(lvl.type);
      if (touches) {
        st.noTouchStreak = 0;
        // Update current episode tracking
        let pen = 0;
        if (lvl.side === 'short') {  // resistance-like → penetration = how far above the level
          pen = Math.max(0, candle.high - lvl.price);
        } else if (lvl.side === 'long') {  // support-like → penetration = how far below the level
          pen = Math.max(0, lvl.price - candle.low);
        } else {
          pen = Math.max(Math.max(0, candle.high - lvl.price), Math.max(0, lvl.price - candle.low));
        }
        if (pen > st.curEpMaxPen) st.curEpMaxPen = pen;
        if (isBurst) st.curEpVolBursts++;
        if (!st.inEpisode) {
          // New episode begins
          st.inEpisode = true;
          st.episodes++;
          st.curEpBars = 1;
          if (st.episodes >= this.params.minEpisodeNum && windowOK && candidateSignal == null) {
            // Apply quality filters from previous episode (T1)
            const passesPenetration = this.params.maxLastEpPenetrationPts == null
              || st.lastEpMaxPen == null
              || st.lastEpMaxPen <= this.params.maxLastEpPenetrationPts;
            const passesBars = this.params.minLastEpBarsInZone == null
              || st.lastEpBars == null
              || st.lastEpBars >= this.params.minLastEpBarsInZone;
            const passesRej5m = this.params.minLastEpRej5m == null
              || st.lastEpRej5m == null
              || st.lastEpRej5m >= this.params.minLastEpRej5m;
            const passesRej15m = this.params.minLastEpRej15m == null
              || st.lastEpRej15m == null
              || st.lastEpRej15m >= this.params.minLastEpRej15m;
            const passesVolBurst = this.params.minLastEpVolBursts == null
              || st.lastEpVolBursts == null
              || st.lastEpVolBursts >= this.params.minLastEpVolBursts;
            if (passesPenetration && passesBars && passesRej5m && passesRej15m && passesVolBurst && this._isRegimeAllowed(marketData, ts)) {
              candidateSignal = {
                level: lvl,
                episodeNum: st.episodes,
                lastEpMaxPen: st.lastEpMaxPen,
                lastEpBars: st.lastEpBars,
                lastEpRej5m: st.lastEpRej5m,
                lastEpRej15m: st.lastEpRej15m,
              };
            }
          }
        } else {
          st.curEpBars++;
        }
      } else {
        // Not touching
        if (st.inEpisode) {
          st.noTouchStreak++;
          if (st.noTouchStreak >= EXIT_PERSISTENCE_BARS) {
            // Close episode — save metrics as "last episode"
            st.inEpisode = false;
            st.noTouchStreak = 0;
            st.lastEpMaxPen = st.curEpMaxPen;
            st.lastEpBars = st.curEpBars;
            st.lastEpRej5m = st.curEpRej5m;
            st.lastEpRej15m = st.curEpRej15m;
            st.lastEpVolBursts = st.curEpVolBursts;
            st.curEpMaxPen = 0;
            st.curEpBars = 0;
            st.curEpRej5m = 0;
            st.curEpRej15m = 0;
            st.curEpVolBursts = 0;
          }
        }
      }
    }

    // Commit bar to rolling state AFTER touch checks
    this._commitBarToRollingState(candle, et);

    if (!candidateSignal) return null;
    if (!this.checkCooldown(ts, this.params.signalCooldownMs)) return null;

    // Build limit-order signal at the level price
    const lvl = candidateSignal.level;
    const side = lvl.side;  // 'long' or 'short'
    const entryPrice = lvl.price;
    const stopLoss = side === 'long' ? entryPrice - this.params.stopPts : entryPrice + this.params.stopPts;
    const takeProfit = side === 'long' ? entryPrice + this.params.targetPts : entryPrice - this.params.targetPts;

    this.updateLastSignalTime(ts);
    const signal = {
      timestamp: ts,
      side,
      price: entryPrice,
      strategy: 'GEX_LEVEL_FADE',
      action: 'place_limit',
      symbol: this.params.tradingSymbol,
      quantity: this.params.defaultQuantity,
      stopLoss, takeProfit,
      // Anchor stop/target to actual fill price (engine re-anchors when these are set).
      // Without this, favorable-fill entries (next-bar open beyond the level) leave the
      // stop misaligned to the SIGNAL price, often on the wrong side of actualEntry,
      // producing phantom "stop_loss"-labelled positive PnL exits.
      stopDistance: this.params.stopPts,
      targetDistance: this.params.targetPts,
      timeoutCandles: this.params.limitTimeoutBars,
      maxHoldBars: this.params.maxHoldBars,
      levelType: lvl.type,
      levelPrice: lvl.price,
      episodeNum: candidateSignal.episodeNum,
      // Mirror keys for orchestrator
      stop_loss: stopLoss,
      take_profit: takeProfit,
    };
    if (this.params.trailingTrigger > 0 && this.params.trailingOffset > 0) {
      signal.trailingTrigger = this.params.trailingTrigger;
      signal.trailingOffset = this.params.trailingOffset;
    }
    if (this.params.breakevenTrigger > 0) {
      signal.breakevenStop = true;
      signal.breakevenTrigger = this.params.breakevenTrigger;
      signal.breakevenOffset = this.params.breakevenOffset;
    }
    if (this.params.debug) {
      console.log(`[GLF] ${side.toUpperCase()} @${entryPrice.toFixed(2)} ${lvl.type} ep#${candidateSignal.episodeNum} sl=${stopLoss.toFixed(2)} tp=${takeProfit.toFixed(2)}`);
    }
    return signal;
  }

  onPositionClosed(info) {
    if (info?.timestamp) this.lastSignalTime = this.toMs(info.timestamp);
  }

  getName() { return 'GEX_LEVEL_FADE'; }

  getInternalState() {
    return {
      sessionDate: this._sessionDate,
      sessionHigh: this._sessionHigh,
      sessionLow: this._sessionLow,
      prevHourHigh: this._prevHourHigh,
      prevHourLow: this._prevHourLow,
      levelStateKeys: this._levelState.size,
      lastUpdateTs: this.lastUpdateTs,
    };
  }
}

export default GexLevelFadeStrategy;
