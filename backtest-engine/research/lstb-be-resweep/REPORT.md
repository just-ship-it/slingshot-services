# LSTB breakeven-stop re-sweep on slippage-fixed simulator (2026-07-13)

## Why

Live day one of LSTB-ltAlign (2026-07-13) was red while the published gold implied it should rarely be. Root cause found in the engine: `trade-simulator.js exitTrade()` applied `stopOrderSlippage` (1.5 pt) only to `stop_loss` exits — `trailing_stop` (how BE exits are recorded) fell through to `limitOrderSlippage = 0`. Live BE stops are stop-market orders and slip like any stop. The v3-ltAlign gold credited its 1,232 BE exits (35.7% of trades) a clean +2.0 pts / +$34.9 net each.

**Fix (2026-07-13):** `stop_loss` AND `trailing_stop` → `stopOrderSlippage`; `take_profit` → no slip (limit); all other exits (`eod_liquidation`, `market_close`, `time_exit`, `max_hold_time`, `soft_stop`, `fib_retrace`) → `marketOrderSlippage` (1.0 pt). Only limit fills are slip-free.

⚠ **This deflates every gold that uses BE/trailing exits** (GLX, GLF, ISG, GFI tight-stop, …). All golds predating 2026-07-13 are optimistic on BE/trailing/time exits and need regens.

## Sweep

v3-ltAlign base (tgt 15 / stp 12 / blocked hours 5,16–23 / min-range 3 / ltAlign via `--ls15-file`), window 2025-01-13 → 2026-04-23, varying only the BE stop. `mnq$` = PnL ÷10 with real micro fees (+$1.9/RT MNQ over the modeled $5 NQ commission). Sorted by daily Sharpe (annualized).

| config | n | PnL (NQ) | PF | WR% | Sharpe | maxDD | worst day | neg days | TP% | BE% | SL% | MNQ real-fee PnL |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **no BE** | 3278 | **$201,021** | 1.57 | 58.5 | **11.0** | $3,055 | −$2,750 | 19% | 57 | 0 | 39 | **$13,874** |
| trig10/off3 | 3378 | $171,762 | 1.63 | 68.6 | 10.7 | $2,815 | −$2,075 | 24% | 42 | 25 | 29 | $10,758 |
| trig12/off2 | 3335 | $184,621 | 1.59 | 63.8 | 10.6 | $2,775 | −$2,190 | 21% | 50 | 13 | 34 | $12,126 |
| trig12/off4 | 3336 | $181,722 | 1.58 | 63.8 | 10.6 | $2,735 | −$2,110 | 23% | 48 | 15 | 34 | $11,834 |
| trig8/off2 (v3 gold) | 3449 | $154,606 | **1.66** | 73.6 | 10.4 | $2,935 | −$2,170 | **18%** | 37 | 36 | 24 | $8,908 |
| trig10/off6 | 3390 | $155,583 | 1.56 | 68.5 | 10.2 | **$2,510** | **−$1,775** | 25% | 33 | 35 | 29 | $9,117 |
| trig8/off4 | 3460 | $138,517 | 1.59 | 73.6 | 9.5 | $3,055 | −$1,930 | 25% | 30 | 43 | 24 | $7,278 |
| trig6/off4 | 3573 | $106,795 | 1.60 | 80.0 | 9.1 | $2,450 | −$1,175 | 28% | 18 | 62 | 18 | $3,891 |

Regen `trig8/off2` = $154,606 exactly matches the deterministic offline re-price of the published gold (exit slippage doesn't alter trade paths) — engine fix validated. Published gold for reference: $193,486 / PF 1.84 (BE slip-free artifact).

## Findings

1. **Monotonic: the less BE engages, the better.** Earlier trigger / any offset just converts +15-pt TP winners (57% of no-BE exits) into +0.5-pt scratches. Under honest slippage the +2 offset banks 0.5 pt gross ≈ $0 net on MNQ after fees.
2. **BE's only payment is tail trimming** — worst day −$2,170 vs −$2,750, and trig10/off6 gets −$1,775 — bought with $20k–$95k of PnL. It never wins on Sharpe.
3. **No-BE wins PnL, Sharpe, and micro-economics** ($13.9k vs $8.9k MNQ real-fee, +56%) and removes the live modifyStop machinery entirely (fewer broker round-trips, no BE-fill anomalies).
4. Balanced alternates if some tail protection is wanted: **trig12/off2** (keeps 90% of no-BE PnL, softens worst day by $560) or **trig10/off3**.

## Gold artifacts

- `data/gold-standard/ls-flip-trigger-bar-v3-ltalign-slipfix.json` — honest regen of current live config (trig8/off2)
- `data/gold-standard/ls-flip-trigger-bar-v3-ltalign-noBE-slipfix.json` — no-BE candidate
- `data/gold-standard/ls-flip-trigger-bar-v3-ltalign-t10o3-slipfix.json` — balanced candidate

Reproduce any row:
```bash
cd backtest-engine
node index.js --ticker NQ --strategy ls-flip-trigger-bar --timeframe 1m --raw-contracts \
  --start 2025-01-13 --end 2026-04-23 \
  --ls-1m-file research/lt-extraction/output/nq_ls_1m_raw.csv \
  --eod-cutoff-et 15:45 \
  --lstb-blocked-hours 5,16,17,18,19,20,21,22,23 --lstb-min-range 3 \
  --lstb-target-pts 15 --lstb-stop-pts 12 \
  --lstb-require-lt-align --ls15-file research/lt-extraction/output/nq_ls_15m_raw.csv \
  [--lstb-breakeven-stop --lstb-be-trigger N --lstb-be-offset M]
```

## Context

Live day-one audit (2026-07-13): 16 fills, 0 TP, 11 BE-outs, 2 SL — twin of the gold's worst day (2025-10-02). Under honest economics the strategy's MNQ expectancy is thin (+$27/day at trig8/off2; +$42/day no-BE), so red days at ~20% frequency are expected behavior, not breakage. **Decision (Drew, 2026-07-13): no-BE.** Applied live same day at 20:38 UTC via `LSTB_BREAKEVEN_STOP=false` env var on the signal-generator Sevalla app + artifact restart (no code change; config.js explicit-override path). ltAlign and all other v3 params unchanged. Verification: first overnight signal must carry no `breakevenStop`/`breakevenTrigger`/`breakevenOffset` fields and orchestrator ExitRule must arm nothing.
