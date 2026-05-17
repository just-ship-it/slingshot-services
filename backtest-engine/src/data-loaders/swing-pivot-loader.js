/**
 * SwingPivotLoader — loads precomputed 9/9 swing pivots from
 * research/swing-pivots/NQ_swings_1m_9_9.csv.
 *
 * Each pivot: { ts, type ('high'|'low'), price, confirmedAt, symbol }.
 *
 * Live-honest convention: queries at time T only return pivots with
 * confirmedAt <= T. (A 9/9 pivot is only knowable 9 bars after its high/low,
 * so signals at T see swings confirmed up through T's bar minus 9 minutes.)
 *
 * Active-magnet query: getActiveSwings(timestamp, type, recencyMs)
 *   returns swings of `type` whose `ts >= timestamp - recencyMs` AND
 *   whose `confirmedAt <= timestamp`.
 */

import fs from 'fs';
import path from 'path';

export class SwingPivotLoader {
  constructor(filePath) {
    this.filePath = filePath;
    this.pivots = []; // chronologically sorted by ts
  }

  async load(startDate, endDate) {
    if (!fs.existsSync(this.filePath)) {
      throw new Error(`SwingPivotLoader: ${this.filePath} not found. Run scripts/precompute-swing-pivots.js first.`);
    }
    const startMs = startDate ? new Date(startDate + 'T00:00:00Z').getTime() : -Infinity;
    const endMs = endDate ? new Date(endDate + 'T23:59:59Z').getTime() : Infinity;

    const text = fs.readFileSync(this.filePath, 'utf8');
    const lines = text.split('\n');
    const header = lines[0].split(',');
    const iTs = header.indexOf('ts_event');
    const iType = header.indexOf('type');
    const iPrice = header.indexOf('price');
    const iConfirmedAt = header.indexOf('confirmed_at');
    const iSymbol = header.indexOf('symbol');

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const parts = line.split(',');
      const ts = Date.parse(parts[iTs]);
      // Filter by range; allow a bit of pre-roll for recency lookback
      if (ts < startMs - 8 * 60 * 60 * 1000 || ts > endMs) continue;
      this.pivots.push({
        ts,
        type: parts[iType],
        price: +parts[iPrice],
        confirmedAt: Date.parse(parts[iConfirmedAt]),
        symbol: parts[iSymbol],
      });
    }
    // Should already be sorted; defensively sort
    this.pivots.sort((a, b) => a.ts - b.ts);
  }

  /**
   * Returns swings of `type` ('high'|'low') confirmed at-or-before `timestamp`
   * within `recencyMs` of `timestamp`. Live-honest: a pivot is excluded if
   * its `confirmedAt` is after `timestamp` (we don't yet know about it).
   */
  getActiveSwings(timestamp, type, recencyMs) {
    const cutoffStart = timestamp - recencyMs;
    const result = [];
    // Linear scan is fine for ~36k pivots and ~few hundred signals per backtest
    for (const p of this.pivots) {
      if (p.type !== type) continue;
      if (p.ts < cutoffStart) continue;
      if (p.ts > timestamp) break; // sorted ascending; future
      if (p.confirmedAt > timestamp) continue; // confirmed after now → not live-visible
      result.push(p);
    }
    return result;
  }

  getStats() {
    if (this.pivots.length === 0) return { count: 0 };
    return {
      count: this.pivots.length,
      highs: this.pivots.filter(p => p.type === 'high').length,
      lows: this.pivots.filter(p => p.type === 'low').length,
      startDate: new Date(this.pivots[0].ts).toISOString(),
      endDate: new Date(this.pivots[this.pivots.length - 1].ts).toISOString(),
    };
  }
}
