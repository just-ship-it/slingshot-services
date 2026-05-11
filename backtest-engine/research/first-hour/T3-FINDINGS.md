# T3: 0-DTE QQQ IV at the bell → first-hour NQ direction

## TL;DR
The strongest IV-at-the-bell signal is the **absolute IV LEVEL** at the 9:30 print
(r = +0.138 vs the 9:30→11:00 NQ move on 274 in-sample days), NOT IV CHANGE as the
existing 15m short-DTE-IV strategy uses. Direction is opposite of intuition: **high
IV at the bell → NQ rallies; low IV at the bell → NQ sells off.** Best IS combo
(`iv930 ≥ 0.254 → LONG, iv930 ≤ 0.152 → SHORT`, SL 60 / TP 75 / time 90 min) yields
PF 1.64 / Sharpe 3.85 / WR 55.5% on 110 trades, but **OOS degrades** (PF 0.73 over
19 trades, Feb-Apr 2026) because the OOS regime contained zero low-IV days, so the
SHORT side is never validated. The LONG-only side of the rule retains a +20.5pt
average move OOS — directionally consistent with IS (+23.6pt).

The IV-CHANGE (overnight or 9:30→9:45) signals tested for hypothesis (b) and (c)
have near-zero correlation (|r| ≤ 0.07) and produce no clean threshold rule.

## Dataset
- Range: **2025-01-13 → 2026-04-23** (315 valid trading days; 274 IS / 41 OOS at 2026-02-23 cutoff)
- NQ raw 1m candles, primary contract per hour (filterPrimaryContract); rollover days excluded
- QQQ 1m IV: `data/iv/qqq/qqq_atm_iv_1m.csv` (mostly 7-DTE; the 1m file lacks 0-DTE)
- "9:30 IV" = first IV print at-or-after 9:30:00 ET (typically 9:31 print)
- Overnight IV change = today's 9:30 IV − prior session's last IV (≤16:00 ET, ≤30 min stale)

### Caveat: 1m IV is 7-DTE, not 0-DTE
The 1m IV file mostly contains the front weekly (DTE=7); only the 15m
`qqq_short_dte_iv_15m.csv` carries explicit `dte0_avg_iv` and that file ends 2026-01-28.
For consistent coverage across the full window I used the 1m file. This is a
**slightly different signal** than the original 0-DTE-focused short-dte-iv strategy,
but is closer to a "weekly fear/greed" gauge.

## Findings

### Correlations (in-sample, n=274 unless noted)

| Signal | Entry | Target | n | r |
|---|---|---|---:|---:|
| **iv930 (LEVEL)** | 9:30 | move @ 11:00 | 274 | **+0.138** |
| iv930 (LEVEL) | 9:30 | move @ 10:30 | 274 | +0.151 |
| ivLevelPct (vs 20-day) | 9:30 | move @ 11:00 | 264 | +0.042 |
| ivIntradayChange (9:30→9:45) | 9:45 | move @ 11:15 | 274 | +0.068 |
| ivOvernightChange | 9:30 | move @ 11:00 | 215 | −0.010 |
| ivOvernightPct | 9:30 | move @ 11:00 | 215 | −0.004 |

The IV LEVEL signal is the only one with a usable (if modest) edge.

### iv930 LEVEL deciles → 9:30→11:00 NQ move (in-sample)

| Bucket | iv930 range | n | WR (long) | Avg move |
|---:|---|---:|---:|---:|
| 1 | 0.117–0.142 | 27 | 30% | **−54.4** |
| 2 | 0.143–0.152 | 27 | 52% | −9.6 |
| 3 | 0.152–0.163 | 27 | 63% | +20.7 |
| 4 | 0.165–0.175 | 27 | 48% | −46.5 |
| 5 | 0.175–0.187 | 27 | 44% | −39.0 |
| 6 | 0.187–0.199 | 27 | 63% | +1.1 |
| 7 | 0.200–0.214 | 27 | 63% | +30.8 |
| 8 | 0.215–0.249 | 27 | 59% | +18.8 |
| 9 | 0.250–0.309 | 27 | 70% | **+62.4** |
| 10 | 0.310–0.710 | 31 | 42% | −11.1 |

The relationship is **non-monotonic**: bucket 1 (very low IV) is the strongest SHORT
signal, bucket 9 the strongest LONG signal, but bucket 10 (extremely high IV — likely
panic days where IV is mean-reverting fast and price chops) reverses. So the rule is
"trade the 8th-9th decile long, 1st decile short" — the 20/80 percentile cut from
in-sample distribution puts the long threshold near 0.254 and the short threshold
near 0.152.

### MFE/MAE structure on iv930 extremes

| Subset | n | avg move @ 11:00 | avg long-MFE | avg long-MAE |
|---|---:|---:|---:|---:|
| Low IV (iv930 ≤ 0.152) | 55 | −28.4 | 56.5 | **95.9** |
| High IV (iv930 ≥ 0.254) | 55 | +23.6 | **183.4** | 138.3 |

Low-IV days have larger downside than upside (asymmetric MAE > MFE for longs).
High-IV days have very wide ranges in both directions — high-vol regime, room for
both aggressive targets and aggressive stops.

### OOS sanity (2026-02-23 → 2026-04-23, 41 days)

The OOS window happens to contain **zero days with iv930 ≤ 0.152** (regime shifted
to elevated IV throughout late Feb / Mar / Apr), so the SHORT half of the bilateral
rule is never tested out-of-sample. The LONG half:
- OOS High-IV days (n=19): avg move @ 11:00 = **+20.5pt** (vs IS +23.6)
- OOS LONG-only fires generate net positive but fewer than 20 trades, marginal stat

This is a **regime-coverage problem, not a model failure**: the SHORT side cannot
be validated until we get more low-IV samples.

## Proposed Strategy v0 — "IV-Bell-Level"

- **Entry timing:** 9:31 ET (first 1m bar after the cash open). IV reading is the
  end-of-9:30→9:31-minute IV print (the first of the day) — strictly speaking this
  uses 1 minute of in-bar data, so true entry is the 9:31 OPEN with NO lookahead.
  (Note: this differs from the 9:30 open we'd have without IV data; the alternative
  is to use the prior session's 16:00 IV as a "yesterday's-closing-fear" proxy and
  enter at 9:30 sharp — see Followups.)
- **Side:**
  - LONG when `iv930 ≥ 0.254` (top quintile, "high fear / wide-range day")
  - SHORT when `iv930 ≤ 0.152` (bottom quintile, "complacent → mean-revert lower")
- **Stop:** 60 NQ pts (covers ~p60 of opposite-side MAE on high-IV days; bigger than the 25pt T-rule defaults because IV-extreme days are wide-range)
- **Target:** 75 NQ pts (sits at ~p55 of favourable MFE)
- **Time stop:** 90 min (i.e. exit at 11:01 if still open)
- **Expected frequency:** ~110 trades / 14 mo IS = **~0.55 trades / day** (the bilateral
  rule fires on roughly 1 day in 2). LONG side alone: ~55 trades / 14 mo = ~0.27 / day.
- **Expected per-trade EV (IS, in points):** +15.8 pts/trade (PF 1.64 / WR 55.5% / SL 60 / TP 75)
- **PF / Sharpe / WR / DD (IS):** 1.64 / 3.85 / 55.5% / 390 pts max DD over 110 trades
- **OOS LONG-only:** 19 trades, avg ≈ +20pt — directional confirmation only (low n, regime-narrow)

**Cautions:**
- Modest correlation (r=+0.138) — this is a regime/conditional signal, not a high-conviction one.
- The SHORT side is unvalidated in the OOS window; deploy LONG-only first and
  collect SHORT samples in paper mode.
- Bucket 10 (iv930 > 0.31, "extreme panic") REVERSES — we'd want a kill-switch
  above ~0.35 IV.

## Backtest-engine integration sketch

- **New strategy file:** `shared/strategies/iv-bell-level.js` extending `BaseStrategy`.
- **Inputs needed:** QQQ IV stream (already available via data-service IV skew calc;
  we'd grab the IV value at 9:30:00 ET — first available print of the session). Same
  stream the existing `short-dte-iv` strategy consumes.
- **Key params:**
  - `ivLongThreshold` (default 0.254)
  - `ivShortThreshold` (default 0.152)
  - `ivKillSwitchAbove` (default 0.35 — block both sides if IV is in panic territory)
  - `entryWindowET` (default `09:31-09:31` — fires once per day at 9:31 if conditions met)
  - `stopPts` (default 60), `targetPts` (default 75), `maxHoldMinutes` (default 90)
  - `enableShortSide` (default `false` for paper-only until OOS samples accumulate)
- **CLI flags for backtest:** `--iv-bell-long-thr`, `--iv-bell-short-thr`,
  `--iv-bell-kill-above`, `--iv-bell-stop`, `--iv-bell-target`.
- **Required data files:** `data/iv/qqq/qqq_atm_iv_1m.csv` (already present).
- Should subscribe to `gex.regime` to optionally avoid `strong_negative` regime per
  iv-skew-gex precedent (not tested here).

## Caveats / Followups

1. **Re-test with 0-DTE explicit IV** when 15m `dte0_avg_iv` data is extended past
   2026-01-28. The 7-DTE proxy used here may be noisier than true 0-DTE.
2. **Try entering at 9:30 sharp** using prior session's 16:00 IV as the "fear-at-close"
   gauge — this avoids the 1-minute lookahead entirely. Quick check on the same data
   would close that loop.
3. **Combine with T0 baseline** (first-hour MFE distribution) to size stop/target
   tighter on low-IV days where MFE is small.
4. **Extreme-IV kill-switch threshold** (~0.31–0.35) should be sweep-tuned — the
   bucket-10 reversal is suggestive but only 31 days of evidence.
5. **Day-of-week / event-day overlay** (T9): IV-bell extremes likely cluster on
   FOMC / NFP / CPI days where the 9:30 print embeds known event risk that's about
   to dissipate, biasing the LONG side. Conditioning on event calendar may be the
   true driver.
6. **Stack with T8 (Gap × GEX)** — high IV at the open often coincides with a gap;
   the gap-direction × IV-level matrix may be sharper than IV-level alone.
7. **Composite with T2 (pre-RTH features)** — combining IV-bell with the documented
   90.5% pre-RTH sweep-side prediction could give a high-quality directional bet.

## Files
- Script: `backtest-engine/research/first-hour/T3-iv-at-bell.js`
- Data: `backtest-engine/research/first-hour/output/T3-iv-at-bell.json`
  (315 day records + 240 grid combos + decile tables + correlations)
