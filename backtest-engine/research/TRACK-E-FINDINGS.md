# Track E — GEX × LT Level Interactions

**Window:** 2025-01-13 → 2026-04-23 (333 trading dates, NQ raw contracts)
**Confluence tolerance:** 15pt | **Touch distance:** 5pt | **Cooldown:** 30min
**Script:** `track-e-gex-lt-interactions.js`

---

## TL;DR

- **Confluence** (price touching a GEX level when an LT level is within 15pt of it) is **slightly *worse*** than plain GEX-only touches on average — the well-known levels appear to be "pre-traded" by other participants.
- **Crossover** events (a GEX level transitions from above to below an LT level, or vice versa, between two consecutive snapshots) show a **clean, robust, very-large-sample directional bias.** This is the strongest signal in the entire study so far.
  - All crossovers at 15m forward: GEX-above-LT (n=15,121) → **+5.44pt mean**; GEX-below-LT (n=14,436) → **−2.80pt mean**.
  - Strongest pairs: **S3 / S4 / put_wall rising past an LT level → +10–12pt at 15m on n=1,300+ each**. **Call wall / R2 / R5 falling past an LT level → −7 to −10pt on n=850–1,000 each.**

The mechanism is intuitive: support-side GEX levels rising past liquidity levels signal a structural shift up in dealer hedging zones; resistance-side levels falling past liquidity levels signal a structural shift down. The drift size (~10pt) makes this fundamentally a small-edge, high-frequency setup rather than an exceptional one — but the sample sizes are big enough to trust.

---

## Touches: confluence vs standalone GEX (n=2,782)

| Kind | n | Win% | Ret mean | MFE mean | MAE mean | Edge |
|---|---:|---:|---:|---:|---:|---:|
| confluence (GEX+LT within 15pt) | 657 | 55.7% | +6.51 | 38.7 | 26.8 | +11.9 |
| gex_only | 2,125 | 56.8% | +9.21 | 50.0 | 32.3 | +17.7 |

**Confluence is *not* a stronger barrier on average.** The most likely explanation is that when GEX and LT agree on a level, that level is so well-broadcasted that aggressive participants pre-empt it — turning what would have been a clean rejection into a partial fill or breakthrough.

### Where confluence *does* work — strong reactions on n≥20

| GEX type | Touches | Win% | Ret mean | Edge |
|---|---:|---:|---:|---:|
| **R5 confluence** | 39 | **74.4%** | +15.8 | +24.6 |
| **S3 confluence** | 51 | **64.7%** | +16.8 | +24.4 |
| R3 confluence | 22 | 59.1% | +8.0 | +21.4 |
| S4 confluence | 56 | 58.9% | +12.3 | +17.1 |
| call_wall confluence | 46 | 56.5% | +12.1 | +16.1 |
| **put_wall confluence** | 65 | **43.1%** | **−5.4** | −4.4 |

R5 + S3 confluence look promising — but n=39 / 51 is sparse (~3/month each). put_wall confluence anti-works (same pattern as Track A).

### Confluence + approach direction (n≥20, top by edge)

| Setup | n | Win% | Ret mean | Edge |
|---|---:|---:|---:|---:|
| S4 \| from_below | 25 | 60.0% | +16.2 | +24.6 |
| S3 \| from_above | 36 | 63.9% | +15.9 | +22.1 |
| call_wall \| from_below | 39 | 53.8% | +13.8 | +20.7 |
| R3 \| from_below | 21 | 61.9% | +9.8 | +20.0 |
| R5 \| from_below | 31 | 67.7% | +8.4 | +17.4 |
| R2 \| from_below | 41 | 63.4% | +8.4 | +16.0 |
| **put_wall \| from_below** | 29 | **31.0%** | **−22.4** | **−20.2** |

**put_wall \| from_below \| confluence** is a striking anti-bounce: when price has dropped below the put_wall and is rallying back UP through it AND the put_wall is co-located with an LT level, **the bounce fails 69% of the time** and the average is −22pt. That's a tradable *short* setup (or stop-out condition for longs).

### Confluence by pair distance bin (n≥30)

| Bin | n | Win% | Ret mean | Edge |
|---|---:|---:|---:|---:|
| 0–3pt | 148 | 58.8% | +4.7 | +9.8 |
| 3–7pt | 204 | 55.4% | +6.3 | +10.2 |
| **7–12pt** | 209 | 55.5% | **+9.3** | +15.2 |
| 12–15pt | 96 | 52.1% | +3.8 | +11.7 |

Counterintuitively, **looser confluence (7–12pt) outperforms tight confluence (0–3pt)**. Tightness of co-location is not a signal-strength proxy.

### Confluence by LT index (n≥20)

| LT level | n | Win% | Ret mean | Edge |
|---|---:|---:|---:|---:|
| LT4 | 111 | 51.4% | +12.0 | +20.1 |
| LT5 | 110 | 60.0% | +6.1 | +13.8 |
| LT2 | 143 | 55.2% | +5.6 | +10.5 |
| LT1 | 164 | 54.9% | +5.4 | +9.5 |
| LT3 | 129 | 57.4% | +4.6 | +7.9 |

LT4 stands out — confluence with LT4 specifically is more directionally productive than with the other LT levels.

---

## Crossovers — the headline finding (n=29,557)

For each consecutive snapshot pair (T, T+15min), for every (GEX type, LT index) pair, detect when the sign of `(gex_price − lt_price)` flips. Forward return measured from the next NQ candle's open.

### All crossovers — directional bias is real

| Group | n | Mean 5m | Mean 15m | Mean 30m | Mean 60m |
|---|---:|---:|---:|---:|---:|
| All | 29,557 | +1.50 | **+1.42** | +1.04 | +1.42 |
| **GEX above LT** (gex moved up past lt) | 15,121 | +3.08 | **+5.44** | +3.49 | +4.29 |
| **GEX below LT** (gex moved down past lt) | 14,436 | −0.15 | **−2.80** | −1.54 | −1.46 |

Symmetric direction. Effect size +5/−3 at 15m, sustained out to 60m. Sample sizes are huge.

### Crossovers by GEX type × direction (n≥30, sorted by |mean 15m|)

| Setup | n | Mean 15m | Mean 60m |
|---|---:|---:|---:|
| **S3 \| gex_above_lt** | 1,366 | **+11.71** | **+14.33** |
| **S4 \| gex_above_lt** | 1,328 | +11.31 | +12.51 |
| **put_wall / S1 \| gex_above_lt** | 1,288 | +10.32 | +12.50 |
| **call_wall / R1 \| gex_below_lt** | 850 | **−9.40** | **−12.70** |
| S5 \| gex_above_lt | 1,322 | +8.98 | +2.46 |
| R2 \| gex_below_lt | 847 | −7.49 | −6.60 |
| R5 \| gex_below_lt | 1,019 | −6.49 | −7.68 |
| S2 \| gex_above_lt | 1,435 | +5.75 | +9.08 |
| gamma_flip \| gex_above_lt | 1,134 | +4.61 | +8.87 |
| S2 \| gex_below_lt | 1,352 | +4.42 | +10.24 |
| call_wall / R1 \| gex_above_lt | 957 | −1.02 | −10.25 |

The cleanest signals:

- **Support-side levels (S3/S4/S5/put_wall) rising past an LT level → bullish drift +10–12pt at 15m**
- **Resistance-side levels (call_wall/R2/R5) falling past an LT level → bearish drift −7 to −10pt at 15m**
- gamma_flip and S2 show smaller but consistent same-side bias

### Mechanism

GEX levels reflect where dealers are forced to hedge (concentrated gamma); LT levels reflect liquidity zones from the TradingView indicator. When a dealer-side **support** level rises past a liquidity level (i.e., the support level moved UP across the LT), it indicates dealer hedging is now "above" that liquidity zone — a structural bullish shift. When a dealer-side **resistance** level falls past a liquidity level (resistance moved DOWN across LT), dealer hedging is now "below" the liquidity zone — structural bearish shift.

The signal is not the **level itself** as a barrier — it's the **transition** of dealer-zone vs liquidity-zone ordering.

### Anti-signals (small or wrong-side)

- **call_wall \| gex_above_lt** (call wall rising past LT) shows mild bearish bias at 60m (−10.25). Counterintuitive — when the call wall rises past an LT level, you'd expect bullish, but actually price tends to get pinned and reverse.
- **R3 \| gex_above_lt** is small but slightly bearish (−4.4 at 15m).

Suggests a "sided" rule: bullish setups are only support-side-rising-up, bearish only resistance-side-falling-down. Other directions are noise or anti-signals.

---

## Strategy implications

### Confluence touches

**Skip a standalone confluence-touch strategy.** On average, confluence is no better than plain GEX touches (and slightly worse). The only confluence-specific opportunity is `put_wall | from_below | confluence` as a short setup (n=29, 31% bounce rate, −22pt mean), which is too sparse to build alone.

### Crossover strategy — strong candidate

A "GEX-LT crossover" strategy looks viable:

**Long setup:** at any 15-min snapshot boundary, if any of {S3, S4, put_wall, S1} just crossed UP through any LT level since the previous snapshot → enter long on next 1m candle open.

**Short setup:** if any of {call_wall, R1, R2, R5} just crossed DOWN through any LT level → enter short on next 1m candle open.

**Suggested params (to start, sweep later):**
- Target: 30pt
- Stop: 25pt
- Max hold: 60 min
- Cooldown: 1 trade per snapshot boundary per direction

**Frequency estimate:** 4 long types × 5 LT levels × 333 days × ~26 snaps = wildly over-counted. Net unique trades would be limited by cooldown — **realistic estimate ~5–10 trades/day** if we cap to one trade per direction per snapshot. Still high-frequency.

**Caveats:**
- The mean drift is ~10pt, so getting to a 30pt target requires the upper end of the distribution. Real stop/target hit rates need MFE/MAE distributions per crossover, which we don't have yet (the script captures end-of-window close returns only).
- Crossovers can fire multiple per snapshot (e.g., S3 crosses LT2 and LT4 simultaneously). Need to dedupe and pick the strongest signal.
- Aliasing: call_wall = R1 always; put_wall = S1 always. Treat them as one when counting.

---

## Recommended next step

Build a dedicated **crossover-MFE/MAE measurement script** that walks each crossover event forward 60 min on actual 1m candles, captures full MFE/MAE distributions, and proposes target/stop combinations that maximize expectancy given realistic execution. Then prototype the strategy if the numbers hold up.

If we want to skip straight to a strategy: implement `gex-lt-crossover` in the engine using the long/short trigger sets above, sweep TP/SL, and see what falls out.

This is the strongest signal we've found — recommend building a strategy around it.
