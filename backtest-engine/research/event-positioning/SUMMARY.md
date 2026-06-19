# Event-Positioning Audit — 4-strat FCFS book

**Question:** When the deployed 4-strategy NQ FCFS book (single 1-NQ slot, first-in-wins)
holds a position **going into a major scheduled economic event**, does it do better or
worse than normal? Should we flatten before events?

**Events covered:** FOMC, CPI, NFP, PCE, PPI, GDP, Advance Retail Sales.
**Window:** release-time anchored — a trade is "held into an event" iff the position is
OPEN at the release instant (`entryTime <= release_ts <= exitTime`). Release times:
08:30 ET for all data releases, 14:00 ET for the FOMC statement.

## Pipeline
- `01-build-event-calendar.js` — pulls actual release dates from FRED's
  `/fred/release/dates` API (CPI=10, PPI=46, NFP=50, PCE=54, GDP=53, Retail=9) + a
  hardcoded FOMC list (FOMC is a Fed rate decision, not a FRED data release). Actual
  publication dates → the 2025 gov't-shutdown reschedules are handled automatically.
  → `output/event-calendar.csv` (121 events, 2024-12 → 2026-06).
- `02-audit-fcfs.js` — reproduces the live book (matches baseline exactly:
  6,128 trades / $614,730 / PF 1.77 / Sharpe 10.78 / DD 4.45%), tags each realized
  trade with the events crossed during its hold, compares groups.
  → `output/fcfs-trades-event-tagged.csv`.

## Headline finding — the book structurally almost never holds into events

| group | trades | WR | PF | Sharpe | maxDD | avgPnL | totalPnL |
|---|---|---|---|---|---|---|---|
| ALL (book) | 6128 | 67.0% | 1.77 | 10.78 | 4.45% | $100 | $614,730 |
| held-into-event | **32 (0.5%)** | 75.0% | 4.71 | 7.4 | 2.6% | $852 | $27,262 |
| no-event-during-hold | 6096 | 66.9% | 1.75 | 10.34 | 4.53% | $96 | $587,468 |

**Only 32 of 6,128 trades (0.5%) were open across an event release instant.** The
strategies' short holds + 15:45 ET EOD flat mean event-window exposure is already tiny.
So "flatten before events" addresses a risk the book barely takes.

The 32 event-held trades are net positive (PF 4.71, 75% WR, +$27k) but the WR difference
vs non-event is **not significant** (z=0.97, p=0.334) on n=32.

## Per-event-type (tiny samples — directional only, not actionable)

| event | #evts in span | trades held | WR | PF | totalPnL |
|---|---|---|---|---|---|
| FOMC | 10 | 2 | 100% | ∞ | +$490 |
| CPI | 15 | 8 | 75% | 4.97 | +$10,532 |
| PPI | 15 | 6 | 100% | ∞ | +$13,655 |
| RETAIL | 17 | 4 | 75% | 9.36 | +$2,300 |
| PCE | 15 | 6 | 66.7% | 2.37 | +$2,045 |
| GDP | 14 | 5 | 60% | 0.58 | −$1,015 |
| NFP | 14 | 3 | 33.3% | 0.02 | −$1,670 |

Only **NFP and GDP** are net-negative when held across — but 3 and 5 trades respectively,
far too few to act on. CPI/PPI carry the positive total.

## By origin strategy
`gex-level-fade` **never** holds into an event (0 trades — it flattens/EOD-cuts before
all of them). `gex-flip-ivpct` (10) and `gex-lt-3m` (9) account for most event holds and
both show higher WR on event-held trades than their non-event trades (70% vs 50%, 78% vs
60%) — but again, single-digit samples.

## Verdict
- **Do NOT add a blanket "flatten before events" rule.** Dropping the held-into-event
  trades *reduces* book PnL by ~$27k over 16 months (they're net winners) and barely
  moves drawdown (4.45% → 4.53%). Event exposure is already negligible by construction.
- The only directional negatives (NFP, GDP) are too small-sample to filter on.
- If anything is worth a follow-up, it's the opposite question: the book sidesteps events
  so completely that there may be untapped *event-reaction* alpha — but that's a new
  strategy, not a filter on this book.

## Caveats
- n=32 held-into-event trades total; per-type cells are 2–8 trades. Treat all per-type /
  per-strategy splits as anecdotes, not signal.
- Counterfactual is a first-order PnL subtraction, not a re-sim (freeing the slot earlier
  could admit other trades). Bounds the effect; doesn't model slot dynamics.
- Gold-standard JSONs span 2025-01 → 2026-04; the event calendar runs to 2026-06 but only
  100 events fall inside the traded span.
