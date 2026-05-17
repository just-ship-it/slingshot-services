# Regime-Conditional Fib Analysis

## Method

Bucketed the 172 baseline (BE 70/+5) trades from
`data/gold-standard/gex-flip-ivpct-tight-s60t200be70.json` by signal-time
features and measured per-bucket giveback, capture ratio, big-giveback
rate, and mfe→SL rate. Looked for buckets that diverge meaningfully from
the grand mean (`avgGiveback=44pts`, `capture=71.8%`, `bigGB=11%`).

Script: `backtest-engine/scripts/regime-giveback-analysis.js`

## Findings

### Strongest axis: ivPercentile (spread 42.8pts on avgGiveback, 31.4pp on capture)

| Bucket | n | win% | avgGiveback | capture% | bigGB% | mfeSL% |
|---|---:|---:|---:|---:|---:|---:|
| **mid** | 19 | 52.6 | **8.2** | **95.8** | **0.0** | 10.5 |
| low | 85 | 64.7 | 51.0 | 64.4 | 10.6 | 5.9 |
| high | 68 | 60.3 | 43.3 | 73.5 | **14.7** | 1.5 |

**Mid-IV trades are exceptional:** they go to TP or SL almost cleanly. Capture 95.8% means winners take essentially all of their MFE. Applying fib to mid-IV trades would HURT — there's nothing to protect.

**Low-IV** has the most absolute giveback (51 pts/winner) but only 10.6% big-givebacks. Suggests many trades give back 30-70 pts in the typical wave-back pattern; fib catches these well.

**High-IV** has the highest big-giveback rate (14.7%) — fewer-but-bigger giveback events. The classic 140 MFE → BE pattern is mostly here.

### Second axis: gexRegime (spread 22.3pts giveback, 15.1pp capture)

| Bucket | n | win% | avgGiveback | capture% | bigGB% |
|---|---:|---:|---:|---:|---:|
| **strong_negative** | 33 | 60.6 | **38.8** | **77.3** | 12.1 |
| neutral | 52 | 61.5 | 42.4 | 71.0 | 3.8 |
| positive | 61 | 67.2 | 42.7 | 72.3 | 13.1 |
| **negative** | 21 | 52.4 | **61.1** | 62.2 | **19.0** |
| strong_positive | 5 | — | — | — | — (small) |

**Negative GEX is the worst** — wave patterns are concentrated here (61 pts avg giveback, 19% big-giveback rate). Likely because in negative GEX dealers flip from suppressing to amplifying moves; trades that reach +100 see exaggerated reversals.

**Strong_negative** is surprisingly clean — when GEX magnitude is large the regime is more decisive.

### Third axis: ruleId (most extreme single divergence)

| Rule | n | win% | avgGiveback | capture% | bigGB% | mfeSL% |
|---|---:|---:|---:|---:|---:|---:|
| **S2** | 7 | **85.7** | **13.2** | **92.7** | 0.0 | 0.0 |
| L3 | 33 | 60.6 | 38.8 | 77.3 | 12.1 | 0.0 |
| S3 | 40 | 57.5 | 34.7 | 79.4 | 12.5 | 7.5 |
| L1 | 39 | 66.7 | 49.1 | 67.4 | 10.3 | 7.7 |
| **L4** | 33 | 63.6 | **54.5** | **58.6** | 6.1 | 6.1 |
| **S1** | 20 | 50.0 | 58.9 | 59.4 | **20.0** | 0.0 |

**S2 trades are PERFECT** — 92.7% capture, 13.2 pt avg giveback. NEVER apply fib. (n=7 is small but trend is unambiguous.)

**L3 / S3** — already capture 77-79%, fib would marginally hurt.

**L4 / S1** are the clearest fib targets — capture <60%, S1 has 20% big-giveback rate.

### Non-axes (no signal)

- **side**: long vs short giveback spread only 10pts; bigGB% spread 3.9pp — barely diverges. Not worth conditioning on.
- **ivSkew**: 160 of 172 trades are in "pos" bucket. Constant feature.
- **time-of-day**: rth-mid slightly worse than open (capture 64.8% vs 74%), but n=54 vs 56 and spread is small (10pp on capture). Marginal.

## Implication

Regime-conditional fib has real signal. The simplest high-impact ruleset:

```
applyFib(signal):
  # No fib for trades that already capture well
  if signal.ruleId == 'S2':
    return null
  if classifyIVPct(signal.ivPercentile) == 'mid':
    return null

  # Tight fib for the giveback-prone trades
  if signal.ruleId in ('L4', 'S1') or signal.gexRegime == 'negative':
    return { retracePct: 0.55, activationMFE: 35 }  # tight: lock 45% of MFE

  # Default
  return { retracePct: 0.618, activationMFE: 40 }
```

### Expected uplift (back-of-envelope)

Under baseline behavior:
- 19 mid-IV trades currently give back 8.2 pts/winner — under non-conditional fib (0.618/40), they would have been clipped. ~10 of them are winners → +56 pts captured by NOT applying fib (10 × ~5.6 pts saved per trade).
- 7 S2 trades currently capture 92.7% — applying fib would have cost them.
- 20 S1 trades currently give back 58.9 pts — tighter fib (0.55/35) could lock another ~15-20 pts per win (10 winners × ~17 pts).
- 33 L4 trades giving back 54.5 pts/winner — similar uplift, ~21 winners × ~10 pts = +210 pts.

Rough order: **+200-400 pts (= $4k-8k)** vs the flat fib-r618-a40 result of $127k. So conditional version might land at $131-135k — closer to but still short of baseline.

The more important effect: **conditional fib KEEPS the smoothness** (DD 7.11%) while clawing back some PnL by leaving alone the trades that don't need protection. Expected DD: 7.5-8.5%.

## What to build

The strategy `gex-flip-ivpct.js` already emits `signal.fibRetraceConfig` per signal — the conditional logic lives in there. Engine doesn't need changes. About 15 lines of new code, controlled by a new `--gfi-fib-conditional` flag.

Will validate empirically once the fine-grid + two-layer sweep finishes.
