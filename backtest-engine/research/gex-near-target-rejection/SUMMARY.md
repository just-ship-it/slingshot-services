# GEX-level rejection near target — does price stall at a known GEX level short of TP and reverse to a loss?

**Date:** 2026-06-16 · **Strategies:** GLF (gex-level-fade v2), GFI (gex-flip-ivpct v2), GLX (gex-lt-3m-crossover v3). LS-Flip excluded.
**Range:** 2025-01-13 → 2026-04-23, 1430 completed trades. **GEX source:** `data/gex/nq-cbbo` (lookahead-corrected, the set GLF/GLX ran on).

## Question
For these 3 NQ strategies, are we losing money on signals where price ran almost to target, **bounced/rejected at a known GEX level sitting between the peak and the target**, then reversed into a stop or break-even? (Drew's screenshot: a SELL whose move stalled at a newly-formed GEX support just short of TP.)

## Method
- Trades come from the gold-standard JSONs — exits/MFE already 1s-honest (engine `SecondDataProvider`). We only overlay GEX geometry.
- **Phase 1** (`01-analyze.js`): for each loss/BE trade that traveled ≥40% to target, find the GEX level nearest the MFE peak that sits *between* the peak and target ("cap level"), within a touch tolerance. Outcome class is `exitReason`-based so a `breakeven_stop` at +offset counts as break-even, not a win.
- **Phase 2** (`02-verify-1s.js`): re-walk the 7.6 GB 1s file (filtered to each trade's `signalContract`) to recover the **exact MFE-peak timestamp**, cross-check MFE vs the engine, and re-test the cap level using **only GEX snapshots known at/before the peak** — killing the lookahead risk that a level formed *after* the bounce.

## Result — real but rare; not a meaningful bleed

| | count | net $ |
|---|---|---|
| All loss/BE trades | 839 | — |
| Phase-1 candidates (cap level at peak, touch≤10pt) | 21 | −$13.4k |
| **Phase-2 confirmed** (level known **at/before** peak) | **14** | **−$8,638** |
| …of which the level **formed during the trade** ("newly formed") | 3 | — |
| …**near-target** (cap level within 20pt of TP — the exact screenshot case) | **1** | −$475 |

- **~1.7% of losing/BE trades; ~1% of all trades.** 7 of 21 Phase-1 hits were lookahead artifacts (level appeared after the peak) — dropped.
- **MFE cross-check: 14/14 (21/21) match the engine within tolerance** → numbers are 1s-honest.
- Cap-level types: put_wall ×3, S3/S4/S5 ×4, R2/R4/R5 ×4, gamma_flip ×2. (Support levels for longs, walls/flip for shorts — as expected.)
- Most caps sit **30–68pt short of target**, not right at it. The "level hugging the target" case Drew screenshotted is essentially a unicorn (1 trade in 16 months).

### Control — does coinciding with a level actually predict the reversal?
Of trades that got ≥40% to target but fell short: **with** a GEX cap level at the peak → 21.9% loss/BE; **without** → 17.8%. A real but **modest** ~4pp lift. Most trades that approach target complete to it whether or not a level is in the way.

### Honest counterfactual
The "$58k upside if they'd hit target" figure is misleading — the level is *why* they didn't. The actionable prize is only converting these 14 stop-outs into small wins by exiting at the level (~+$8.6k swing), and a "cut at GEX cap level" rule would also clip the ~75 trades that stalled at a level but still finished positive. Net edge from acting on this is marginal.

## Verdict
The phenomenon is **real and verified but rare and low-impact** — ~14 trades / −$8.6k over 16 months, dominated by GLX/GLF longs capped by support levels well short of target. The specific "rejected at a newly-formed level right near TP" pattern is a near-unicorn. Not worth a dedicated production filter; revisit only if folded into a broader exit-management study.

## Files
- `01-analyze.js` → `output/victims.json` (21 candidates + sweep/control)
- `02-verify-1s.js` → `output/verified.json` (14 confirmed, 1s-honest)
- Notable: `glf:T000420` (only near-target case, put_wall, MFE 90.75/110); worst `glx:T000099/047/154` (~−$1.4k each, S4/put_wall).
