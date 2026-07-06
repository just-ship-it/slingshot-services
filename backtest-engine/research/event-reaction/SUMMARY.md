# Event-Reaction Alpha — NQ, 1s-honest (follow-up to event-positioning audit)

**Question (Drew, 2026-07-05):** The 4-strat book sidesteps events almost entirely
(prior audit: only 0.5% of trades held into a release). Is there untapped *event-reaction*
alpha — a **new** strategy? Refined by Drew: **act within the first few seconds** of a
release, conclude in **≤5 min** or at least have stops in place.

**Verdict (updated):** Pre-event setup and any entry from +60s on are dead/efficient. BUT a
**fast first-~5s momentum-continuation edge exists on the four 08:30 data releases
(CPI/PCE/PPI/NFP)** — it decays by +60s, which is why the initial +60s sweep missed it and
first read "all efficient." It is a PROMISING candidate, NOT yet a validated/deployable
strategy: three gates remain (tick-level slippage, entry-lag, and sub-minute execution).

### Headline numbers (entry +5s, target 60 / stop 30, hard 5-min time-stop, 2pt roundtrip cost)
- CPI+PCE+PPI basket (n=52): **PF 2.21, avg +14 pts, +$14.8k**; train/test **H1 2.81 → H2 1.76**
  (both halves positive). NFP also PF 2.39 → tradeable set = CPI/PCE/PPI/NFP.
- FOMC / GDP / RETAIL: dead (PF ~0.4–0.5, tend to reverse). Drop them.
- Survives pessimistic cost: basket PF 2.09 at 3pt roundtrip.
- Exit mix time46 / stop42 / target27, avg hold **158s** — fits the ≤5-min spec.

## Data
- Event calendar reused from event-positioning audit (FRED release dates + hardcoded FOMC):
  119 events in the 1s span, 2024-12 → 2026-06 (CPI, PPI, NFP, PCE, GDP, RETAIL, FOMC).
- Phase 0 (`01-extract-event-windows.js`) streamed the 8.3GB `NQ_ohlcv_1s.csv` once, pulling
  primary-contract 1s bars in `[release − 30m, release + 90m]` per event → `output/event-windows-1s.csv`
  (721,578 bars, 0 empty windows). Primary = highest-volume symbol per window; calendar
  spreads dropped. Raw-contract price space throughout.
- All measurements anchored to the release instant, walking 1s bars forward — honest by construction.

## Phase 1 — characterize (`02-characterize.js`)
- **Magnitude is large.** Median |move| at 60s: 21 pts overall, CPI 90, NFP 45, PPI 37.
  Median MFE/MAE round-range +90m ≈ 189 pts. Plenty of range to trade *if* direction were knowable.
- **Raw correlation looked strong but is an artifact.** `corr(impulse_60, move_600) = 0.82`
  overall — BUT both are measured from the same pre-release price, so they share the impulse
  displacement. This is NOT tradable edge; it's the same move counted twice.
- **Pre-event drift does not predict direction.** `corr(pre_drift_30m, move_600) = 0.10`,
  P(post continues pre-drift) = 48% — a coin flip. Markets price the unknown. → Angle (a) DEAD.

## Phase 3 — forward move from a realistic entry (`03-reaction-forward.js`)
The honest test: enter a minute or two *after* the release in the impulse direction; does
price keep going **from the entry price**?
- **+60s entry: forward move is flat-to-negative** (mean fwd@600s = −3.6 pts, 49% positive).
  The knee-jerk does NOT continue — it slightly fades. FOMC reverses hard (−26 pts).
- **Forward MFE ≈ MAE ≈ 95 pts** at every entry — symmetric excursion = random walk. The
  information is fully priced within ~60s.
- **Entry-timing surface sign-flips every 60s**, confirming noise:

  | entry | mean fwd@600s | 60/30 sim PF |
  |---|---|---|
  | +60s | −3.6 | 0.93 |
  | +90s | +6.2 | 1.14 |
  | +120s | (pos) | 1.36 |
  | +150s | −0.0 | 1.16 |
  | +180s | +3.2 | 1.41 |
  | +240s | −2.7 | 0.98 |
  | +300s | −2.2 | 0.97 |

  A real momentum edge decays smoothly; this flips sign with a 60-second entry shift. The
  positive cells (+90/+120/+180) are cherry-picks from a ±3–7 pt wobble inside a ~95 pt
  noise band. → Angle (b) DEAD.

## Only non-dead tilts (NOT deployable)
- **PCE and PPI** show a persistent small positive forward continuation at +60s (PCE +11.8,
  PPI +4.9 pts @600s, ~65% positive). But n=18 each, across 7 event types × several entry
  times × several exit grids — this is exactly where multiple-comparison false positives live.
  Not actionable without far more events.
- **Long-gamma / straddle into events** is the only theoretically-live edge (you don't need
  direction to profit from a big symmetric move) — but that's a **0DTE options** play, not an
  NQ-futures directional trade. Belongs to the separate options-exploration track, not this book.

## Why this is consistent with the house view
- Order-flow research already found the second-scale tape EFFICIENT (`orderflow-sweep`).
- The event-positioning audit found the book sidesteps events by construction and lost nothing.
- Event *reaction* is efficient at the second scale too, for directional futures trades.

## Files
- `01-extract-event-windows.js` → `output/event-windows-1s.csv`, `output/window-manifest.csv`
- `02-characterize.js` → `output/event-features.csv` + stdout report
- `03-reaction-forward.js` → stdout report (parameterized by `--entry`)

## Caveats
- Directional futures only. Non-directional (options straddle) not tested here.
- Pre-event tested at the drift/range level; deep order-book microstructure into the release
  not tested (but order-flow track already found the tape efficient).
- 119 events; per-type cells are ~18. Treat all per-type splits as anecdotes.
