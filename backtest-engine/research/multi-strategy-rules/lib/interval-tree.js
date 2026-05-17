// Sweep-line overlap detector for trade intervals.
// Strict overlap semantics: trade A [entryA, exitA] and B [entryB, exitB] overlap iff
//   entryA < exitB AND entryB < exitA   (touching endpoints do NOT overlap)
// Achieved at tie-equal ts by processing 'end' events before 'start' events.

export function findPairwiseOverlaps(trades) {
  const events = [];
  for (const t of trades) {
    events.push({ ts: t.entryTime, kind: 'start', trade: t });
    events.push({ ts: t.exitTime,  kind: 'end',   trade: t });
  }
  // 'end' < 'start' on ties so a strict half-open semantic holds.
  events.sort((a, b) => a.ts - b.ts || (a.kind === 'end' ? -1 : 1));

  const active = new Set();
  const overlaps = [];

  for (const ev of events) {
    if (ev.kind === 'start') {
      for (const other of active) {
        if (other.strategyKey === ev.trade.strategyKey) continue; // intra-strategy not interesting
        overlaps.push(buildOverlap(ev.trade, other));
      }
      active.add(ev.trade);
    } else {
      active.delete(ev.trade);
    }
  }
  return overlaps;
}

function buildOverlap(t1, t2) {
  // Order alphabetically by strategyKey so dedup is trivial elsewhere.
  const [a, b] = t1.strategyKey < t2.strategyKey ? [t1, t2] : [t2, t1];
  const overlapStart = Math.max(a.entryTime, b.entryTime);
  const overlapEnd = Math.min(a.exitTime, b.exitTime);
  const overlapMs = Math.max(0, overlapEnd - overlapStart);
  return {
    strategyA: a.strategyKey,
    strategyB: b.strategyKey,
    sideA: a.side,
    sideB: b.side,
    type: a.side === b.side ? 'confluence' : 'conflict',
    entryA_ts: a.entryTime,
    entryB_ts: b.entryTime,
    exitA_ts: a.exitTime,
    exitB_ts: b.exitTime,
    overlap_start: overlapStart,
    overlap_end: overlapEnd,
    overlap_minutes: overlapMs / 60000,
    pnlA: a.netPnL,
    pnlB: b.netPnL,
    joint_pnl: a.netPnL + b.netPnL,
    tradeA_id: a.id,
    tradeB_id: b.id,
    tradeA_ref: a,
    tradeB_ref: b,
  };
}

export function findThreeWayOverlaps(trades) {
  const events = [];
  for (const t of trades) {
    events.push({ ts: t.entryTime, kind: 'start', trade: t });
    events.push({ ts: t.exitTime,  kind: 'end',   trade: t });
  }
  events.sort((a, b) => a.ts - b.ts || (a.kind === 'end' ? -1 : 1));

  const active = new Set();
  const seen = new Set(); // dedup by sorted trade-id triple
  const triples = [];

  for (const ev of events) {
    if (ev.kind === 'start') {
      // Look for pairs in `active` that, combined with new trade, span 3 distinct strategies.
      const actArr = [...active];
      for (let i = 0; i < actArr.length; i++) {
        for (let j = i + 1; j < actArr.length; j++) {
          const set = new Set([ev.trade.strategyKey, actArr[i].strategyKey, actArr[j].strategyKey]);
          if (set.size !== 3) continue;
          const triple = [ev.trade, actArr[i], actArr[j]].sort((x, y) => x.id.localeCompare(y.id));
          const key = triple.map(t => t.id).join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          const overlapStart = Math.max(...triple.map(t => t.entryTime));
          const overlapEnd = Math.min(...triple.map(t => t.exitTime));
          if (overlapEnd <= overlapStart) continue; // touching only
          const sides = triple.map(t => t.side);
          const allSame = sides.every(s => s === sides[0]);
          triples.push({
            strategies: triple.map(t => t.strategyKey),
            ids: triple.map(t => t.id),
            sides,
            type: allSame ? `all-${sides[0]}` : 'mixed',
            overlap_start: overlapStart,
            overlap_end: overlapEnd,
            overlap_minutes: (overlapEnd - overlapStart) / 60000,
            joint_pnl: triple.reduce((s, t) => s + t.netPnL, 0),
            tradeRefs: triple,
          });
        }
      }
      active.add(ev.trade);
    } else {
      active.delete(ev.trade);
    }
  }
  return triples;
}

// Compute peak concurrency over time for a Model-A-style stacked book.
export function concurrencyHistogram(trades) {
  const events = [];
  for (const t of trades) {
    events.push({ ts: t.entryTime, delta: +1 });
    events.push({ ts: t.exitTime,  delta: -1 });
  }
  events.sort((a, b) => a.ts - b.ts || a.delta - b.delta); // exits before entries on ties
  let active = 0;
  const dwell = new Map(); // concurrency level → total ms spent there
  let lastTs = events.length ? events[0].ts : 0;
  for (const ev of events) {
    if (ev.ts > lastTs) {
      dwell.set(active, (dwell.get(active) || 0) + (ev.ts - lastTs));
      lastTs = ev.ts;
    }
    active += ev.delta;
  }
  return [...dwell.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([level, ms]) => ({ concurrency: level, totalMs: ms, totalHours: ms / 3600000 }));
}
