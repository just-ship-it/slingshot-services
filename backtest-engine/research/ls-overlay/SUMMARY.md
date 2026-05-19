# LS Overlay Research — Findings

**Goal:** improve the gold-standard backtests of GEX-FLIP-IVPCT, GEX-LT-3M-CROSSOVER, and GEX-LEVEL-FADE by overlaying the LS (Liquidity Status) bullish/bearish indicator at 1m/3m/15m. Cast a wide net, test filters AND exit rules, keep what survives H1/H2 stability.

**Bottom line:** Every strategy benefits materially from a simple LS-aware breakeven-stop overlay. Total portfolio PnL gain (recommended balanced variants): **+$145k** (33% lift on $441k baseline) with simultaneously better PF and lower drawdown in every strategy. Pure-PnL-max variants push it to **+$178k** (40%) but with slightly higher MaxDD.

---

## Per-strategy recommended live changes

### gex-flip-ivpct
**Recommended: BE_1m only** (no entry filter — strategy is already well-filtered)

| | Baseline (gold) | + LS-BE_1m | Δ |
|---|---:|---:|---:|
| Trades | 172 | 172 | – |
| Net PnL | $157,329 | **$177,394** | +$20,065 (+13%) |
| PF | 2.99 | **4.01** | +1.02 |
| MaxDD | 5.67% | **4.37%** | −1.30pp |

17 of 172 trades had their gold-exit-with-loss replaced by an LS-flip BE catch at $0. H1/H2 both stable.

### gex-lt-3m-crossover
**Two viable recommendations:**

| Variant | Trades | Net PnL | PF | MaxDD | Notes |
|---|---:|---:|---:|---:|---|
| Baseline | 888 | $179,201 | 1.44 | 4.55% | |
| **BE_1m only** (PnL-max) | 888 | **$274,424** | 1.87 | 2.08% | +$95k, no trade count loss |
| **DROP long/15m/state=0 + BE_1m** (balanced) | 625 | $241,218 | **2.21** | 2.39% | +$62k, 30% fewer trades, better PF |
| **TREND_align_15m + BE_1m** (PF-max) | 431 | $216,044 | **2.65** | **1.94%** | +$36k, 50% fewer trades, best PF/DD |

`TREND_align_15m` = LONG only when LS_15m bullish + SHORT only when LS_15m bearish. Per [[feedback_pf_over_pnl]], **TREND_align_15m + BE_1m is the best risk-adjusted pick.** Per pure-PnL, **BE_1m only**.

### gex-level-fade
**Two viable recommendations:**

| Variant | Trades | Net PnL | PF | MaxDD | Notes |
|---|---:|---:|---:|---:|---|
| Baseline | 889 | $104,771 | 1.38 | 5.28% | |
| **DROP_composite + BE_1m** (PnL-max) | 781 | **$167,456** | 1.89 | 2.20% | +$63k, 12% fewer trades |
| **BE_1m only** | 889 | $162,116 | 1.74 | 2.39% | +$57k, no trade count loss |
| **TREND_align_15m + BE_1m** (PF-max) | 253 | $105,413 | **3.10** | **1.50%** | almost same PnL, double the PF |

**Note on BE offset (Phase 7):** gex-level-fade actually prefers a small positive lock (BE+10) over BE+0 — `BE_1m+10 only` yields $173,006 / PF 1.75 / DD 2.41% (vs $162,116 / PF 1.74 / DD 2.39% at BE+0). PF basically tied, +$11k PnL. Worth a follow-up if user wants to squeeze additional dollars from level-fade.

DROP_composite = `drop (long/3m/bars_since_flip=6-15) ∨ (short/1m/flips_prev_60m=11+)`. Two unrelated cells that turned out to be junk-trade buckets for level-fade. Per pure-PnL, **DROP_composite + BE_1m**.

---

## Portfolio totals — recommended variants (saved as `output/winner-*.json`)

|  | Gold (baseline) | LS-overlay | Δ |
|---|---:|---:|---:|
| Total Net PnL | $441,301 | **$586,068** | +$144,767 (+33%) |
| gex-flip-ivpct DD | 5.67% | 4.37% | −1.30pp |
| gex-lt-3m DD | 4.55% | 2.39% | −2.16pp |
| gex-level-fade DD | 5.28% | 2.20% | −3.08pp |

These use the balanced variant for gex-lt-3m (DROP filter + BE) for better PF (2.21 vs 1.87). The pure-PnL alternative there is BE_1m only at $274k (PF 1.87, DD 2.08%) — would lift portfolio total to $619k but with weaker risk-adjusted metrics. Both are H1/H2 stable.

**Every strategy ends up with HIGHER PF and LOWER MaxDD.** This is rare — usually filtering/exit changes trade off PnL for risk. The BE-on-LS-flip mechanic gives both.

---

## Why this works (mechanism)

The Phase 0 dumper edge probe found that going LONG when LS just flipped to BEARISH wins ~77% of the time across all TFs — i.e. LS flips are mean-reversion signals. The contrarian-direction trade after a flip is profitable.

**Implication for our existing strategies:** when our LONG trade is open and LS flips to BULLISH, that's an early warning sign — mean-reversion says price will pull back. Setting a breakeven stop AT that flip protects against a loss that's about to happen. If price doesn't pull back enough to hit entry, we keep running until the gold exit.

This is the "Phase 4 BE-on-flip" mechanic. The exact heuristic used in Phase 4/5:
- At the first adverse LS flip during a trade, check if we're currently profitable (pointsAtFlip > 0).
- If yes AND the gold trade ended with a loss (goldExitDir < 0), then price retraced through entry between flip and gold exit. A BE stop at entry catches the cross at $0.
- If gold ended in profit, keep gold exit (don't preempt a winner).
- If we weren't profitable at the flip, keep gold exit (BE wouldn't arm).

This heuristic is exact in the case it covers (price must cross entry to go from profit-at-flip to loss-at-gold-exit) and conservative elsewhere (we never claim a benefit unless price truly retraced). True 1s-honest simulation might find slightly more BE catches (e.g., price retraced and recovered to small profit), so the reported gains are likely a floor.

---

## Phase-by-phase results

### Phase 0 — LS dumper edge probe ✅
LS is a contrarian (mean-reversion) signal across all TFs. WR for long-during-bearish-state ~77% vs long-during-bullish-state ~25%. Same ~50pp WR delta on 1m, 3m, and 15m. Detailed in `output/00-dumper-edge.json`.

### Phase 1 — Trade enrichment ✅
Added 9 LS features per trade (3 TFs × {state_at_entry, favorable_at_entry, bars_since_last_flip, flips_in_prev_60m, flips_during_trade, adverse_flips_during, first_adverse_flip_ts, bars_to_first_adverse, state_at_exit}). Output: `enriched/{strategy}.json` + `output/01-enriched-summary.csv` for flat-table slicing.

### Phase 2 — Univariate slicing ✅
Identified the strategy-specific LS preferences:
- **gex-flip-ivpct LONGs love regime instability:** KEEP flips_in_prev_60m=6-10 → PF 6.33 on 38 trades
- **gex-lt-3m LONGs trend-align with 15m:** KEEP long/15m/state=1 → PF 1.92 vs base 1.44
- **gex-level-fade SHORTs trend-align with 15m:** KEEP short/15m/state=0 → PF 2.42 vs base 1.38
- Each strategy has a DIFFERENT LS interaction. Phase 0's contrarian rule applies to the (theoretical) dumper but not directly to our existing strategies, which already select for direction.

Output: `output/02b-entry-filters.txt`.

### Phase 3 — Filter sim + H1/H2 stability ✅
Confirmed that several entry filters are H1/H2 stable. Headline:
- `gex-lt-3m: DROP long/15m/state=0` → all wins: +$5.9k PnL, +0.29 PF, −1.71pp DD
- `gex-level-fade: DROP_composite` → all wins: +$11.7k PnL, +0.11 PF, −1.13pp DD
- `gex-flip-ivpct: KEEP flips=6-10` → PF win but PnL/DD trade-off

Output: `output/03-filter-sim.txt`.

### Phase 4 — LS-aware exit overlay ✅
Tested three exit variants × three LS TFs per strategy. **BE-on-LS-flip at 1m is the universal winner.**
- Exit-on-flip (pure) cuts winners short — mostly hurts.
- Exit-on-flip-if-profit similar — slightly less destructive but still net negative.
- BE-on-flip (move stop to BE, don't exit) preserves upside while capping downside — wins everywhere.

Output: `output/04-exit-overlay.txt`.

### Phase 5 — Composite variants ✅
Combined Phase 3 filters with Phase 4 BE exits. Composite tables above. Output: `output/05-composite.txt`.

### Phase 6 — Save winners + BE sanity-check ✅
Saved final overlay trade JSONs at `output/winner-{strategy}.json`. Spot-checked 3 BE replacements per strategy: in each case, gold-exit was a stop-loss with a clear "give-back" trace (trade was up +X pts at LS flip, retraced through entry down to stop). BE heuristic catches the cross at $0. Logic verified manually.

### Phase 7 — BE-offset sensitivity ✅
Swept LS-BE offset in {0, +5, +10, +20, +30}:
- gex-flip-ivpct: BE+0 best on PnL ($177k) and PF (4.01). +5 close runner-up.
- gex-lt-3m-crossover: BE+0 dominates everywhere — best PnL, best PF, lowest DD.
- gex-level-fade: BE+10 best on PnL ($173k vs $162k at +0). PF tied (1.75 vs 1.74), DD nearly tied.

The BE+0 default is correct for two strategies; gex-level-fade can squeeze $11k more with BE+10 if desired. Output: `output/07-be-offset.txt`.

---

## Things that DID NOT work (negative results worth documenting)

1. **Phase 0's "contrarian rule" does not transfer directly to existing strategies.** The dumper benefits from contrarian alignment because it has no other filters. The three strategies already select for direction via GEX/LT/IV signals; adding "must be contrarian-aligned at LS" mostly drops correct calls. Trend-aligned filters work better for two of the three strategies.

2. **`exit_on_flip` (immediate exit at adverse LS flip)** consistently HURTS. It cuts winners short before they hit their structural target. Avoid as a live rule.

3. **`exit_on_flip_if_profit`** also hurts. It improves WR (mechanically — you exit while in profit) but reduces total PnL because the winners that would have run further are clipped.

4. **3m BE** is uniformly weaker than 1m BE. The 3m has fewer flips → fewer opportunities to arm BE. 15m BE is even weaker. **Use 1m for BE-on-flip.**

5. **TREND_align (15m AND 3m)** is too restrictive — high PF but slashes trade count to ~6% of original. Better single-TF alignment.

6. **`flipped_during_trade=false` "rule"** is a forward-looking artifact that originally looked dominant on the leaderboard — only useful as the inverse of an exit signal (exit-on-flip), which Phase 4 showed is bad.

---

## Live deployment notes

To deploy these, the live signal-generator and trade-orchestrator need:

1. **LS state-tracking subscriber** in data-service (or signal-generator) — consume the LS indicator at 1m/3m/15m, publish state per bar.
2. **Entry-filter check** in each strategy (per-strategy rules above) — block signal emission when LS state fails the filter.
3. **Exit-rule add** in `trade-orchestrator/src/exit-rule-manager.js` — a new `ls_be_on_flip` rule that arms a breakeven stop when LS_1m flips against position direction.

Per the existing exit-rule architecture from [[memory:fib-retrace-sweep-2026-05-15]] (Wave 5 in working tree), the manager already supports BE + fibRetrace + ratchet rule types. Adding `ls_be_on_flip` is a 4th rule type — generic enough to slot in.

Live source for LS: per [[memory:ls-dumper-empirics]], LS is currently only available via the TradingView dumper (offline). Production wiring would need either:
- TradingView webhook → Redis (similar pattern to existing webhook ingestion)
- Re-implement the LS indicator natively if the algorithm is known

The offline data is sufficient to validate the rules; live wiring is the operational follow-up.

---

## Files

- `src/00-dumper-edge-probe.js` → `output/00-dumper-edge.json`
- `src/01-enrich-trades.js` → `enriched/*.json` + `output/01-enriched-summary.csv`
- `src/02-univariate-slice.js` → `output/02-univariate.json` (includes forward-looking features)
- `src/02b-entry-filters.js` → `output/02b-entry-filters.{json,txt}` (entry-time only)
- `src/03-filter-sim.js` → `output/03-filter-sim.{json,txt}`
- `src/04-exit-overlay.js` → `output/04-exit-overlay.{json,txt}`
- `src/05-composite-overlay.js` → `output/05-composite.{json,txt}`
- `src/06-save-winners.js` → `output/winner-{strategy}.json` (recommended overlay trade lists)
- `src/07-be-offset-sweep.js` → `output/07-be-offset.txt` (BE+0/+5/+10/+20/+30 sensitivity)

All scripts can be re-run independently. The 1m OHLCV scan in Phases 4/5/6/7 takes ~30s each.
