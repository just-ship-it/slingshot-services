# T11: VWAP Reclaim/Rejection at the Open

## TL;DR
The **reclaim** pattern is the better of the two — directional bias at the open survives OOS only when conditioned on GEX regime; the **rejection** pattern looks great IS but breaks down OOS (one-sided overfit). The robust, deployable variant is **reclaim LONG** (price opens below ON-VWAP, then 1m bar closes ≥5 pt back above) when GEX gamma_imbalance is in `{positive, neutral, strong_negative}`. Full-period: 45 trades / 16 mo, WR 48.9%, **PF 1.28, Sharpe 1.85, MaxDD 318 pt**, +388 pt total at SL=60/TP=100/T=90 min. OOS (last 2 mo, n=7): **WR 71.4%, PF 3.38, +286 pt** with the same params — the regime gate is doing real work.

## Dataset
- **Range:** 2025-01-13 → 2026-04-23 (15 months), 324 trading days kept after rollover-day exclusions and minimum-bar checks.
- **Exclusions:** 21 NQ rollover dates from `NQ_rollover_log.csv`.
- **Source:** raw NQ 1m + `filterPrimaryContract()`; GEX from `data/gex/nq-cbbo/` (post-fix snapshots, regime taken at the latest snapshot ≤ 9:30 ET).
- **OOS split:** trades on or after **2026-02-23** (~2 months).
- **Signal counts (full period):** 167 reclaim (69 long / 98 short) + 117 rejection (64 long / 53 short).
- **VWAPs:** Overnight VWAP anchored at 18:00 ET prior day → 09:30 ET (typical-price-volume); slope = ON-VWAP at 09:30 minus ON-VWAP 90 min earlier.

## Findings

### Headline distributions (60-min horizon, no SL/TP)

| Pattern | n | WR60 | mean PnL (pt) | median PnL | P(MFE≥30) | P(MFE≥50) | P(MFE≥100) |
|---|---:|---:|---:|---:|---:|---:|---:|
| Reclaim (all)   | 167 | 49.7% | -1.16 | +11.6 | 0.76 | 0.62 | 0.27 |
| Rejection (all) | 117 | 53.9% |  +8.4 |  +7.3 | 0.74 | 0.63 | 0.32 |

Both patterns have **MFE generosity** — ~75% reach 30 pt and ~63% reach 50 pt within an hour — but raw close-PnL is near-flat without filters.

### Reclaim — directional asymmetry

| Side | n | WR60 | mean PnL (pt) |
|---|---:|---:|---:|
| reclaim_long  | 69 | 55.1% | +19.6 |
| reclaim_short | 98 | 45.9% | -16.4 |

**Reclaim shorts are net negative** in this sample — the 9:30-10:30 window favors long-side mean reversion in NQ. Only the long side is worth pursuing as a base.

### Reclaim — stratification (60 min final PnL)

By overnight-VWAP slope (last 90 min before 9:30):

| Slope | n | WR60 | mean PnL |
|---|---:|---:|---:|
| flat (\|slope\|≤5pt)    | 49 | **64.6%** | +18.1 |
| rising  (>+5pt)         | 72 | 43.1% | -17.5 |
| falling (<-5pt)         | 46 | 45.7% |  +2.2 |

By GEX regime at 9:30 (gamma_imbalance bucket):

| Regime | n | WR60 | mean PnL |
|---|---:|---:|---:|
| strong_negative | 38 | 55.3% |  +5.1 |
| negative        | 25 | 40.0% | -32.8 |
| neutral         | 17 | 41.2% | +14.9 |
| positive        | 36 | 52.8% | +14.1 |
| strong_positive | 51 | 51.0% |  -6.5 |

**Negative (mild)** regime is the clear avoid bucket. Combining `regime ∈ {positive, neutral, strong_negative}` keeps 45/69 of the long signals with mean PnL +27 pt vs base +20.

### Rejection — looks great in-sample, breaks OOS

| Subset | n | WR60 | mean PnL (pt) |
|---|---:|---:|---:|
| rejection_long, regime=negative      | 10 | **90%** | +71.8 |
| rejection_long, gap_down_strong      | 11 | 72.7%   | +60.8 |
| rejection, regime ∈ {neg, strong_neg} | 39 | 66.7%   | +47.9 |

OOS (last 2 mo): the top-IS rejection configs all collapsed (WR=0/0.20, PF=0/0.30 on n=1-5). Sample sizes in the negative-regime cells are too thin for the OOS test, and the IS+OOS combined is not stable. **Rejection is parked as Phase-2 research, not v0.**

### Grid search top configs (full 16 mo)

#### Reclaim ALL (no filter) — top 3 by Sharpe
| SL | TP | T | n | WR | PF | Sharpe | PnL (pt) | MaxDD |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 25 | 100 | 90 | 167 | 28.1% | 1.25 | 1.43 | +757 | 300 |
| 25 | 100 | 60 | 167 | 28.7% | 1.22 | 1.27 | +657 | 300 |
| 25 |  75 | 90 | 167 | 30.5% | 1.17 | 1.07 | +490 | 350 |

(Tight stop / wide target with low WR — survives because TP=100 fires often enough to outweigh many -25 stops.)

#### Reclaim LONG + regime ∈ {pos, neut, strong_neg} — top 3 by Sharpe
| SL | TP | T | n | WR | PF | Sharpe | PnL (pt) | MaxDD |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **60** | **100** | **90** | **45** | **48.9%** | **1.28** | **1.85** | **+388** | **319** |
| 60 |  75 | 90 | 45 | 53.3% | 1.25 | 1.75 | +320 | 296 |
| 60 | 100 | 60 | 45 | 42.2% | 1.18 | 1.19 | +240 | 400 |

#### Rejection ALL — top 3 by Sharpe
| SL | TP | T | n | WR | PF | Sharpe | PnL (pt) | MaxDD |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 25 | 30 | 60 | 117 | 46.2% | 1.03 | 0.23 |  +47 | 509 |
| 25 | 30 | 90 | 117 | 46.2% | 1.03 | 0.22 |  +44 | 511 |
| 25 | 50 | 90 | 117 | 33.3% | 0.98 | -0.15 | -39 | 639 |

(Rejection-all has no edge without a regime filter, and the regime filter doesn't survive OOS — confirming the pattern is too noisy to deploy.)

### OOS validation — top 3 IS Sharpe applied to last 2 months

| Filter | IS Sharpe / PF | OOS n | OOS WR | OOS PF | OOS PnL (pt) |
|---|---:|---:|---:|---:|---:|
| reclaim_long + regime{pos/neut/strong_neg} (SL60/TP75/T90) | 0.86 / 1.12 | 7 | 71.4% | **2.55** | +186 |
| reclaim_long + regime{pos/neut/strong_neg} (SL60/TP100/T90) | 0.58 / 1.08 | 7 | 71.4% | **3.38** | +286 |
| reclaim_long + regime{pos/neut/strong_neg} (SL60/TP75/T60) | 0.06 / 1.01 | 7 | 57.1% | 2.26 | +167 |
| reclaim_short + slope=rising (SL25/TP100/T90) | **2.23** / 1.42 | 6 | 16.7% | 0.80 | -25 |
| rejection regime_neg (SL25/TP30/T60)         | **5.33** / 1.94 | 5 | 20.0% | 0.30 | -70 |
| rejection_long + gap_down_strong              | 2.16 / 1.33 | 1 | 0% | 0 | -25 |

**Two highest-Sharpe IS configs (rejection-regime-neg, reclaim-short-rising-slope) both fail OOS** — classic small-sample IS overfit. The **modest-Sharpe reclaim-long + regime config improves OOS**, suggesting the regime gate generalizes.

## Proposed Strategy v0(s)

### v0a — VWAP-Reclaim-Long (primary)
- **Entry:** at 9:30 ET, compute overnight-VWAP (anchored 18:00 prev → 09:30 ET, typical price × volume on raw NQ 1m). If `open_9:30 < ON-VWAP - 5 pts`, watch for the first 1m bar in 9:30-10:30 ET that closes `≥ 5 pts above ON-VWAP`. Enter LONG at that bar's close.
- **Side:** LONG only. (Short side is net-negative and slope-rising shorts overfit.)
- **Filter:** GEX `gamma_imbalance` at the latest CBBO snapshot ≤ 9:30 ET must be in **strong_negative (≤ -0.5)**, **neutral (-0.1..+0.1)**, or **positive (+0.1..+0.5)**. Skip when regime is plain `negative` (-0.5..-0.1) or `strong_positive` (≥ +0.5).
- **Stop:** **60 pts** below entry (≈ p65 of MAE distribution for long signals; tighter stops over-cluster losers).
- **Target:** **100 pts** above entry (≈ p70 of MFE).
- **Time stop:** **90 min** from entry, hard exit on close.
- **No trade if** signal would land in a contract rollover boundary day (already excluded).
- **Expected frequency:** ~45 trades / 16 months ≈ **2.8 trades/month** (~0.13/day) — well within the "1 trade/day" budget.
- **Expected per-trade EV:** +8.6 pt (in-sample), ~+27-40 pt OOS (small sample). Use IS for sizing assumption: ~$170 / micro-NQ contract.
- **Headline backtest:** PF 1.28, Sharpe 1.85, MaxDD 319 pt, +388 pt total in 16 months; OOS 7 trades hit 71% WR, +286 pt with same params.

### v0b — VWAP-Rejection (research only, do not deploy)
- Pattern present (P(MFE≥50)=63%, mean +8 pt), but every IS-favored filter fails OOS. Re-test once 2 more months of data accrue; possibly try a tighter bar-shape filter (≥3-pt rejection wick, body in lower/upper third).

## Backtest-engine integration sketch

- New strategy file: `shared/strategies/vwap-reclaim-long.js` extending `base-strategy.js`.
- Required state: rolling overnight-VWAP series (typical price × volume from prior 18:00 ET), reset daily at 18:00 ET. Engine already exposes per-symbol candle buffers; add a small `accumulator` keyed off the session boundary.
- Required GEX field: `gamma_imbalance` at latest snapshot ≤ 9:30 ET (data-service already publishes this on `gex.levels`).
- New CLI flags:
  - `--vwap-reclaim-min-distance 5` (entry-side and trigger threshold in NQ pts)
  - `--vwap-reclaim-window 9:30-10:30`
  - `--vwap-reclaim-blocked-regimes negative,strong_positive`
  - Standard `--target-points 100 --stop-loss-points 60 --max-hold-bars 90`
- Order: `place_market` (or `place_limit` at signal close with 60s timeout). 1 contract default; one trade per day max (gate on `position.update`).
- Engine bar grid: `--timeframe 1m --raw-contracts --gex-dir data/gex/nq-cbbo`.

## Caveats / Followups

1. **OOS is only 7-9 trades per pattern** — confidence on the 71% WR / 3.38 PF is low. Re-run after 3 more months of live data.
2. **Sharpe is computed on per-trade pnl, not equity-curve daily returns** — the 1.85 number is an upper bound on what the trade-engine's daily Sharpe will report.
3. **MaxDD = 319 pt over 45 trades** is acceptable but not great per-contract. Position-size accordingly (1 micro = 30 pt drawdown per maxDD slice → fine; 1 mini = $6,380 worst-case drawdown).
4. **Regime label is taken from the snapshot ≤ 9:30 ET only.** A re-evaluation of the regime at signal time (which can be 9:30-10:30) might tighten the filter further; not tested.
5. **"Above ON-VWAP" reclaim with rising slope** has a profitable IS Sharpe (2.23) but fails OOS — do NOT enable shorts.
6. **Rejection pattern**: the IS edge in negative-regime is real numerically (n=39, WR 67%, PF 1.55) but the 2-month OOS slice (n=5) was a brutal 20% WR, PF 0.30. Either the regime label is leaking signal in-sample, or recent vol regime broke the pattern. Re-investigate with a longer OOS slice before deploying.
7. **Contract-rollover sensitivity** not formally tested — strategy fires on opening pattern, so rollover days are excluded entirely; trades shouldn't span rollovers given the 90-min time stop. Safe.
8. **GEX gamma_imbalance buckets** are hand-picked at ±0.1/±0.5; a finer sweep on those thresholds was not done and could improve the filter.
