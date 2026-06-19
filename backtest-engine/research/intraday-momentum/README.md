# Intraday Momentum (Zarattini "Concretum Bands") — ES research

New-alpha track (2026-06-15). Mechanistically ORTHOGONAL to the 4 production NQ fade
strategies (GEX/IV/Liquidity-Status mean-reversion): this is an open-anchored
**volatility-band BREAKOUT / trend-continuation** system. Source: Zarattini-Aziz-Barbon
(2024) "Beat the Market: An Effective Intraday Momentum Strategy for the S&P500 ETF (SPY)"
(SSRN 4824172) + Quantitativo ES/NQ practitioner writeup.

## Why ES (not NQ)
The paper + all replications were tested on **SPY / broad S&P baskets — never QQQ**. So ES
is the apples-to-apples instrument. Bonus: ES runs in a separate instrument space from the
4 NQ strategies → no position-slot contention, can fire concurrently.

## Exact spec implemented (`01-sim.js`)
RTH-anchored, matching the SPY methodology.

- **Day open `O_t`**: open of the first 1m bar at/after 09:30 ET.
- **Prev close**: previous trading day's RTH (16:00 ET) close — for the overnight-gap anchor.
- **Minute-of-day `m`**: minutes since 09:30 ET (0..389, RTH = 390 min).
- **Noise** `σ(m) = mean over last N trading days of |close_d(m)/O_d − 1|` (per minute-of-day;
  expanding intraday — tight at the open, wider later). Default `N=14` (practitioner ES/NQ
  variant used 90).
- **Bands on day `t`** with `move(m) = σ(m)·mult·O_t`:
  - `UB(m) = max(O_t, prevClose) + move(m)`
  - `LB(m) = min(O_t, prevClose) − move(m)`
  - Default `mult = 1`.
- **Entry** (one position at a time): at each grid checkpoint (default every 30 min: 09:30,
  10:00, …) if price `> UB` → **long**; if price `< LB` → **short**. Breakout = stop-style
  fill: entry at checkpoint price ± stop slippage. No new entries after `--no-entry-after`.
- **Exit**: session-VWAP trailing stop (VWAP reset at 09:30 ET; long exits when 1s close <
  VWAP, short when > VWAP) → stop-slippage. Force-flat at `--eod` (market slippage).
  Optional `band` re-entry exit.
- **Sizing**: paper uses vol-targeted leverage. We test **fixed 1 ES contract long/short per
  signal** ($50/pt, $5 round-trip commission, 1.5pt stop slip, 1.0pt market slip).

## 1s-honesty (CLAUDE.md mandate)
Two-pass: pass 1 streams 1m to build per-day bands + prev-close + RTH windows; pass 2 streams
1s for honest fills, session VWAP, and chronological exit evaluation from the fill instant.
Entries/exits are stop-style (fill at level ± slip), never optimistic same-bar level fills.

## Bar to clear
Any existing gold standard, framed on 1 contract: lstb $279k/Sh21, glx $217k/Sh8.73,
gfi $209k/Sh5.31, glf $111k/Sh4.44 (all NQ). ES @ $50/pt vs NQ @ $20/pt — 2.5× $/pt, so
compare on Sharpe/PF and risk-adjusted terms, not raw $.

## Files
- `01-sim.js` — parameterized 1s-honest simulator. `node 01-sim.js --help`.
