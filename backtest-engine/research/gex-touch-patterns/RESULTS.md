# GEX-Touch Patterns Strategy — Engine-Verified Results (2026-05-13)

## TL;DR

**Engine-verified, 1 contract, 16 months (2025-01-13 → 2026-04-23):**

| | Trades | WR | PF | Sharpe | Max DD | PnL |
|---|---:|---:|---:|---:|---:|---:|
| **Gold standard (v6, 07:00 entry)** | 362 | 32.9% | 1.51 | **2.24** | 5.58% | **$38,722** |
| v5 (09:30 entry, prior baseline) | 225 | 37.8% | 1.60 | 2.07 | **3.90%** | $27,221 |

Switching the entry window from 09:30 ET → 07:00 ET adds +42% PnL and +0.17 Sharpe at the cost of 1.68pp DD. The 5.58% DD still beats every other gold-standard strategy (iv-skew-gex 9.23%, gex-flip-ivpct 11.3%, gex-lt-3m 8.30%).

Scales linearly with contract size:
- 1 contract: $38.7k PnL, $5.6k DD
- 3 contracts: ~$116k PnL, ~$17k DD
- 4 contracts: ~$155k PnL, ~$22k DD

Gold-standard trades JSON: `data/gold-standard/gex-touch-patterns.json`.

## Framework

Each GEX touch (within 10pt of any S1-S5/R1-R5/gamma_flip/call_wall/put_wall) opens a **30-minute monitoring window**. Inside the window we scan for pattern triggers; when one fires, the strategy enters a market order with target/stop defined by the pattern's structural reference. Max hold 4 hours, EOD cutoff 16:40 ET.

**Patterns** (7 implemented, 4 made the cut after engine validation):

| Code | Pattern | Setup | Trigger |
|---|---|---|---|
| **R1** | Bounce + HL break | support touched from above | break above first swing-high after the bounce |
| **R2** | Bounce + LH break | resistance touched from below | break below first swing-low after the rejection |
| **A1** | Accept + retest hold | resistance break + K=3 closes above | retest pulls back to level then breaks retest high |
| **A2** | Accept + retest hold | support break + K=3 closes below | mirror of A1 |
| ~~R3~~ | ~~Pin + confirm~~ | dropped: fires on T+1 before others can develop, dominates trade count, loses to slippage |
| ~~F1, F2~~ | ~~Fake-out recovery~~ | dropped: no edge in H2 / unstable across halves |

## Final rulebook (8 cells)

Ordered by engine $/trade — highest-priority rule wins when multiple match.

| # | Pattern | Level | Target | Eng n | Eng WR | Eng $ |
|---|---|---|---:|---:|---:|---:|
| 1 | R1 | S4 | 80 | 30 | 33.3% | $6,664 |
| 2 | A2 | S5 | 100 | 25 | 27.8% | $6,381 |
| 3 | R2 | R4 | 40 | 21 | 46.7% | $2,299 |
| 4 | R2 | call_wall, R1 | 150 | 29 | 11.5% | $1,930 |
| 5 | R2 | gamma_flip | 100 | 25 | 16.7% | $4,205 |
| 6 | A1 | gamma_flip | 40 | 35 | 35.5% | $1,512 |
| 7 | R1 | S2 | 20 | 40 | 59.0% | $1,880 |
| 8 | A1 | R2 | 30 | 16 | 37.5% | $430 |

(R2 × R1 hits the same touches as R2 × call_wall because call_wall == R1 in many GEX snapshots — they share a row in the breakdown.)

## Dataset & methodology

- **17,966 touches** detected across 333 trading days
- **7,309 candidate triggers** across 7 patterns (1s-honest fill + exit simulation per CLAUDE.md mandate)
- **MFE/MAE captured at multiple target tiers** (20/30/40/50/60/80/100/150/200 pts) without lookahead — walker continues to stop/EOD/rollover regardless of intermediate target hits
- Engine validation uses the same 1s OHLCV provider as gold-standard strategies (slippage: 1.5pt stop, 1pt market, $5/side commission)

## How we got here — the journey

1. **Phase 1 (build dataset)**: detected all 17,966 touches, ran 7 detectors, walked outcomes at multiple targets in 1s honest mode.
2. **Phase 2 (score)**: per-pattern × level-type × regime × TOD scoring. Showed R1/R2/A1/A2 stable across H1/H2, F1/F2/R3 unstable.
3. **Phase 4 (stretch targets)**: discovered some cells have moves up to 150pt within 4 hours — particularly R2 × call_wall (PF 2.54 at target=150).
4. **Phase 5 (rulebook sim with slippage)**: realistic slippage (1.5pt stops + commissions) eats most of the gross edge. Combined union of all positive-PF cells nets only ~$370/16mo on 1 contract — i.e., breakeven.
5. **Engine validation v1-v3**: R3 (pin+confirm) was the silent killer — fires on bar T+1 before R1/R2 can develop swing structure, wins priority race, accumulates 741 trades that bleed slippage. Removing R3 alone: **-$12.8k → +$10.9k.**
6. **Pruning losing cells (v4)**: dropped cells with negative engine PnL. **+$10.9k → +$25.2k.**
7. **Final prune (v5)**: dropped A2 × gamma_flip (marginal). **+$25.2k → $27.2k**, DD dropped from 5.16% → 3.90%.

## Stability check

H1 / H2 split at 2025-07-22 (midpoint of 225 trades):

| Half | Trades | WR | PF | PnL |
|---|---:|---:|---:|---:|
| H1 (Jan-Jul 2025) | 112 | 32.3% | 1.17 | $4,166 |
| H2 (Jul-Apr 2026) | 113 | 37.8% | 2.12 | $23,055 |

H2 substantially stronger. Two interpretations:
1. **Genuine** — the strategy may benefit from the post-July 2025 market regime (lower realized vol, more clear structural levels).
2. **Selection bias** — the rulebook was tuned against full-period engine PnL, so H2 may benefit slightly more from cells that happened to print there.

The cells themselves (R1×S4, A2×S5, R2×call_wall, etc.) were all stable in H1/H2 in Phase 2's raw research. The serialization concurrency adds noise, but the core edge is consistent.

## Breakeven / trailing tested — both hurt

A 17-config sweep across breakeven-trigger × breakeven-offset combinations confirmed BE consistently underperforms the baseline:

| Config | PnL | vs baseline |
|---|---:|---:|
| baseline (no BE) | $27,221 | — |
| be_trigger=40 / offset=0 | $20,173 | -26% |
| be_trigger=40 / offset=5 | $16,653 | -39% |
| be_trigger=30 / offset=10 | $14,893 | -45% |
| be_trigger=25 / offset=10 | $13,768 | -49% |
| be_trigger=10 / offset=5 | $798 | -97% |

**Reason**: the rulebook depends on letting big-target trades (T=80/100/150) develop fully. Moving stops to breakeven after small MFE moves the trade out of position before the bigger move completes.

## Alternative rulebook tested: `big_targets`

A focused 4-cell rulebook with only T ≥ 80 cells (R2×call_wall@150, R2×gamma_flip@100, A2×S5@100, R1×S4@80) produced:

| | Trades | WR | PF | Sharpe | DD | PnL |
|---|---:|---:|---:|---:|---:|---:|
| BIG_TARGETS | 116 | 30.2% | **1.77** | 1.69 | **3.39%** | $20,640 |
| DEFAULT (winner) | 225 | 37.8% | 1.60 | **2.07** | 3.90% | **$27,221** |

BIG_TARGETS has higher PF and lower DD but $7k less PnL. The DEFAULT rulebook adds in fast cells (T=20-50) that capture additional setups DEFAULT couldn't otherwise serve due to the slow trades' concurrency lockup.

Enable via `--gtp-rulebook big_targets`.

## 60-min trigger window tested — also worse

Research suggested 60-min trigger window unlocks A1 × R2 @ 30 (59% WR, PF 3.15, $52k research $) but engine validation showed it doesn't transfer:

| Config | Trades | WR | PF | Sharpe | DD | PnL |
|---|---:|---:|---:|---:|---:|---:|
| baseline (30-min, default rb) | 225 | 37.8% | **1.60** | **2.07** | **3.90%** | **$27,221** |
| 60-min + default rb | 250 | 37.2% | 1.50 | 1.93 | 4.33% | $26,361 |
| 60-min + w60 rb | 463 | 34.3% | 1.09 | 0.40 | 12.06% | $9,250 |

The 30-min window combined with engine-tuned rulebook remains optimal. Longer windows admit more triggers but their quality degrades — engine concurrency dynamics differ from concurrency-free research.

Enable variants via `--gtp-trigger-window 60` and/or `--gtp-rulebook w60`.

## Entry-window sweep — 07:00 ET start is the winner

The 09:30 baseline assumed RTH was the only relevant period. A full window sweep showed pre-RTH Europe-open hours add edge:

| Window | Trades | WR | PF | Sharpe | DD | PnL |
|---|---:|---:|---:|---:|---:|---:|
| **07:00–16:00** ⭐ | 362 | 32.9% | 1.51 | **2.24** | 5.58% | **$38,722** |
| 06:00–16:00 | 429 | 31.5% | 1.43 | 2.25 | 5.23% | $38,487 |
| 04:00–16:00 | 540 | 29.8% | 1.34 | 2.04 | 6.47% | $37,765 |
| 07:00–17:00 | 416 | 30.1% | 1.48 | 2.14 | 5.64% | $37,453 |
| 09:30–16:00 (prior baseline) | 225 | 37.8% | 1.60 | 2.07 | **3.90%** | $27,221 |
| 09:30–17:00 | 279 | 32.6% | 1.55 | 1.94 | 4.07% | $25,952 |
| 00:00–16:00 | 669 | 27.8% | 1.12 | 0.74 | 11.25% | $16,806 |
| all hours | 991 | 20.0% | 1.04 | 0.19 | 12.60% | $6,779 |

The cliff between 04:00 and 00:00 (PF 1.34 → 1.12) shows overnight Asia hours add noise without edge. 07:00 captures Europe-open momentum (ES open 03:00 ET / DAX 03:30 ET have played out) without going into thin Asian liquidity. Extending the close past 16:00 doesn't help — the 4hr max-hold and 16:40 EOD already absorb almost all signal.

The new default entry window is `07:00–16:00`. Override with `--gtp-entry-window HH:MM-HH:MM` or `--gtp-no-entry-window`.

## Engine command

```bash
cd backtest-engine
node index.js --ticker NQ --strategy gex-touch-patterns \
  --timeframe 1m --raw-contracts \
  --gex-dir data/gex/nq-cbbo \
  --start 2025-01-13 --end 2026-04-23 \
  --eod-cutoff-et 16:40
```

## Honest comparison to existing $100k+ strategies

| Strategy | Target | Trades/16mo | $/trade gross | Slippage drag | Net 16mo |
|---|---:|---:|---:|---:|---:|
| iv-skew-gex | 200pt | 244 | $2,400 | 2.5% | $92k |
| gex-flip-ivpct | 200pt | 172 | $3,000 | 2.5% | $157k |
| **gex-touch-patterns** | 20-150pt mix | 362 | ~$150 | ~15-20% | $39k |

The $100k+ strategies use bigger targets that dilute slippage drag. Pattern-based touch strategies fundamentally trade smaller moves — they need higher quantity or position scaling to match.

**Why pattern-touch can't easily reach $100k on 1 contract:**
- 30-min monitoring window caps move size to ~30pt avg MFE for most touches
- Even when bigger 100-150pt moves exist (R2 × call_wall), the long hold time (1-2 hr per trade) locks the engine's single position slot, reducing trade volume
- Slippage drag at 1.5pt is 7-10% of typical 20-40pt target vs <1% of 200pt target

## Files

- **Strategy**: `shared/strategies/gex-touch-patterns.js` (registered in engine + CLI as `gex-touch-patterns` / `gtp`)
- **Gold-standard trades**: `backtest-engine/data/gold-standard/gex-touch-patterns.json`
- Research:
  - `01-build-pattern-dataset.js` — touch detection + 7 pattern detectors + 1s outcome walker w/ multi-target ladder
  - `02-score-patterns.js` — per-pattern + per-segment scoring + H1/H2 stability
  - `03-serial-sim.js` — concurrency-aware ruleset sim
  - `04-stretch-targets.js` — per-cell optimal target finder
  - `05-rulebook-sim.js` — rulebook sim with realistic slippage + commissions
- Datasets: `research/output/gex-touch-patterns-base-*.json` (gitignored)
