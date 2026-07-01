# June 2026 Production Signal Audit — raw signal pull

Pulled 2026-06-30. Goal: replay every raw signal the 4 FCFS production strategies
generated in June 2026 through a single-slot FCFS engine + historical candles to
estimate how the book would have performed, independent of live accept/reject.

## Source
- Prod monitoring-service `GET /api/alerts/historical?date=YYYY-MM-DD`
  (Sevalla, backed by uncapped Redis `alerts:by-day:*`).
- Window: 2026-06-01 .. 2026-06-30 (ET). 22 trading days. Raw day archives in `raw-alerts/`.
- Auth: prod `DASHBOARD_SECRET` (global env var; differs from local `shared/.env`).

## What's included
Every alert with `severity ∈ {signal, rejected}` carrying a `signal.strategy` in the
4 production strategies. Both ACCEPTED and REJECTED are kept (all rejection reasons:
`trading_disabled`, `no_accounts_passed_gates`) — per the audit goal, the live
accept/reject decision is overridden by the FCFS single-slot replay.

Validated ∪ rejected ≈ the full published `trade.signal` stream. Silent drops NOT in
the archive: missing-strategy, <60s same-`signalId` dedup, invalid side/action.

## Files
- `june-2026-raw-signals.json` — 1518 records, chronological, full fields.
- `june-2026-raw-signals.csv` — same, flat.
- `june-2026-raw-signals-deduped60s.json` — 1507; same-tuple re-emissions within 60s collapsed.

Fields: dateEt, timeEt, timestamp(UTC ISO), strategy, ruleId, side(LONG/SHORT),
symbol, action, entry, stop_loss, take_profit, status, reason, breakevenTrigger,
breakevenOffset, maxHoldBars, alertId.

## Counts (total / accepted / rej:trading_disabled / rej:no_accounts)
- LS_FLIP_TRIGGER_BAR  1321 / 601 / 346 / 374
- GEX_LEVEL_FADE         31 /  18 /   2 /  11
- GEX_FLIP_IVPCT         17 /   7 /   1 /   9
- GEX_LT_3M_CROSSOVER   149 /  62 /  29 /  58
- TOTAL                1518 / 688 / 378 / 452   (LONG 677 / SHORT 841)

## Caveats for the candle replay
1. **Manual resends are NOT flagged** in the archive (the resend endpoint republishes
   `trade.signal` with no marker). None were distinguishable; the tight-window
   duplicates are strategy *re-emissions* while a price condition persists, not manual
   resends. FCFS slot occupancy suppresses these during a held trade.
2. **Contract rollover mid-June**: MNQM6/NQM6 → MNQU6/NQU6 (M6 expiry ~Jun 19).
   Signals appear in both micro (MNQ) and full (NQ) roots but identical NQ price space
   (only 1 NQ/MNQ same-minute overlap — no double-counting). The replay must handle the
   roll spread per the repo's rollover rules.
3. **1s honesty**: per CLAUDE.md, any WR/PF/Sharpe/DD numbers MUST be simulated on 1s
   OHLCV from the fill instant. `scripts/trade-audit.js` is 1m-only (optimistic) — fine
   for a first pass, not for trusted numbers.
