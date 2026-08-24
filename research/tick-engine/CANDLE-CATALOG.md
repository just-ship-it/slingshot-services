# Candle micro-structure catalog (2026-08-20)

Everything here is computed from 1s OHLCV over the full history (NQ 67.6M bars / 1400 sessions,
ES 55.6M / 1293) and rebuilds in ~30 seconds. It is a **component library** — measurements meant to
be combined with price structure and other data, not standalone strategies.

## The four measurement families

| family | file | what it measures |
|---|---|---|
| **wick anatomy** (price-zone) | `wick-anatomy.js` | for top-wick / body / bottom-wick: share of the candle's TIME and VOLUME, volume intensity (vol÷time), when the wick formed (volume-weighted centroid), when the extreme printed, first/last touch, number of separate excursions |
| **time profile** (time-slice) | `time-profile.js` | volume / movement / signed-drive centroids; body built in the final 10s and 30s; volume in first vs last quarter; closing burst (final-10s volume rate ÷ candle average); path efficiency; sign reversals; **wild-close signatures** — late range traversed, whether the final seconds fought the candle's own direction, how far the close sits from the late extreme |
| **slice distribution** | `slice-profile.js` | the full 6-slice vectors of volume %, signed movement %, and range % — the shape itself, not a summary of it |
| **velocity / sweep** | `velocity.js` | largest range covered by any rolling 5s/10s/30s window, that window's share of the whole candle range, its direction and start time, how much of it was given back by the close, and the `sweepUp`/`sweepDn` composites (fast burst ≥50% of range that the candle then closed against) |

Plus **sequence features** across the last 3/5/10 candles (rejection counts, higher lows, shallowing
probes, compression, bottom-wick volume, volume trend, net move) and a **touch grid**
(`build-touchgrid.js`): first-touch time at 12 rungs above and below every decision point, which
prices EVERY target/stop pair from a single pass — so R/R can be *chosen* to fit a signal instead of
inherited from the geometry.

All of it is cross-referenced by time of day, day of week, and time of month.

## Outputs

```
wicks/{NQ,ES}_{3m,5m,15m}_wicks.csv     2.2M candles, full wick anatomy
reversal/NQ_3m_rev.csv                  70 columns: anatomy + time profile + slices + velocity + sequences
touchgrid/NQ_3m_grid.csv                first-touch ladder, 618,885 decision points
mtf/NQ_15m_3m_mtf.csv                   LTF decisions labelled by which side of the HTF candle broke
firstbreak/NQ_{3m,5m,15m}_fb.csv        single-candle high-vs-low first-break labels
level-episodes/{NQ,ES}_episodes.csv     level-relative anatomy vs distance-matched placebos
```

## The cost bar — the most useful number in this file

At 1 NQ contract, costs are ~2 ticks on a win and ~4 on a loss ($5 commission + slippage). For a
symmetric target/stop of K ticks, break-even requires:

| target = stop | P(win) needed | edge over a coin flip |
|---|---|---|
| 5 pts (20 tk) | 57.1% | **+7.1 pp** |
| 10 pts (40 tk) | 53.7% | +3.7 pp |
| 13 pts (52 tk) | 52.8% | +2.8 pp |
| 22 pts (88 tk) | 51.7% | +1.7 pp |

**Any feature family that shifts win probability by less than ~4 points cannot be traded at 1 lot.**
This is now a one-minute screen for any future idea.

## What the catalog delivers against that bar

| signal | edge | verdict |
|---|---|---|
| best single wick-anatomy feature | 1–2 pp | short |
| best multi-candle sequence feature (`netMove5/10`) | 1–3 pp | short |
| **late-seconds push (`moveLast10Rel`)** — fading it | **2.8 pp dev / 3.0 pp val, same sign** | strongest single feature found; still ~half the bar |
| 8 learned time-distribution shape clusters | none positive on both sets | — |
| `sweepUp` faded, all hours | ~0 | — |
| **`sweepUp` faded, 15:30–16:00 ET** | **+4.1 pp** (dev 0.529 / val 0.556) | fails the plateau test — see below |

Time of day is a real conditioner and behaves as expected: the sweep-fade is strongest into the RTH
close and **inverts overnight** (−2.8 pp — overnight sweeps continue rather than reverse). Time of
month and day of week showed nothing (all within ±1.8 pp, no dev/val consistency).

## Why the best cell was rejected

`sweepUp` faded in the closing window, T=52 / S=68, showed dev +$9.23 and val +$1.72 per trade. But
the neighbourhood test kills it — dev is uniformly positive across adjacent R/R cells while
validation swings from −$33.67 to +$1.72 to −$11.00 between neighbours. A real edge is a plateau; a
spike surrounded by noise is an artifact, and this cell is 1 of 432 combinations tested (144 R/R × 3
time windows). **Always run the neighbourhood test before believing an optimised R/R.**

## Honest status

The measurements are real, novel (they require 1s data, so no prior study in this repo had them),
fast, and reusable. The shapes they describe are genuinely visible in the market — a fast sweep that
gets rejected into the close really does behave differently from one overnight. What none of them do
yet is clear the 1-lot cost bar on their own, and the one combination test tried (requiring 2–3
signals to agree) made things worse rather than better, because the features are correlated.

## Addendum — the asymmetric / "tail" search (2026-08-20)

Prompted by the observation that mean-shift screening optimises the middle of the distribution,
which is exactly where costs and market makers live. Two extensions were run:

**1. Tight-stop asymmetry (5:1 to 28:1) at a 60-min horizon.** Dead on arrival: P(+112 ticks before
−20) is 10.4% when break-even needs 17.9%. The reason is structural — NQ's 5m ATR is ~66 ticks, so a
20-tick stop sits *inside the noise* and gets run over before any large move can develop. Asymmetric
payoffs do not help when the stop is smaller than the wiggle.

**2. Large targets with noise-respecting stops (T up to 520 ticks / 130 pts, S 112–160, 6-hour
horizon).** Here the no-signal baseline is POSITIVE for longs (+$8 to +$12/trade) — that is NQ's
drift, not skill, because 70–90% of these never touch a barrier and exit at market. Measuring excess
over a same-side baseline found 8 configs positive on dev AND validation, led by
`netMove10 bot5% short` (dev +$27.96, val +$28.83, n=22,843/15,067).

**They did not convert, and the reason is a trap worth recording:** excess is measured against a
baseline that is itself losing. The short baseline is −$26/trade, so +$28 of excess is ≈ $0 absolute.
Honest one-position-at-a-time simulation returns −$2/trade for that config and negative for every
other short; the long variants are drift with PF ≈ 1.0 at ~1,000 trades/yr.

> **Rule: excess-over-baseline measures SKILL; only absolute EV measures MONEY. A signal can beat a
> losing baseline and still lose. Always report both.**

## What the whole exercise says about where edges can live

Everything that has ever worked in this repo — PCC, Monday strength, gap-fade — shares a profile that
none of these candle features have: it is **rare** (125–700 trades/yr), **anchored to a clock or a
structural event** rather than a chart shape, and **too small to interest anyone with lower costs**.
The candle-microstructure families are the opposite: abundant, shape-based, and living in the exact
size/speed band that market makers are built to harvest. That asymmetry, not the quality of the
measurements, is why the catalog measures real phenomena that cannot be traded at 1 lot.
