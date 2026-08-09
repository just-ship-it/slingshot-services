# I3 — PCC conditioner engine A/B (apples-to-apples, full period)

**Date:** 2026-08-08 · **Runs:** `I3-{A..E}-*.txt` (this dir)
**Command base:** `node index.js -t NQ --strategy pcc --timeframe 1m --raw-contracts
-s 2021-04-01 -e 2026-06-16` + `--strategy-json '{"conditionerFile":
"data/macro/pcc-conditioner.csv","sizingMode":"<mode>"}'`
**Engine:** honest 1s execution, house slippage/commission, identical across arms.
**Data:** Databento raw NQ 1m/1s (price/fills); TV TRIN 1h + COR1M daily
(conditioner inputs via `data/macro/pcc-conditioner.csv`, `I3-build-pcc-conditioner.py`).

## Implementation

`shared/strategies/preclose-continuation.js` now takes optional params
(`conditionerFile`, `sizingMode`, `corChg5Min=2.27`, `trinNeutral=1.0`).
`sizingMode` default **'off'** → zero live behavior change; live config never
sets `conditionerFile`. Modes: `trin` / `stress` / `either` (filters, 1 lot),
`ladder` (quantity = tier: TRIN-aligned + stress-rising, 0/1/2 lots; tier 0 =
no trade). Tier fields land in signal metadata for live shadow logging.
Missing conditioner data = condition false (conservative).

## Results (2021-04 → 2026-06, 1-lot base)

| Mode | Trades | Net PnL | PF | Sharpe | MaxDD | WR |
|---|---|---|---|---|---|---|
| A base (off) | 710 | $68,009 | 1.38 | 1.04 | 8.88% | 56.6% |
| B trin | 398 | $62,472 | 1.68 | 1.22 | **4.79%** | 58.5% |
| C stress | 240 | $56,470 | **1.90** | 1.13 | 5.73% | 59.2% |
| D either | 499 | $76,807 | 1.65 | **1.50** | 6.21% | 58.9% |
| E ladder | 499 | **$119,637** | 1.77 | 1.43 | 7.41% | 59.1% |

Validation: base 710 trades ≈ book series 709 ✓; trin arm n=398 = study pass-n
exactly ✓; drop/keep fractions match I1 within noise.

**Reads:**
- **D (either, same 1-lot risk): +$8.8k MORE PnL than base on 211 FEWER
  trades** — the neither-condition trades are net-negative in-engine too
  (−$8.8k), confirming the study's neither-cell (PF 0.91). Best Sharpe (1.50).
- **E (ladder): +76% PnL vs base at LOWER maxDD (7.41% vs 8.88%)**, PF 1.77.
  Sizing up tier-2 days (n≈140) is where the money is.
- **B (trin): halves maxDD** keeping 92% of PnL — the defensive option.
- Cost note: engine commission is flat per-trade, so E understates ~$700 of
  2-lot commission over 5.2yr — immaterial vs +$51.6k.

## Honest status

Execution-honest but **NOT out-of-sample**: thresholds (TRIN<1, corChg5>2.27)
and the tier design come from I1/I2 screening on these same years. The engine
A/B answers "how much would it have improved, honestly costed" — it cannot
upgrade the conditioner past candidate status. Confirm path unchanged:
pre-registered ladder logged through the production shadow (tier metadata now
emitted), judge on shadow tape before enabling any sizing mode live.

Deploy note: strategy edit is uncommitted alongside the 2026-08-06
decision-bar fix; conditioner is inert (off) unless strategy-config sets it.
