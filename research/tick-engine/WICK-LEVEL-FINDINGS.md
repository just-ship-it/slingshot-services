# Wick & level anatomy — catalog + first results (2026-08-20)

## What was built (reusable, fast)

| asset | what it does |
|---|---|
| `wick-anatomy.js` | per-candle attribution of TIME and VOLUME to top-wick / body / bottom-wick, plus when each wick was made (volume-weighted centroid, extreme timing, first/last touch, re-probe count) |
| `build-wicks.js` | catalogs every 3m/5m/15m candle → `wicks/{NQ,ES}_{tf}_wicks.csv` (2.2M candles, ~30s total) |
| `zone-anatomy.js` | the same attribution around an **external level** — time/volume above, at, below; intensity; penetration; crossings |
| `levels.js` | level registry: LT (128k rows, 2021-01→2026-07) + causal GEX (804 days, 45.9k snapshots) with at-or-before knowability |
| `build-level-episodes.js` | every 15m window × every knowable level → anatomy + distance-matched **placebo** level |

Attribution splits each 1s bar's second and volume across zones by range overlap. Time is exact to
1 second; volume is an estimate — 1s OHLCV cannot say where inside the second a contract traded.
Verified by hand against raw 1s data (77.9% / 81.1% reported vs computed, exact match).

## Descriptive facts (new — these need 1s data, so no prior study had them)

- A candle is ~50% wick by time and volume: NQ 5m mean top 24.7% / body 50.6% / bottom 24.7% of time,
  25.7% / 48.4% / 25.9% of volume. ES runs ~5pp lower.
- **Wicks trade slightly hotter than bodies**: volume-share ÷ time-share ≈ 1.05 median in each wick
  vs 0.96 in the body.
- Wick timing is close to symmetric overall (volume-centroid 0.46–0.48 of the way through the candle)
  but strongly conditional on direction: in an UP candle the top wick forms late (0.672) and the
  bottom wick early (0.247) — mirrored for down candles.
- Big rejection wicks (≥50% of range) are **not single spikes**: mean 5.6 separate excursions into
  the wick zone, extreme printed 42% of the way through.

## Predictive results — all negative after controls

1. **Wick features vs next candle.** `upRel`, `upVolPct`, `wickSkew` are sign-consistent across
   NQ/ES × dev/val, and survive an own-return control (so not disguised mean reversion). But the
   spread is 0.02–0.03 ATR against a 0.045 ATR cost line at 5m. At 15m the decile tail clears cost on
   dev (0.040–0.087 vs 0.026) — but the validation cells are ~0.002. Not tradable.
2. **LT levels show a real damping footprint**: more time at the level (+0.017 dev / +0.007 val
   within 10 ticks), more volume, shallower penetration. This independently reproduces the one prior
   surviving level effect (A2's "LT follow-through damping") by a completely different method.
3. **GEX levels show essentially nothing** — intensity and penetration differences vs placebo are
   small and the gamma-regime conditioning (long-gamma-dampens / short-gamma-amplifies) **flips sign
   between dev and validation**. The dealer-flow footprint hypothesis is not supported by this data.
4. **The best cell — volume intensity at LT resistance** — is strong and controlled on NQ
   (dev −0.120, val −0.099, own-controlled −0.057) but **absent on ES** (−0.020 / +0.001).
5. **Neither tail converts to money.** The −0.12 spread comes from the *low*-intensity tail being
   +0.091, not the high tail being negative (−0.029). Honest 1s simulation:
   - short the absorption tail: dev −$2.2k/yr PF 0.96, val −$8.2k/yr PF 0.87
   - long the hollow tail: dev −$3.9k/yr PF 0.96, val −$3.8k/yr PF 0.97
   And the hollow-tail effect **fails its placebo control on validation** (real +0.086 vs displaced
   +0.081) — on val it is "quiet precedes up-moves", not a level effect.

## The structural lesson (third time this pattern has appeared)

A quintile **spread** is not an edge. The tradable quantity is the **absolute expectancy of the tail
you can actually trade**, and it must clear costs *after* the path (stops) has taken its cut. Every
candidate this month has died in exactly that gap: spread −0.12 ATR → tradable tail −0.03 ATR →
cost 0.026 ATR → PF 0.96 after stops. Future screens should report tail absolute expectancy net of
costs as the headline number, never the spread.
