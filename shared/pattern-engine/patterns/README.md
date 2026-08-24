# Detector contract

A detector module exports a default object:

```js
export default {
  id: 'inside-bar',                 // detector id
  family: 'candle',                 // candle | chart-continuation | chart-reversal | chart-bilateral | structure | event
  tfs: null,                        // optional whitelist of tfs
  params: { ... },                  // defaults (engine merges per-tf overrides)
  create({ tf, tfMin, product, params }) {
    return {
      onBar(bar, f, ctx) {},        // every closed tf bar; f = BarFeatures.describe(bar) (normalizers from PRIOR bars only)
      onPivot(pivot, gen, ctx) {},  // optional; gen = 'fractal' | 'zigzag'; pivot.confirmedAt === ctx.now
    };
  },
};
```

`ctx` = `{ tf, tfMin, product, symbol, now (closeTs of this bar), bar, f, barIdx, bars (BarRing: .at(-1) latest,
.last(n), .length), features (BarFeatures), pivots: { fractal: PivotTrack, zigzag: PivotTrack }, zigzagProvisional,
session: { open, high, low, rthOpen, prevHigh, prevLow, prevClose }, emit(e) }`.

`ctx.emit(e)` where `e = { patternId, family?, key, state, direction, levels, anchors, geometry?, note? }`:
- `key`: stable per instance (usually `${firstAnchorTs}`); engine builds `instanceId = product:tf:patternId:key`.
- `state`: usually `'forming'`. After a `forming` emission the engine's LifecycleTracker owns the
  instance: it emits triggered / confirmed / invalidated / expired / false-break / throwback / busted /
  resolved-*. A detector MAY emit `'invalidated'` itself for geometry violations (e.g. new pivot above head).
- `levels` (raw price): directional → `{ trigger, triggerSide:'above'|'below', invalidation, target, target2?, extra? }`;
  bilateral → `{ upper, lower, upperSlope?, lowerSlope?, targetUp, targetDown, invalidationUp?, invalidationDown?, midline? }`
  (slopes in points per tf bar, applied from the emission bar forward). Directional sloped triggers: `triggerSlope`, `invalidationSlope`.
- `anchors`: `[ { role, ts, price, confirmedAt } ]` chronological; **confirmedAt ≤ ctx.now or the engine throws**.
  For bar-anchors use `confirmedAt = bar.closeTs`. For pivots use `pivot.confirmedAt`.
- `geometry`: ATR-normalized descriptors (`durationBars, heightAtr, priorMoveAtr, priorMoveBars, retracePct, slopeAtrPerBar,
  touchesUpper, touchesLower, volumeRatio, fitQuality, params`), plus any pattern-specific numbers.

Rules: use only `ctx.bars` (closed bars) and confirmed pivots. Never read `bar` fields for a bar that hasn't closed
(you can't — the engine only passes closed bars). Keep per-instance state in the detector; the engine dedups
repeated `forming` for the same instanceId. ATR-scale every threshold (`f.atr`, `f.scale`); floor in ticks (0.25).
