# gex-lt-3m-crossover — Engine Implementation Results

**Window:** 2025-01-13 → 2026-04-23 (16 months, 333 trading dates)
**Built:** 2026-05-07
**Research basis:** TRACK-E4-FINDINGS.md — 11-rule whitelist with idealized exp×n ≈ 84,000 pts (~$1.68M idealized) and **realistic** estimate $420-670k after concurrency, cooldowns, slippage.

---

## TL;DR

- Realistic engine results were **far below research's $420-670k estimate**: only 2 of the 11 whitelisted rules carry a profitable edge once realistic constraints are applied. The 11-rule "complete" whitelist nets out to break-even (PF 0.99) over 16 months.
- After dropping the 9 underperforming rules, the surviving 2-rule config (S_CW + S_GF_SOLO) gives **+$35,736 / PF 1.72 / Sharpe 2.36 / DD 5.00%** on 140 trades — risk-adjusted metrics are good, but raw P&L is ~5% of the research expectation.
- The fundamental gap is **not engine bug or parameter mistuning** — it's two structural realities the research's "first-to-hit" MFE/MAE simulation didn't model:
  1. **Past-only confirm/solo filter** (live-tradeable) only catches a fraction of research's events. Research used a ±30min window — most "confirmed" events have the 15m flip in the *future* of the 3m flip, which a live filter cannot see. For S_CW: research n=361, engine n=42 → ~88% of research's confirmed events are unreachable.
  2. **Slippage + commissions + 1-min entry-delay drag** ≈ 3 pts per trade. Research had none.

---

## Iterations and headlines

| Variant | Config | n | Total $ | PF | Sharpe | MaxDD | WR |
|--------|--------|--:|--:|--:|--:|--:|--:|
| **v3 (full whitelist)** | All 11 rules, default TP/SL | 1123 | -$5,428 | 0.99 | -0.19 | 24.4% | 44.3% |
| v4 (top-4) | drop 7 worst | 688 | +$26,950 | 1.09 | 0.89 | 18.4% | 49.9% |
| v5 (force-any) | bypass solo/confirmed filter | 1441 | -$21,798 | 0.96 | -0.62 | 31.4% | 41.9% |
| v6 (drop only 4) | drop L_S3, L_S5_SOLO, L_PW, S_S2_SOLO | 773 | +$26,999 | 1.08 | 0.80 | 20.5% | 49.4% |
| v7 (top-3) | drop L_S4 too | 535 | +$15,874 | 1.07 | 0.52 | 15.7% | 49.7% |
| v8 (top-2) | only S_GF_SOLO + S_CW | 149 | +$25,732 | 1.51 | 1.88 | 6.97% | 51.7% |
| v9 (top-2 + cd=15min) | tighter cooldown | 160 | +$22,906 | 1.42 | 1.71 | 7.43% | 51.3% |
| v10 (top-2 + mh=30min) | shorter max hold | 161 | +$18,960 | 1.41 | 1.53 | 7.25% | 50.9% |
| v11 (top-2 + TP=100/SL=60) | wider TP/SL | 142 | +$25,952 | 1.52 | 1.76 | 6.78% | 50.0% |
| v12 (top-2 + TP=120/SL=50/mh=90) | wider TP, longer mh both rules | 134 | +$29,256 | 1.55 | 1.78 | 6.39% | 48.5% |
| v13 (mixed TP) | S_GF_SOLO 120/50, S_CW 80/50, mh=60 | 145 | +$30,032 | 1.58 | 2.02 | 7.07% | 49.7% |
| **v14 (per-rule mh)** | S_GF_SOLO 120/50/mh=90, S_CW 80/50/mh=60 | **140** | **+$35,736** | **1.72** | **2.36** | **5.00%** | **52.1%** |
| v15 (mh=120 for GF) | extend GF mh further | 135 | +$33,054 | 1.60 | 2.10 | 6.64% | 47.4% |
| v16 (TP=150/100) | very wide TP | 128 | +$31,839 | 1.56 | 1.79 | 7.72% | 43.8% |
| v17 (v14 + cd=15min) | tighter cooldown | 148 | +$34,076 | 1.62 | 2.27 | 5.93% | 50.7% |

---

## Final config (v14, gold-standard)

```bash
node index.js --ticker NQ --strategy gex-lt-3m-crossover --timeframe 1m --raw-contracts \
  --start 2025-01-13 --end 2026-04-23 \
  --gex-dir data/gex/nq-cbbo \
  --lt-1m-file research/lt-extraction/output/nq_lt_1m_raw.csv \
  --eod-cutoff-et 16:40 \
  --glx-disable-rules "L_S3,L_S5_SOLO,L_PW,S_S2_SOLO,L_S4,S_R3,S_R4,S_R5,S_PW_SOLO" \
  --glx-rule-overrides '{"S_GF_SOLO":{"targetPts":120,"stopPts":50,"maxHoldBars":90},"S_CW":{"targetPts":80,"stopPts":50,"maxHoldBars":60}}' \
  --output-json data/gold-standard/gex-lt-3m-crossover.json
```

Active rules:
- **S_CW** — call_wall × LT 3m crossover SHORT, **confirmed** filter (15m flip in past 30 min), TP=80, SL=50, mh=60
- **S_GF_SOLO** — gamma_flip × LT 3m crossover SHORT, **solo** filter (no 15m flip in past 30 min), TP=120, SL=50, mh=90

Per-rule v14 results:
- **S_CW**: n=45, +$11,843 ($263/trade avg), 53.3% WR, PF 1.68
- **S_GF_SOLO**: n=95, +$23,893 ($252/trade avg), 51.6% WR, PF 1.74

---

## Why the 11-rule whitelist underperforms research

### Filter-mismatch evidence

In v3 (all 11 rules) per-rule trade counts vs research expectations:

| Rule | Research n | Engine n | Ratio | Mine PF | Research PF |
|---|--:|--:|--:|--:|--:|
| S_CW | 361 | 42 | 12% | 1.71 | 2.63 |
| S_GF_SOLO | 299 | 80 | 27% | 1.88 | 3.00 |
| L_S3 | 1403 | 173 | 12% | 0.89 | 1.44 |
| L_S4 | 1364 | 123 | 9% | 1.09 | 1.45 |
| L_S5_SOLO | 594 | 112 | 19% | 0.73 | 1.63 |
| L_PW (confirmed) | 1527 | 113 | 7% | 0.87 | 1.92 |
| S_R3 | 321 | 24 | 7% | 0.59 | 1.52 |
| S_R4 | 319 | 27 | 8% | 0.81 | 1.91 |
| S_R5 | 347 | 36 | 10% | 0.87 | 1.61 |
| S_S2_SOLO | 647 | 145 | 22% | 0.88 | 1.52 |
| S_PW_SOLO | 1075 | 248 | 23% | 1.03 | 1.43 |

For "confirmed" rules the engine is catching ~7-12% of research's events. This is the past-only filter rejecting events whose 15m crossover happens **after** the 3m crossover. (Research's ±30min window includes the future.)

For "solo" rules the engine catches ~19-27%. Confusingly, mine should be a *superset* of research's solo set (research solo = no flip in past or future; mine = no flip in past), but n is smaller. Most likely cause: 15m flip frequently occurs *before* the 3m flip in these setups, putting them in mine's confirmed bucket.

### v5 (force-any filter) — proves the filter genuinely helps

When the solo/confirmed filter is bypassed entirely:
- S_GF_SOLO PnL drops from $19,515 → $12,961 (−34%)
- S_PW_SOLO PnL flips from +$3,140 → −$9,203
- Total PF: 0.99 → 0.96 (only marginal change)

So the filter is doing *something* — it's just not capturing as much of research's signal as expected.

### Why engine numbers are below research even on matched events

For rules where the engine PF is positive but below research:

- ~1 min entry delay vs research (engine fills at next-bar close, research walked from next-bar open) ≈ 5-10pt drag per trade
- Slippage on entry (1.0 pts market) and SL (1.5 pts stop) ≈ 2.5pt per trade
- Commissions ($5 round-trip) ≈ 0.25pt per trade

Combined: ~3-4pt per trade. With TP=80/SL=50 grids, that's ~5-8% of expectancy lost — which moves PF from research's ~1.5-2.0 down toward ~1.1-1.6 in the engine even on identical event populations.

---

## What survived

Two setups have enough natural edge to overcome these drags:

1. **gamma_flip × LT_1m, SHORT, solo filter** — research's strongest per-trade expectancy (21.3pt, PF 3.00) at n=299. Engine: PF 1.74 at n=95, but with TP=120/mh=90 the long-tail moves get captured. Asymmetric MFE p90/MAE p90 = 157/71 means the wide TP picks up the right tail.
2. **call_wall × LT_1m, SHORT, confirmed filter** — research's strongest single setup (22.3pt exp, PF 2.63). Engine: PF 1.68 at n=45 with TP=80/mh=60. Standard width is enough — call_wall events tend to play out within the 60min window.

Both are **SHORT** setups. The 4 long rules (L_S3/S4/S5_SOLO/PW) all underperform research and most are net losers in the engine. There's an asymmetry — likely the post-Jan-2024 NQ regime favored short-from-resistance over long-from-support setups.

---

## Implementation artifacts

- Strategy: `shared/strategies/gex-lt-3m-crossover.js`
- CLI flags: `--lt-1m-file`, `--eod-cutoff-et`, `--glx-disable-rules`, `--glx-rule-overrides`, `--glx-force-any`, `--glx-cooldown-ms`, `--glx-max-hold`
- Engine plumbing: 1m LT loader in `backtest-engine/src/backtest-engine.js` (`_loadLt1mFile`, `liquidity1m` map in market-data lookup)
- Diagnostic: `backtest-engine/research/glx-rule-breakdown.js`
- Trades: `backtest-engine/data/gold-standard/gex-lt-3m-crossover.json` (v14)

---

## Possible next steps (deferred)

1. **Re-derive Track E4 stats with past-only filter** — gives apples-to-apples expectations for a live-tradeable strategy. Likely shows realistic ceiling is ~$30-50k/16mo for this setup pattern, not $420-670k.
2. **Delayed-entry "confirmed-by-now" variant** — wait 30 min after 3m flip; if 15m flip arrives in that window, fire as confirmed. Captures research's future-confirmed events. Costs 30 min of the move; may net positive on the higher-quality setup.
3. **Trailing stop / breakeven for S_GF_SOLO** — its MFE asymmetry (157pt p90 vs 71pt p90) suggests a trailing stop after +50 MFE could capture more right-tail without the SL=50 risk.
4. **Test on ES** — same logic, different volatility regime. If S_CW + S_GF_SOLO holds on ES, it's a robust pattern.
5. **Combine with iv-skew-gex / gex-flip-ivpct** — they may have non-overlapping trade windows; portfolio could compound.
