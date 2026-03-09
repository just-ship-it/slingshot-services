/**
 * NQ-Leads-ES Strategy
 *
 * When NQ makes a large 1-minute move (>threshold), enter ES in the same
 * direction for a short hold period. Filtered by GEX regime.
 *
 * Research basis (es-nq-gex-deep-dive.js):
 *   - NQ leads ES by 1 minute (cross-correlation r=0.242)
 *   - Positive GEX regime: 66-80% win rate, PF 3-10x depending on threshold
 *   - Profitable every year 2023-2025, all sessions, survives 2-tick slippage
 *   - Best configs: 0.15-0.25% threshold, 3-5 bar hold, positive GEX
 *
 * Backtest engine runs this on ES data (--ticker ES). The strategy lazy-loads
 * NQ continuous 1m candles and both NQ + ES intraday GEX on first evaluation.
 *
 * Usage:
 *   node index.js --ticker ES --strategy nq-leads-es --start 2023-03-28 --end 2025-12-31 \
 *     --timeframe 1m --nq-threshold 0.15 --hold-bars 5 --gex-regime positive
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BaseStrategy } from './base-strategy.js';
import { isValidCandle } from './strategy-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class NqLeadsEsStrategy extends BaseStrategy {
  static getDataRequirements() {
    return {
      candles: { baseSymbol: 'ES' },
      gex: { etfSymbol: 'SPY', futuresSymbol: 'ES' },
      lt: false,
      ivSkew: false,
    };
  }

  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      // Signal threshold: min NQ 1m return to trigger
      nqThreshold: 0.0015,         // 0.15% default

      // Hold period in bars (1m bars)
      holdBars: 5,

      // GEX regime filter: 'positive', 'negative', 'any', or 'positive_or_neutral'
      gexRegime: 'any',

      // Session filter
      useSessionFilter: false,
      allowedSessions: ['rth_open', 'rth_mid', 'rth_close', 'overnight'],

      // Exit management
      targetPoints: 0,             // 0 = time-based exit only (hold for holdBars)
      stopPoints: 0,               // 0 = no stop (pure time-based)
      maxHoldBars: 5,              // Matches holdBars by default

      // Cooldown
      signalCooldownMs: 0,         // No cooldown — every qualifying bar is a signal

      // Symbol
      tradingSymbol: 'ES1!',
      defaultQuantity: 1,

      // Data directory for companion NQ data
      dataDir: path.join(__dirname, '..', '..', 'backtest-engine', 'data'),
    };

    this.params = { ...this.defaultParams, ...params };

    // Sync maxHoldBars with holdBars if not explicitly set
    if (!params.maxHoldBars) {
      this.params.maxHoldBars = this.params.holdBars;
    }

    // Companion data (lazy loaded)
    this._nqMap = null;       // timestamp -> NQ candle
    this._nqGEX = null;       // sorted array of NQ GEX snapshots
    this._esGEX = null;       // sorted array of ES GEX snapshots
    this._prevNqCandle = null; // previous NQ candle for return calc
    this._initDone = false;
  }

  // ─── Lazy Data Loading ─────────────────────────────────────────────────────

  _loadCompanionData() {
    if (this._initDone) return;
    this._initDone = true;

    const dataDir = this.params.dataDir;

    // Load NQ continuous 1m candles
    const nqPath = path.join(dataDir, 'ohlcv', 'nq', 'NQ_ohlcv_1m_continuous.csv');
    if (!fs.existsSync(nqPath)) {
      console.warn(`[NQ_LEADS_ES] NQ continuous data not found: ${nqPath}`);
      return;
    }

    console.log('[NQ_LEADS_ES] Loading NQ companion data...');
    const nqContent = fs.readFileSync(nqPath, 'utf-8');
    const lines = nqContent.split('\n');
    const header = lines[0];

    // CSV columns: ts_event,open,high,low,close,volume,symbol,contract
    this._nqMap = new Map();
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length < 5) continue;
      const ts = new Date(parts[0]).getTime();
      if (isNaN(ts)) continue;
      this._nqMap.set(ts, {
        timestamp: ts,
        open: parseFloat(parts[1]),
        high: parseFloat(parts[2]),
        low: parseFloat(parts[3]),
        close: parseFloat(parts[4]),
        volume: parseFloat(parts[5]) || 0,
      });
    }
    console.log(`[NQ_LEADS_ES] Loaded ${this._nqMap.size.toLocaleString()} NQ candles`);

    // Load NQ + ES GEX intraday JSON
    this._nqGEX = this._loadGEXSnapshots('nq', dataDir);
    this._esGEX = this._loadGEXSnapshots('es', dataDir);
  }

  _loadGEXSnapshots(product, dataDir) {
    const dir = path.join(dataDir, 'gex', product);
    if (!fs.existsSync(dir)) return [];

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f.startsWith(`${product}_gex_`));
    files.sort();

    const snapshots = [];
    for (const file of files) {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
      if (!data.data) continue;
      for (const snap of data.data) {
        const ts = new Date(snap.timestamp).getTime();
        if (!isNaN(ts)) snapshots.push({ ...snap, timestamp_ms: ts });
      }
    }
    snapshots.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
    console.log(`[NQ_LEADS_ES] Loaded ${snapshots.length.toLocaleString()} ${product.toUpperCase()} GEX snapshots`);
    return snapshots;
  }

  _getGEXAt(snapshots, targetMs) {
    if (!snapshots || snapshots.length === 0) return null;
    if (targetMs < snapshots[0].timestamp_ms) return null;
    let lo = 0, hi = snapshots.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (snapshots[mid].timestamp_ms <= targetMs) lo = mid;
      else hi = mid - 1;
    }
    const snap = snapshots[lo];
    if (targetMs - snap.timestamp_ms > 20 * 60 * 1000) return null;
    return snap;
  }

  // ─── Session Classification ────────────────────────────────────────────────

  _getSession(timestamp) {
    const d = new Date(timestamp);
    // Approximate ET by subtracting 5h (ignoring DST for session bucketing)
    const etH = (d.getUTCHours() - 5 + 24) % 24;
    const etM = d.getUTCMinutes();
    const etMin = etH * 60 + etM;

    if (etMin >= 570 && etMin < 630) return 'rth_open';      // 9:30-10:30
    if (etMin >= 630 && etMin < 900) return 'rth_mid';        // 10:30-15:00
    if (etMin >= 900 && etMin < 960) return 'rth_close';      // 15:00-16:00
    return 'overnight';
  }

  // ─── GEX Regime Classification ─────────────────────────────────────────────

  _classifyRegime(nqSnap, esSnap) {
    if (!nqSnap || !esSnap) return 'no_gex';

    const nqS = nqSnap.regime?.includes('positive') ? 'pos' : nqSnap.regime?.includes('negative') ? 'neg' : 'neut';
    const esS = esSnap.regime?.includes('positive') ? 'pos' : esSnap.regime?.includes('negative') ? 'neg' : 'neut';

    if (nqS === 'pos' && esS === 'pos') return 'positive';
    if (nqS === 'neg' && esS === 'neg') return 'negative';
    if (nqS === 'neut' && esS === 'neut') return 'neutral';
    return 'mixed';
  }

  _passesRegimeFilter(regime) {
    const filter = this.params.gexRegime;
    if (filter === 'any') return true;
    if (filter === 'positive_or_neutral') return regime === 'positive' || regime === 'neutral';
    return regime === filter;
  }

  // ─── Core Signal Logic ─────────────────────────────────────────────────────

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    if (!isValidCandle(candle) || !isValidCandle(prevCandle)) return null;

    // Lazy load companion data on first call
    this._loadCompanionData();
    if (!this._nqMap || this._nqMap.size === 0) return null;

    const ts = candle.timestamp;

    // Get current and previous NQ candles at this timestamp
    const nqCurr = this._nqMap.get(ts);
    const nqPrev = this._prevNqCandle;
    this._prevNqCandle = nqCurr;

    if (!nqCurr || !nqPrev) return null;

    // Compute NQ 1-minute return
    const nqReturn = (nqCurr.close - nqPrev.close) / nqPrev.close;

    // Check threshold
    if (Math.abs(nqReturn) < this.params.nqThreshold) return null;

    // Cooldown check
    if (this.params.signalCooldownMs > 0 && !this.checkCooldown(ts, this.params.signalCooldownMs)) return null;

    // Session filter
    if (this.params.useSessionFilter) {
      const session = this._getSession(ts);
      if (!this.params.allowedSessions.includes(session)) return null;
    }

    // GEX regime filter
    const nqSnap = this._getGEXAt(this._nqGEX, ts);
    const esSnap = this._getGEXAt(this._esGEX, ts);
    const regime = this._classifyRegime(nqSnap, esSnap);

    if (!this._passesRegimeFilter(regime)) return null;

    // Generate signal: trade ES in NQ's direction
    const side = nqReturn > 0 ? 'buy' : 'sell';

    this.updateLastSignalTime(ts);

    const signal = {
      strategy: 'NQ_LEADS_ES',
      action: 'place_market',
      side,
      symbol: this.params.tradingSymbol,
      quantity: this.params.defaultQuantity,
      entryPrice: candle.close,
      maxHoldBars: this.params.maxHoldBars,
      timestamp: new Date(ts).toISOString(),
      metadata: {
        nqReturn: Math.round(nqReturn * 10000) / 100, // in bps
        nqPrice: nqCurr.close,
        esPrice: candle.close,
        regime,
        nqRegime: nqSnap?.regime || 'unknown',
        esRegime: esSnap?.regime || 'unknown',
        session: this._getSession(ts),
      }
    };

    // Optional stop/target
    if (this.params.stopPoints > 0) {
      signal.stop_loss = side === 'buy'
        ? candle.close - this.params.stopPoints
        : candle.close + this.params.stopPoints;
    }
    if (this.params.targetPoints > 0) {
      signal.take_profit = side === 'buy'
        ? candle.close + this.params.targetPoints
        : candle.close - this.params.targetPoints;
    }

    return signal;
  }
}

export default NqLeadsEsStrategy;
