# Capital Flows Slide Research

Landing page for the research spun out of the Capital Flows "theDesk / Mindset Corner" slide decks
(by @JaymesRosenthal). Started 2026-06-25. **All research-only — nothing deployed to production.**

## What this was
Cataloged 13 slide decks, then tested whether their trading *concepts* could (a) tweak the production
4-strategy NQ FCFS book (long/short filter, lever-up vs skip) or (b) seed a new backtestable strategy.
Each idea got a hard YES/NO against the FCFS baseline ($614,730 / PF 1.77 / Sharpe 10.8 / DD $11,642 /
test-half PF 2.04), using a PF-over-PnL accept test that requires out-of-sample (test-half) stability.

## Verdicts

| Thread | Deck idea | Verdict | Result |
|---|---|---|---|
| **A1** Vol-regime sizing ladder | "constant risk, not constant size" | ✅ YES (narrow) | Lever **lstb** 2× *only* in favorable vol regime (ivPct≥0.5 & ivChg>0) → PF 1.85 / Sharpe 11.5 / DD flat. Uniform/lumpy levering fails (anti-diversifying). |
| **A2** Stop-vs-vol noise gate | "your stop didn't move, the range did" | ❌ NO | Inverted — lstb's tight-stop/high-vol trades are its best (78% WR / PF 2.46). Cross-validates A1. |
| **A3** Skew + gamma gate | "don't fade into a crowded book" | ✅ YES | Gate the fade strat (glf) by gamma sign → PF 1.83; skip its pos-gamma shorts → DD −18%. |
| **B** Vol-compression breakout | "suppressed vol = compressed spring" | ❌ NO | NQ mean-reverts out of a squeeze, doesn't break out. 18 configs all PF 0.77–0.90 (1s-honest). |

## The deployable result (A1 + A3 stacked — orthogonal)
**A1 + A3-H2b: $642,007 / PF 1.87 / Sharpe 11.6 / DD $9,570 / test PF 2.12**
→ flat PnL, PF +6%, Sharpe +7%, drawdown −18%, every quarter improved, train 1.76 / test 2.10 (no overfit).
Max-PF variant (A1 + A3-H1 + A3-H2b): PF 1.91.

**Caveats:** wins are modest and lean on lstb being exceptional; A1's "DD flat" is partly an artifact of
where the historical max-drawdown fell, so the Sharpe gain is the more trustworthy number. Treat as a
paper-validation candidate, not an automatic deploy.

## Where everything lives
- **The decks** — `trading-decks/capital-flows/` : 13 decoded interactive HTML decks + `.txt` dumps + `CATALOG.md`
  (per-deck breakdown). Source was a Netlify SPA storing decks base64-encoded in `window.DECK_DATA`.
- **Book-tweak research (A1/A2/A3)** — `backtest-engine/research/deck-filters/` :
  - `SUMMARY.md` — full writeup with tables for all four threads
  - `lib/annotate.js` — per-trade causal feature layer; `lib/engine.js` — generalized causal FCFS engine
    (per-signal size multiplier; skip frees the slot)
  - `00-verify-baseline.js` (reproduces $614,730 exactly), `01-a1-sizing-ladder.js`, `02-a2-noise-gate.js`,
    `03-a3-skew-gamma.js`, `04-combined.js`
  - `lib/build-nq-atr.js` → built `data/iv/nq/nq_atr_1m.csv` (NQ 1m ATR-14 cache)
- **New-strategy research (B)** — `backtest-engine/research/vol-compression-breakout/` : `SUMMARY.md`,
  `01-precompute.js` (streams 8.3GB 1s → 145MB store), `02-sim.js` (18-config 1s-honest sweep). Harness
  reusable for a mean-reversion thesis or another vehicle (ES/YM/RTY).
- **Auto-memory** — `memory/deck-filters-research-2026-06-25.md` (indexed in `MEMORY.md`).

## To resume
Re-run any thread with `node backtest-engine/research/deck-filters/0X-*.js` (baseline control first).
Natural next steps: wire A1+A3-H2b behind an opt-in flag (like the vol-regime gate / lstb `ltAlign`);
or push further — A3 with a skew sub-condition, A1 with a finer lstb-regime threshold.
