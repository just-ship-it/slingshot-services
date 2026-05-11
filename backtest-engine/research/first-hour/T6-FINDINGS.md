# T6: Initial Balance Failure Reversal (NQ)

## TL;DR
Failed-extension reversals fire on **~78% of days** (253 trades / 324 days). Hypothesized confluence boosts (GEX wall touch, gap alignment, IV percentile) are **directionally encouraging in-sample but DO NOT replicate OOS** at this sample size — the cleanest IS configs (wall + opp-IB target) went 0/4 OOS. Best-replicating config is the dumb "fade-the-failure with a 15pt stop and a fixed +30pt target" rule: PF 1.26 IS / 1.25 OOS, ~41% positive-PnL rate. This **does NOT clear the user's "above 50% win rate" hypothesis bar** without partials.

**Time-window caveat (CRITICAL):** This strategy structurally fires AFTER 10:30 ET — the IB completes at 10:30, then we wait for an extension and a re-entry within 30 min. Median entry lands at **10:42 ET**, p75 at **11:13 ET**. Restricting to entries by 11:00 cuts trades by ~45% (139 of 253) and improves base rate slightly (P(MFE>=50) 0.67 vs 0.64). The relaxed 11:30 cutoff captures 192 of 253 trades.

## Dataset
- Date range: 2025-01-13 to 2026-04-23
- Days analyzed: 324 (after rollover-day exclusion)
- IB extensions detected: 311 (96% of days — matches external 96.2% IB-breakout claim)
- Failed extensions (re-entered IB within 30 min): **253 (78% of days)**
- In-sample (pre-2026-02-23): 220 trades
- OOS (>=2026-02-23): 33 trades
- GEX 9:30 snapshot missing: 13 days
- Sources: `data/ohlcv/nq/NQ_ohlcv_1m.csv` (raw + filterPrimaryContract), `data/gex/nq-cbbo/`, `data/iv/qqq/qqq_atm_iv_1m.csv`

## Findings

### Base rates (all 253 executed failed extensions)

| Subset | n | P(hit opp IB) | P(hit IB mid) | P(MFE>=50) | avg MFE | avg MAE |
|---|---:|---:|---:|---:|---:|---:|
| Overall | 253 | **0.194** | **0.482** | **0.636** | 110.7 | 110.9 |
| Entry by 11:00 | 139 | 0.245 | 0.540 | 0.669 | 127.6 | 107.5 |
| Entry by 11:30 | 192 | 0.229 | 0.526 | 0.646 | 119.0 | 113.4 |
| Touched GEX wall (extension within 10pt) | 27 | 0.259 | 0.444 | 0.667 | **165.1** | **91.2** |
| No wall touch | 226 | 0.186 | 0.487 | 0.633 | 104.2 | 113.3 |
| Gap aligned with trade direction | 141 | 0.192 | 0.525 | 0.645 | 100.2 | 120.8 |
| Gap opposed | 112 | 0.196 | 0.429 | 0.625 | 124.0 | 98.4 |
| IV pct >= 0.7 | 79 | 0.203 | 0.481 | 0.684 | 141.6 | 164.0 |
| IV pct < 0.3 | 82 | 0.207 | 0.476 | 0.598 | 78.3 | 81.5 |
| Regime positive (any) | 118 | 0.237 | 0.483 | 0.610 | 97.4 | 80.3 |
| Regime negative (any) | 95 | 0.147 | 0.463 | 0.684 | 130.7 | 165.2 |
| Ext distance 15-35 pts | 27 | 0.296 | 0.593 | **0.778** | 141.9 | 151.1 |
| Wall + gap aligned | 9 | 0.222 | 0.667 | 0.778 | 150.3 | 73.6 |
| Wall + gap + IV>=0.5 | 3 | n/a | tiny | tiny | tiny | tiny |

The **opposite-IB-extreme target hits only ~19% of the time** — much weaker than the user's hypothesis framing implies. A more reachable target (IB midpoint or fixed +30 to +50) is needed for a usable strategy.

### Top stop/target combos — in-sample

**All trades (n=220 IS):** best by total PnL is `stop=15 / target=fix30 / time=session` → 41% wins, **PF 1.26**, avg +2.26 pts/trade.

**Wall-touch subset (n=23 IS):** best by total PnL is `stop=60 / target=oppIB / time=session` → 52% wins, PF 1.91, avg +22.75 pts/trade. **Highest IS PF: stop=15/target=oppIB/time=30min, PF 2.54.**

### OOS replication (CRITICAL)

| IS config | IS n | IS PF | IS total | OOS n | OOS PF | OOS total |
|---|---:|---:|---:|---:|---:|---:|
| Overall best (s15/fix30/session) | 220 | 1.26 | +496 | 33 | 1.25 | +60 |
| Relaxed-11:30 best (s15/fix30/session) | 166 | 1.12 | +187 | 26 | 1.25 | +60 |
| Wall-touch best (s60/oppIB/session) | 23 | 1.91 | +523 | 4 | **0.0** | **-240** |
| Wall-touch #2 (s40/oppIB/session) | 23 | 2.12 | +488 | 4 | **0.0** | -160 |
| Wall-touch #3 (s40/oppIB/90min) | 23 | 2.02 | +416 | 4 | **0.0** | -121 |

**The wall-touch IS edge is overfit / sample-too-small.** All three IS top-3 wall-touch configs went 0/4 OOS. Only the un-conditioned "blanket" config replicates.

### MFE / MAE distributions (executed)
- MFE median 64 pts, p75 144 pts, p90 230 pts
- MAE median 56 pts, p75 130 pts, p90 246 pts
- Symmetric — these failed extensions extend in BOTH directions, not just the trade direction.
- Wall-touched subset: MFE p75 jumps to 194 pts; MAE p75 falls to 112 pts. Risk-reward genuinely skewed in our favor *when wall is involved*, but the OOS data refutes the practical edge.

## Proposed Strategy v0

**Honest assessment:** the hypothesis ("conditional on confluence the rate jumps materially above 50%") **did not survive OOS**. The strategy is borderline — positive expectancy but no clean PF >> 1 config replicates. Given the user's stated bar (50%+ win rate, single trade/day, 20-30+ pt target), this strategy should NOT be promoted to live without further development. Documenting the best-replicating config anyway:

- **Entry trigger**: After 10:30 ET, on the first 1m close beyond IB high or low (compute IB H/L over 9:30-10:30), wait up to 30 min for a 1m close BACK INSIDE the IB range. Enter at that re-entry bar's close.
- **Side**: Opposite of extension. Failed-high extension → SHORT; failed-low → LONG.
- **Stop**: 15 pts (tight). Aligned with the cluster of replicating configs.
- **Target**: Fixed +30 pts. The opposite-IB target only hits 19% of the time; +30 hits ~38-40%.
- **Time stop**: Session-end (16:00 ET) or 90 min, results essentially identical.
- **Filters that survived OOS**: NONE definitively. The "blanket" version is the most honest baseline.
- **Filters with directional IS lift but DID NOT replicate OOS**:
  - GEX-wall touch within 10 pts (tiny sample)
  - Extension distance 15-35 pts (n=27 IS)
  - Wall + gap-aligned + IV>=0.5 (n=3, useless for sizing)
- **Expected frequency**: ~0.78 trades/day pure. With strict 11:00 cutoff: 0.43/day. With relaxed 11:30 cutoff: 0.59/day.
- **Expected per-trade EV** (s15/fix30/session, all-trades): **+2.3 pts** ($46 on MNQ, $230 on NQ-mini full).
- **Win rate (positive PnL)**: 41% — does NOT clear the 50% bar even with confluence filters at any sample size that replicates OOS.

### Time-window variant (REQUIRED CALLOUT)
- **Strict 11:00 cutoff**: Drops 45% of trades. Wall-touched-strict-11 → 15 trades IS. Avg MFE 177 pts, but PF lift didn't replicate OOS.
- **Relaxed 11:30 cutoff** (recommended for this strategy): Captures 76% of trades. OOS PF = 1.25 with the blanket s15/fix30 config. **Strategy is structurally a 10:30-12:00 strategy.** If the user's window is hard-capped at 11:00, this track is essentially dead.

## Backtest-engine integration sketch

Not recommending integration without further work. If pursued:

- **File**: `shared/strategies/ib-failure-reversal.js` extending `base-strategy.js`.
- **State per day**: build IB H/L on every 1m close from 9:30-10:30 ET; freeze at 10:30. Track first-extension-after-10:30. On 1m close back inside IB within 30 min of extension, fire `place_market` (re-entry bar close has already happened; market entry on next bar open is a slightly worse fill).
- **Parameters** (all CLI-configurable):
  - `ibStartEt=09:30`, `ibEndEt=10:30`
  - `reentryWindowMin=30`
  - `entryCutoffEt=11:30` (default — strict 11:00 kills volume)
  - `stopPts=15`, `targetPts=30` (or `targetMode=fix|oppIB|mid`)
  - `timeStopMin=90` (or `eodCutoffEt=16:00`)
  - Optional confluence flags (off by default given OOS failure): `requireGexWallTouch`, `gexProxPts=10`
- **Live precondition**: needs IB tracker that aligns with 1m candle.close events (already present in multi-strategy engine for other 1m strategies).
- **Margin profile**: day-trade only — entries 10:30+, max hold 90 min, broker liquidation cushion built in.

## Caveats / Followups
1. **OOS sample is tiny (33 trades).** February-April 2026 was a relatively low-volatility regime (avg MAE 165 in negative-regime IS but OOS samples are too sparse). Re-running this in 6 months when OOS doubles will give a better verdict.
2. **GEX wall-touch sample (27/253) too thin.** Could relax `gexTouchProxPts` from 10 to 20 (NQ pts) to 5x the sample, but at 20 pts the "touch" filter is no longer meaningful. Better path: use ONGOING GEX (intraday snapshot at extension time, not 9:30) — the current 9:30 anchor under-counts touches when GEX moves intraday.
3. **Re-entry rule is binary.** A continuous "how-deeply-did-we-re-enter" measure (e.g., re-entry must close >25% of the way back into IB) might dramatically improve hit rate. Worth a follow-up sweep.
4. **IB-range-relative sizing**: large-IB days (>100 pts) almost certainly behave differently from compressed-IB days (<40 pts). The grid did NOT segment by IB-range bucket. A focused study on IB range >= 60 (high-energy mornings) is the obvious next experiment.
5. **Entry slippage**: simulation enters at re-entry-bar close (no slippage). In live this is the previous bar's close; entry on the next bar's open will lose ~1-3 pts depending on momentum. Re-run with that conservatism before any live consideration.
6. **Combinations with other tracks**: T8 (gap×GEX matrix) or T11 (VWAP reclaim/rejection) might provide a SECOND, decorrelated signal. The IB-failure rule alone is too weak; pairing it with another signal that also fires post-10:30 might rescue it.

**Bottom line**: T6 is a tepid result. Pure IB-failure reversal has a real but small edge (PF ~1.25 OOS). The confluence story does not replicate at current sample sizes. Park this until either (a) more data accumulates or (b) it's combined with a complementary signal.
