# Vol-Compression Breakout (NQ, 1s-honest) — VERDICT: NO

Deck idea: `volregime` "suppressed vol = compressed spring → trade the expansion, rent the trend."
Tested as a standalone NQ strategy: enter on 1m squeeze RELEASE (squeeze_on→squeeze_off, via
`shared/indicators/squeeze-momentum.js`) in the momentum direction; 1s-honest fills + exits.

## Result: no edge in any of 18 configs
Entry onMin ∈ {1,3,6} × exits {ATR stop/target, hold-to-EOD+stop, momentum-flip, wide fixed target}.
Window 2025-01-13..2026-04-23 (matches the FCFS book).
- PF spans **0.77–0.90**, Sharpe **negative everywhere**, WR 20–34%, in BOTH train (≤2025-09-30) and test.
- 0/18 configs reach train&test PF>1.1. Throughput would be high (~210 trades/mo) — the edge is just negative.
- e.g. `EOD_s3_on1` n=3402 −$234k PF 0.87 (train 0.85 / test 0.90); `ATR_s2t4_on1` −$244k PF 0.81.

## 1s-honesty (verified)
- Fill = OPEN of the first 1s bar with ts strictly after the 1m signal bar closes (`fillSec=(sigMin+1)*60`);
  every pre-fill 1s bar skipped. Exit walk uses only `sec>=fillSec`, stop/target on 1s low/high, tie→stop.
  EOD-flat 15:45 ET, per-day front contract, max-hold ceiling.
- **Fill-honesty assertion:** for m=100, chosen fill bar sec = 6060 = (100+1)×60 across 20/20 sampled days,
  0 violations. The fill-bar bug *inflates* results; these are negative → bug absent by construction.
- **Invert symmetry:** fading the release moves PF 0.87→~0.95–1.05 (roughly symmetric → no labeling bug);
  the fade itself is only break-even and not robust, far below the book's PF-1.4+ GEX-fade strategies.
- Correlation to the FCFS book: moot — nothing profitable to deploy.

## Interpretation
NQ does not trend out of an intraday squeeze release — it weakly MEAN-REVERTS (the fade side is the
less-bad one). That mean-reversion is already harvested, and better located, by the production
GEX-level-**fade** (at GEX/LT levels) than by a raw squeeze break. A breakout is the wrong side of NQ
intraday — consistent with the parked `intraday-momentum` finding that NQ breakouts struggled. The
deck's "compressed spring" intuition does not express as a tradeable intraday breakout on NQ.

Artifacts: `01-precompute.js` (streams 8.3GB 1s → output/rth1s.NQ.bin, 7.27M RTH 1s bars / 334 days),
`02-sim.js` (the 18-config sweep). Reusable if revisiting with a mean-reversion (not breakout) thesis,
a different vehicle (ES/YM/RTY), or an overnight/RTH-open-range variant.
