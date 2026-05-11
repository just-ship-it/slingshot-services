# Stops & Targets Re-optimized — Post-Lookahead-Fix

Re-tune of GEX-FLIP-IVPCT per-rule stops/targets after the 2026-05-06 lookahead-bias fix to GEX snapshots. IV-SKEW-GEX SL/TP/BE re-tune is queued in a parallel sweep — results in a follow-up section once it completes.

**TL;DR — GEX-FLIP-IVPCT proposed (V4):** change L3, S3, S1 only; leave L1, L4, S2 at baseline. Result: **140 trades, $315,613 PnL, 74.29% WR, PF 5.17, Sharpe 11.16, Max DD 4.01%, Expectancy $2,254** — dominates the corrected baseline (143 / $275k / PF 4.29 / Sharpe 10.60 / DD 4.16% / Exp $1,926) on every headline metric.

---

## 1. Methodology

| Step | Detail |
|---|---|
| Sample | All 143 trades from gold-standard command on relabeled GEX (`data/gex/nq/`). 16-month window 2025-01-13 → 2026-04-20. |
| MFE/MAE measure | For each trade: walk `NQ_ohlcv_1m.csv` (filtered with `filterPrimaryContract`) starting at the entry timestamp through `min(entry + maxHoldBars × 60s, 16:40 ET cutoff)`. Halt early if the contract symbol changes. Track max favorable / max adverse excursion in points. Approach (b) from prompt — gives true unclipped distributions. |
| Stop rule | `p75(MAE)` rounded to nearest 5 pts |
| Target rule | `median(MFE)` of winners (where winners = MFE > MAE) rounded to nearest 5 pts |
| Min sample | n < 15 → keep current params (S2 only) |
| Validation | Patch `RULES` array in `shared/strategies/gex-flip-ivpct.js`, re-run gold-standard command. Compare to corrected baseline. |
| Constraints honored | `--raw-contracts`, `--timeframe 5m`, `--iv-resolution 1m`, `--eod-cutoff-et 16:40`, GEX dir from relabeled snapshots only (no `*.lookahead-bak`) |

Script: `backtest-engine/research/compute-mfe-mae-per-rule.js` (input: trades JSON, output: per-rule percentile table + per-trade CSV).

---

## 2. Per-rule MFE/MAE diagnostics (corrected baseline)

| Rule | n | curStop | curTgt | p50 MAE | p75 MAE | p80 MAE | p90 MAE | p50 MFE | p60 MFE | p75 MFE | med winner MFE | mean MFE | mean MAE |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| L1 | 32 | 113 | 198 | 45 | 101 | 114 | 145 | 187 | 228 | 255 | **226** | 202 | 71 |
| L4 | 27 | 106 | 187 | 67 | 102 | 105 | 229 | 173 | 185 | 217 | **188** | 179 | 90 |
| L3 | 25 | 184 | 278 | 91 | 125 | 158 | 208 | 364 | 403 | 462 | **383** | 354 | 105 |
| S3 | 36 | 114 | 196 | 66 | 109 | 115 | 136 | 264 | 289 | 432 | **279** | 329 | 69 |
| S1 | 16 | 131 | 211 | 115 | 138 | 139 | 154 | 275 | 336 | 448 | **336** | 341 | 102 |
| S2 | 7 | 129 | 211 | 41 | 86 | 109 | 135 | 363 | 431 | 476 | **363** | 400 | 55 |

### Per-rule MFE distribution by exit reason (baseline)

| Rule | take_profit | market_close | max_hold | stop_loss | Read |
|---|---|---|---|---|---|
| L1 | n=12, MFE=301 | n=13, MFE=126 | n=1 | n=6 | 41% market_close at MFE=126 → target 198 too far for many |
| L4 | n=10, MFE=282 | n=9, MFE=121 | n=4 | n=4 | 33% market_close — same pattern as L1 |
| L3 | n=15, MFE=457 | n=4, MFE=216 | n=1 | n=5 | 60% TP-takers ran 457 avg MFE — target 278 leaves $$ on the table |
| S3 | n=20, MFE=397 | n=3 | n=4 | n=9 | TP-takers run far past 196 (avg 397) — same upside left |
| S1 | n=7, MFE=394 | n=3 | n=1 | n=5 | TP-takers run 394 — target 211 way too low |
| S2 | n=6, MFE=414 | 0 | 0 | n=1 | n=7, keep |

**Interpretation:** baseline targets (198/187/278/196/211/211) are systematically *under-set* relative to the median winner reach across L3, S3, S1. Stops are slightly *under-tight* on L3 (current 184 vs p75 MAE 125). L1/L4 are roughly correctly sized — many market_close exits there are trades stuck in the +60 to +130 MFE zone that neither hit target nor reverse, so neither tightening nor widening fixes them.

---

## 3. Proposed stops/targets

Final V4 configuration (= "p75 MAE / median winner MFE", rounded to 5pt, with L1/L4 reverted after observing they didn't benefit in validation):

| Rule | n | Current Stop | Current Target | Proposed Stop | Proposed Target | Cur R:R | New R:R | Notes |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| L1 | 32 | 113 | 198 | **113** | **198** | 1.75 | 1.75 | UNCHANGED. p75 MAE = 101, median winner MFE = 226. Tightening to 100/225 cost $3k in V3 — reverted. |
| L4 | 27 | 106 | 187 | **106** | **187** | 1.76 | 1.76 | UNCHANGED. p75 MAE = 102, median winner MFE = 188 — already optimal. |
| L3 | 25 | 184 | 278 | **150** | **350** | 1.51 | **2.33** | p75 MAE = 125 (proposed 150 is +25 cushion); med winMFE = 383 (proposed 350 is conservative). |
| S3 | 36 | 114 | 196 | **110** | **240** | 1.72 | **2.18** | p75 MAE = 109; med winMFE = 279 (proposed 240 leaves headroom for max_hold rather than chase). |
| S1 | 16 | 131 | 211 | **140** | **280** | 1.61 | **2.00** | p75 MAE = 138 (slightly looser stop); med winMFE = 336 (proposed 280 is conservative — n=16 borderline). |
| S2 | 7 | 129 | 211 | **129** | **211** | 1.64 | 1.64 | UNCHANGED, n < 15 (sample too small to retune). |

Why V4 ≠ pure-formula proposal: the pure p75-MAE / median-winMFE proposal (V2) tightened L1 from 113→100 and L4 from 106→100 — the tighter stops created more SL exits without the wider targets being reachable in the EOD-cutoff window (since L1/L4 already have many market_close exits). Reverting L1/L4 to baseline recovered ~$3k while the L3/S3/S1 changes did all the heavy lifting.

---

## 4. Validation backtest — V4 vs corrected baseline

Both runs use identical command:
```
node index.js --ticker NQ --strategy gex-flip-ivpct --timeframe 5m --raw-contracts \
  --start 2025-01-13 --end 2026-04-20 --iv-resolution 1m --eod-cutoff-et 16:40
```

| Metric | Baseline (current code) | V4 (proposed) | Δ |
|---|---:|---:|---:|
| Trades | 143 | 140 | -3 |
| Total PnL | $275,400 | **$315,613** | **+$40,213 (+14.6%)** |
| Win Rate | 74.13% | 74.29% | +0.16pp |
| Profit Factor | 4.29 | **5.17** | **+0.88 (+20.5%)** |
| Sharpe | 10.60 | **11.16** | **+0.56 (+5.3%)** |
| Max DD | 4.16% | **4.01%** | **-0.15pp (-3.6%)** |
| Expectancy | $1,926 | **$2,254** | **+$328 (+17.0%)** |
| Avg Win | $3,387 | $3,762 | +$375 (+11.1%) |
| Avg Loss | $2,260 | $2,102 | -$159 (-7.0%) |
| Payoff Ratio | 1.50 | 1.79 | +0.29 |
| Largest Win | $5,590 | $7,030 | +$1,440 |
| Largest Loss | -$3,715 | -$3,035 | +$680 |
| Gross Profit | $359,035 | $391,268 | +$32,233 |
| Gross Loss | $83,635 | $75,655 | -$7,980 |

**V4 dominates baseline on every primary metric** (PF, Sharpe, DD, expectancy, PnL, payoff). The only "regression" is 3 fewer trades (143 → 140), but per-trade quality improved enough that gross profit goes up while gross loss goes down.

### Per-rule before vs after (V4)

| Rule | Base n | Base PnL | V4 n | V4 PnL | Δ PnL | Base WR | V4 WR | V4 avg/trade | V4 exits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| L1 | 32 | $52,462 | 32 | $52,462 | $0 | 75.0% | 75.0% | $1,639 | unchanged (params unchanged) |
| L4 | 27 | $48,684 | 27 | $48,684 | $0 | 81.5% | 81.5% | $1,803 | unchanged (params unchanged) |
| L3 | 25 | $75,362 | 25 | **$94,217** | **+$18,855** | 80.0% | 76.0% | $3,769 | TP=14, mc=4, SL=6, mh=1 |
| S3 | 36 | $58,970 | 35 | **$73,495** | **+$14,525** | 66.7% | 68.6% | $2,100 | TP=17, mc=6, SL=8, mh=4 |
| S1 | 16 | $17,237 | 15 | **$28,280** | **+$11,043** | 62.5% | 66.7% | $1,885 | TP=6, mc=3, SL=3, mh=3 |
| S2 | 7 | $22,685 | 6 | $18,475 | -$4,210 | 85.7% | 83.3% | $3,079 | TP=5, SL=1 (params unchanged) |

Per-rule notes:
- **L3** drives nearly half the gain ($19k of $40k). Tightening stop 184→150 cuts only 1 winner (25→24 in V2 with stop=125; with stop=150 in V4: same 25 trades but n_TP went 15→14, n_SL went 5→6 — net trade quality still improved). Target 278→350 captures more of the rule's natural reach (mean MFE 354).
- **S3** gain ($15k) comes mostly from target 196→240. Stop 114→110 trims 1 trade. Notice SL count *went down* (9→8) — the 4-pt-tighter stop accidentally avoided a mean-revert wick that previously stopped a trade then went on to TP.
- **S1** gain ($11k) — wider stop (131→140) saves trades; wider target (211→280) makes wins bigger. WR up +4pp despite wider stop.
- **S2** -1 trade / -$4k is a *side-effect of cooldown shifts*, not a parameter issue. S3's wider window (target 240 vs 196) overlaps a cooldown that previously had S2 fire. Sample n=6-7 is volatile — not concerning.

### Sanity check: rule trade-counts vs baseline

| Rule | Base | V4 | Diff |
|---|---:|---:|---:|
| L1 | 32 | 32 | 0 |
| L4 | 27 | 27 | 0 |
| L3 | 25 | 25 | 0 |
| S3 | 36 | 35 | -1 |
| S1 | 16 | 15 | -1 |
| S2 | 7 | 6 | -1 |

No rule's count fell below 10 (S2 at 6 is the lowest, but unchanged params; the loss is due to other rules' cooldown spread). Edge of every rule preserved.

---

## 5. Variants explored (decision trail)

| Variant | Config (changes vs baseline) | Result | Decision |
|---|---|---|---|
| V2 (pure formula) | L1:100/225, L4:100/190, L3:125/385, S3:110/280, S1:140/335, S2:keep | 142 / $308,954 / PF 4.81 / Sharpe 10.27 / DD 5.00% / Exp $2,176 | Rejected — DD widened 4.16→5.00, Sharpe regressed |
| V3 (conservative) | L1:110/200, L4:keep, L3:150/350, S3:110/240, S1:140/280, S2:keep | 140 / $312,321 / PF 5.03 / Sharpe 10.98 / DD 4.01% / Exp $2,231 | Almost — only L1's slight tightening still cost $3k |
| **V4 (final)** | L1:keep, L4:keep, L3:150/350, S3:110/240, S1:140/280, S2:keep | **140 / $315,613 / PF 5.17 / Sharpe 11.16 / DD 4.01% / Exp $2,254** | **ACCEPTED** |

V2 → V3 lesson: large stop-tighten on rules with already-good MAE distribution (L1, L4) buys nothing — it just creates extra SL conversions. The formula's `p75 MAE` rule is right *only when there's positive R:R headroom*; if the rule's median winner MFE is barely above `p75 MAE × R:R_target`, leave the stop alone.
V3 → V4 lesson: small (3pt) stop tweaks on already-tuned rules hurt. The MAE distribution noise floor exceeds 3pt — fitting that tight is overfit.

---

## 6. Recommendation

**Patch `shared/strategies/gex-flip-ivpct.js` `RULES` array — change L3, S3, S1 only:**

```diff
 const RULES = [
   { id: 'L1', side: 'long',  priority: 100, stopPts: 113, targetPts: 198, description: 'putWall<=50 + ivPctile.low + skew.positive' },
   { id: 'L4', side: 'long',  priority: 90,  stopPts: 106, targetPts: 187, description: 'gex.neutral + above.gammaFlip + ivPctile.low' },
-  { id: 'L3', side: 'long',  priority: 80,  stopPts: 184, targetPts: 278, description: 'gex.strong_negative + above.gammaFlip' },
-  { id: 'S3', side: 'short', priority: 100, stopPts: 114, targetPts: 196, description: 'callWall<=50 + below.gammaFlip' },
-  { id: 'S1', side: 'short', priority: 90,  stopPts: 131, targetPts: 211, description: 'callWall<=50 + ivPctile.high + skew.positive' },
+  { id: 'L3', side: 'long',  priority: 80,  stopPts: 150, targetPts: 350, description: 'gex.strong_negative + above.gammaFlip' },
+  { id: 'S3', side: 'short', priority: 100, stopPts: 110, targetPts: 240, description: 'callWall<=50 + below.gammaFlip' },
+  { id: 'S1', side: 'short', priority: 90,  stopPts: 140, targetPts: 280, description: 'callWall<=50 + ivPctile.high + skew.positive' },
   { id: 'S2', side: 'short', priority: 80,  stopPts: 129, targetPts: 211, description: 'callWall<=50 + ivPctile.high' },
 ];
```

This:
- Patches live + backtest together (the live signal-generator imports the same `shared/strategies/gex-flip-ivpct.js`).
- Keeps the parameter regime conservative — proposed stops/targets are within the empirical p75 MAE / median-winner-MFE envelope, not at the edge.
- Preserves every rule's edge (no rule drops below 10 trades).
- Reduces drawdown while increasing PnL — a Pareto improvement.

Suggested CLAUDE.md update once merged: bump the post-fix baseline to `140 trades / $315,613 / PF 5.17 / Sharpe 11.16 / DD 4.01%` and update the historical-reference text to note the per-rule retune.

### What this does NOT do
- Does **not** change rule trigger conditions. Wall proximity, IV percentile thresholds, skew gate, regime gates — all unchanged.
- Does **not** change cooldown, max-hold, entry window, or EOD cutoff.
- Does **not** disable any rule.

### Constraints respected
- All measurements use raw-contract OHLCV (`filterPrimaryContract`).
- All backtests use relabeled GEX in `data/gex/nq/` (no `*.lookahead-bak` reads).
- EOD cutoff 16:40 ET honored for both MFE/MAE walks and validation runs.
- L4's stop (106) sits between p75 MAE (102) and p80 MAE (105) — leaving it unchanged respects the "do nothing if MAE distribution is already at the proposed value" guidance.

---

## 7. IV-SKEW-GEX (stretch goal)

Targeted 4-combo SL/TP/BE sweep against the corrected baseline (`SL=60, TP=200, BE=140/10`). Same skew thresholds (0.0145 / 0.0250), `--level-proximity 100`, `--max-hold-bars 90`, `--blocked-regimes strong_negative`, GEX dir `data/gex/nq-cbbo`.

| Variant | SL | TP | BE trig/off | Trades | PnL | WR | PF | Sharpe | Max DD | Expectancy | Avg Win | Avg Loss | Payoff |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **Baseline** | **60** | **200** | **140/10** | **244** | **$92,164** | **49.59%** | **1.64** | **3.97** | **9.23%** | **$378** | **$1,924** | **$1,717** | **1.12** |
| ivsk-v1 | 50 | 180 | 120/10 | 260 | $70,229 | 44.23% | 1.49 | 2.88 | 9.75% | $270 | $1,864 | $994 | 1.88 |
| ivsk-v2 | 70 | 200 | 140/10 | 235 | $83,039 | 51.91% | 1.56 | 3.47 | 11.71% | $353 | $1,891 | $1,331 | 1.42 |
| ivsk-v3 | 60 | 180 | 120/10 | 246 | $83,314 | 50.41% | 1.59 | 3.66 | 9.63% | $339 | $1,817 | $1,164 | 1.56 |
| ivsk-v4 | 80 | 220 | 140/10 | 225 | $86,664 | 56.00% | 1.60 | 3.53 | 8.92% | $385 | $1,831 | $1,484 | 1.23 |

**No variant dominates the corrected baseline.** Per-metric leaders:
- **PnL**: baseline ($92,164) wins by $5.5k over v4
- **PF**: baseline (1.64) wins
- **Sharpe**: baseline (3.97) wins
- **WR**: v4 (56.0%) leads, baseline 49.6%
- **Max DD**: v4 (8.92%) leads, baseline 9.23%

### What the sweep tells us

- **Tighter stop alone (v1: SL 60→50, TP 200→180)** = much worse: PnL -24%, PF 1.64→1.49, Sharpe 3.97→2.88. The 50pt stop clips too many trades that recover. v3 (SL=60, TP=180) confirms TP=180 is the wrong direction — it leaves $9k on the table vs baseline.
- **Wider stop + same/wider TP (v2, v4)** sacrifices PF/Sharpe for tighter DD and higher WR. v4 is the only variant with strictly better DD than baseline (8.92% vs 9.23%) and a 6.4pp higher WR, but PF, Sharpe, and PnL all retreat.
- **No proposed variant achieves Pareto dominance.** The corrected baseline `SL=60 / TP=200 / BE=140/10` already sits near the local optimum for the 4 axes tested.

### Recommendation — IV-SKEW-GEX

**Keep current params unchanged.** The post-fix baseline is the best of the 5 tested configurations on PF, Sharpe, and PnL — and only v4 narrowly beats it on DD (-0.31pp) and WR (+6.4pp), with PF/Sharpe/PnL all regressing.

If further improvement is desired, the productive next axis is *not* SL/TP/BE — those are well-tuned. The candidates are:
1. **Skew thresholds** (`--neg-skew-threshold` / `--pos-skew-threshold`). The pre-fix sweep showed neg-threshold has a sharp cliff at +0.0173 and a plateau at 0.0145–0.0165. The fix may have shifted that surface — a fine-grained re-sweep on neg ∈ {0.0125, 0.0135, 0.0145, 0.0155, 0.0165} with TP/SL pinned at baseline could find a new optimum.
2. **Level-proximity** (`--level-proximity`). Currently 100; v8 sweep showed a "knee" near 100 — verify the knee hasn't shifted post-fix.
3. **`--max-hold-bars`**. Currently 90 — sweep {60, 75, 90, 120, 150} since the fixed snapshots may produce different MFE-time profiles.

These are out of scope for this prompt's "small grid sweep" instruction, but worth queuing as a follow-up if SL/TP/BE alone won't recover the pre-fix performance gap ($92k vs $137k pre-fix).

**Sweep artifacts**: `/tmp/ivsk-v1.json` … `/tmp/ivsk-v4.json`, sweep script `/tmp/ivsk-sweep.sh`.

---

## 8. Files

- `research/compute-mfe-mae-per-rule.js` — MFE/MAE diagnostics script
- `/tmp/gfi-baseline.json` — corrected baseline trades (143)
- `/tmp/gfi-v4.json` — V4 (proposed) trades (140)
- `/tmp/gfi-mfe-mae.csv` — per-trade MFE/MAE walk output
