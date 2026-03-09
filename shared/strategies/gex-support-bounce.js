/**
 * GEX Support Bounce Strategy
 *
 * Enters long NQ when price is near a GEX support level (put_wall or support),
 * expecting a bounce. Optionally filters by whether ES is NOT near a level
 * (the "NQ pinned, ES free" setup from research).
 *
 * Research basis (es-nq-gex-deep-dive.js):
 *   - NQ near support: 69.6% bounce rate at 15m (n=263)
 *   - ES near resistance: 61.2% rejection rate (n=322)
 *   - NQ at support spread trade: PF 2.63 at 15m (n=87)
 *   - GEX levels pin ES (15% less movement) but NOT NQ — NQ bounces off support
 *   - NQ gamma_flip has lowest forward movement (pinning effect)
 *
 * Runs on NQ data (--ticker NQ). Optionally loads ES companion data for the
 * "ES free" filter and ES GEX for cross-product confirmation.
 *
 * Usage:
 *   node index.js --ticker NQ --strategy gex-support-bounce --start 2023-03-28 --end 2025-12-31 \
 *     --timeframe 1m --proximity-pct 0.10 --target-points 20 --stop-points 12
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BaseStrategy } from './base-strategy.js';
import { isValidCandle } from './strategy-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class GexSupportBounceStrategy extends BaseStrategy {
  static getDataRequirements() {
    return {
      candles: { baseSymbol: 'NQ' },
      gex: { etfSymbol: 'QQQ', futuresSymbol: 'NQ' },
      lt: false,
      ivSkew: false,
    };
  }

  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      // Proximity: max distance from GEX level as % of price
      proximityPct: 0.10,          // 0.10% of NQ price ≈ 21 pts

      // Which level types trigger entries
      // 'support_only': support + put_wall levels
      // 'resistance_only': resistance + call_wall levels (for shorts)
      // 'all': any GEX level
      levelTypes: 'support_only',

      // Direction: 'long' (bounce off support), 'short' (reject at resistance), 'both'
      direction: 'long',

      // Require ES to be "free" (far from its own GEX levels) — the cross-product filter
      requireEsFree: false,
      esFreeMultiplier: 2.0,       // ES must be > proximityPct * multiplier from its nearest level

      // Exit management
      targetPoints: 20,
      stopPoints: 12,
      maxHoldBars: 30,             // 30 minutes

      // Trailing stop
      useTrailingStop: false,
      trailingTrigger: 8,          // Activate after 8pts profit
      trailingOffset: 4,           // Trail 4pts behind

      // Cooldown
      signalCooldownMs: 5 * 60 * 1000,  // 5 min between signals

      // Session filter
      useSessionFilter: true,
      allowedSessions: ['rth_open', 'rth_mid', 'rth_close'],

      // Symbol
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,

      // Data directory
      dataDir: path.join(__dirname, '..', '..', 'backtest-engine', 'data'),
    };

    this.params = { ...this.defaultParams, ...params };

    // Companion data (lazy loaded)
    this._esGEX = null;
    this._esMap = null;
    this._initDone = false;
  }

  // ─── Lazy Data Loading ─────────────────────────────────────────────────────

  _loadCompanionData() {
    if (this._initDone) return;
    this._initDone = true;

    if (!this.params.requireEsFree) return; // Only load ES data if needed

    const dataDir = this.params.dataDir;

    // Load ES continuous 1m candles (for price lookups)
    const esPath = path.join(dataDir, 'ohlcv', 'es', 'ES_ohlcv_1m_continuous.csv');
    if (fs.existsSync(esPath)) {
      console.log('[GEX_BOUNCE] Loading ES companion data...');
      const content = fs.readFileSync(esPath, 'utf-8');
      const lines = content.split('\n');
      // CSV columns: ts_event,open,high,low,close,volume,symbol,contract
      this._esMap = new Map();
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',');
        if (parts.length < 5) continue;
        const ts = new Date(parts[0]).getTime();
        if (isNaN(ts)) continue;
        this._esMap.set(ts, {
          timestamp: ts,
          close: parseFloat(parts[4]),
        });
      }
      console.log(`[GEX_BOUNCE] Loaded ${this._esMap.size.toLocaleString()} ES candles`);
    }

    // Load ES GEX
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
    console.log(`[GEX_BOUNCE] Loaded ${snapshots.length.toLocaleString()} ${product.toUpperCase()} GEX snapshots`);
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

  // ─── GEX Level Analysis ────────────────────────────────────────────────────

  _findNearestLevel(gexLevels, price, filterTypes) {
    if (!gexLevels) return null;

    const candidates = [];

    // Build candidate list from GEX snapshot
    if (gexLevels.gamma_flip && this._typeAllowed('gamma_flip', filterTypes)) {
      candidates.push({ level: gexLevels.gamma_flip, type: 'gamma_flip' });
    }
    if (gexLevels.call_wall && this._typeAllowed('call_wall', filterTypes)) {
      candidates.push({ level: gexLevels.call_wall, type: 'call_wall' });
    }
    if (gexLevels.put_wall && this._typeAllowed('put_wall', filterTypes)) {
      candidates.push({ level: gexLevels.put_wall, type: 'put_wall' });
    }

    // Support and resistance arrays
    if (gexLevels.support && this._typeAllowed('support', filterTypes)) {
      for (const l of gexLevels.support) {
        if (l > 0) candidates.push({ level: l, type: 'support' });
      }
    }
    if (gexLevels.resistance && this._typeAllowed('resistance', filterTypes)) {
      for (const l of gexLevels.resistance) {
        if (l > 0) candidates.push({ level: l, type: 'resistance' });
      }
    }

    // Find nearest
    let best = null;
    let minDist = Infinity;
    for (const c of candidates) {
      const dist = Math.abs(price - c.level);
      if (dist < minDist) {
        minDist = dist;
        best = c;
      }
    }

    if (!best) return null;

    return {
      dist: minDist,
      distPct: minDist / price * 100,
      level: best.level,
      type: best.type,
      side: price >= best.level ? 'above' : 'below',
    };
  }

  _typeAllowed(type, filter) {
    if (filter === 'all') return true;
    if (filter === 'support_only') return type === 'support' || type === 'put_wall' || type === 'gamma_flip';
    if (filter === 'resistance_only') return type === 'resistance' || type === 'call_wall' || type === 'gamma_flip';
    return true;
  }

  // ─── Session Classification ────────────────────────────────────────────────

  _getSession(timestamp) {
    const d = new Date(timestamp);
    const etH = (d.getUTCHours() - 5 + 24) % 24;
    const etM = d.getUTCMinutes();
    const etMin = etH * 60 + etM;

    if (etMin >= 570 && etMin < 630) return 'rth_open';
    if (etMin >= 630 && etMin < 900) return 'rth_mid';
    if (etMin >= 900 && etMin < 960) return 'rth_close';
    return 'overnight';
  }

  // ─── Core Signal Logic ─────────────────────────────────────────────────────

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    if (!isValidCandle(candle) || !isValidCandle(prevCandle)) return null;

    // Lazy load companion data
    this._loadCompanionData();

    const ts = candle.timestamp;

    // Cooldown
    if (!this.checkCooldown(ts, this.params.signalCooldownMs)) return null;

    // Session filter
    if (this.params.useSessionFilter) {
      const session = this._getSession(ts);
      if (!this.params.allowedSessions.includes(session)) return null;
    }

    // Get GEX levels from marketData (provided by backtest engine for the primary product)
    const gexLevels = marketData?.gexLevels;
    if (!gexLevels) return null;

    // Determine which level types to check based on direction
    let filterTypes = this.params.levelTypes;
    if (this.params.direction === 'long') filterTypes = 'support_only';
    else if (this.params.direction === 'short') filterTypes = 'resistance_only';

    // Find nearest qualifying GEX level
    const nearest = this._findNearestLevel(gexLevels, candle.close, filterTypes);
    if (!nearest) return null;

    // Check proximity threshold
    if (nearest.distPct > this.params.proximityPct) return null;

    // Determine trade direction based on level type
    let side;
    if (this.params.direction === 'long') {
      // Long bounce off support: price should be near/at support
      side = 'buy';
    } else if (this.params.direction === 'short') {
      // Short rejection at resistance
      side = 'sell';
    } else {
      // Both: support → long, resistance → short
      const isSupport = nearest.type === 'support' || nearest.type === 'put_wall';
      side = isSupport ? 'buy' : 'sell';
    }

    // Optional: require ES to be "free" (far from its own GEX levels)
    if (this.params.requireEsFree && this._esGEX && this._esMap) {
      const esCandle = this._esMap.get(ts);
      const esSnap = this._getGEXAt(this._esGEX, ts);
      if (esCandle && esSnap) {
        const esNearest = this._findNearestLevel(esSnap, esCandle.close, 'all');
        if (esNearest && esNearest.distPct <= this.params.proximityPct * this.params.esFreeMultiplier) {
          return null; // ES is also near a level, skip
        }
      }
    }

    this.updateLastSignalTime(ts);

    // Build signal
    const entryPrice = candle.close;
    const stopPrice = side === 'buy'
      ? entryPrice - this.params.stopPoints
      : entryPrice + this.params.stopPoints;
    const targetPrice = side === 'buy'
      ? entryPrice + this.params.targetPoints
      : entryPrice - this.params.targetPoints;

    const signal = {
      strategy: 'GEX_SUPPORT_BOUNCE',
      action: 'place_market',
      side,
      symbol: this.params.tradingSymbol,
      quantity: this.params.defaultQuantity,
      entryPrice,
      stop_loss: stopPrice,
      take_profit: targetPrice,
      maxHoldBars: this.params.maxHoldBars,
      timestamp: new Date(ts).toISOString(),
      metadata: {
        nearestLevel: nearest.level,
        levelType: nearest.type,
        levelSide: nearest.side,
        distPoints: Math.round(nearest.dist * 100) / 100,
        distPct: Math.round(nearest.distPct * 1000) / 1000,
        regime: gexLevels.regime || 'unknown',
        session: this._getSession(ts),
      }
    };

    // Trailing stop
    if (this.params.useTrailingStop) {
      signal.trailing_trigger = this.params.trailingTrigger;
      signal.trailing_offset = this.params.trailingOffset;
    }

    return signal;
  }
}

export default GexSupportBounceStrategy;
