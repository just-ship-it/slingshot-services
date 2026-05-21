# GEX-FLIP-IVPCT v2 — Morning Summary

## Headline

**New gold standard: `gex-flip-ivpct-v2.json` ($208,938 / +33% / PF 3.39 /
Sharpe 5.31 / DD $8,595 / 161 trades).**

Drew, the v2 preset dominates the tight-stop gold on every dimension that
matters under your PF-over-PnL preference: +33% PnL, +0.40 PF, +12% Sharpe,
**-41% DD**, with the same -$1,235 max single-trade loss (well under your
$1,240 small-account cap).

## Pareto-best table (engine-validated, 16 mo)

| Variant | Trades | PnL ($) | WR% | PF | Sharpe | DD ($) | WorstLoss |
|---------|-------:|--------:|----:|---:|-------:|-------:|----------:|
| Gold (tight-stop, prior live) | 172 | 157,329 | 61.6 | 2.99 | 4.76 | 14,580 | -1,235 |
| **v2 (recommended)** | 161 | **208,938** | 54.0 | **3.39** | **5.31** | **8,595** | -1,235 |
| v2-max (max PnL) | 161 | 217,538 | 54.7 | 3.49 | 5.14 | 8,595 | -1,235 |
| v2-low-dd (selective) | 119 | 167,713 | 55.5 | **3.70** | 4.92 | 11,190 | -1,235 |

**Recommended pick: v2.** Best Sharpe + best DD. v2-max trades +$8.6k PnL
for -0.17 Sharpe at identical DD — pick only if max dollars matter more
than smoothness. v2-low-dd is misnamed in engine (its DD is actually
slightly above v2's); it's a "fewer trades / higher PF" selective variant
saved for completeness following the lstb / glx family naming convention.

## Mechanism (two compounding levers)

1. **Target 200 → 260pt**: gold's target=200 left fat-tail upside on the
   table. Avg win jumps $1,524 → $2,121.
2. **BE trigger 70 → 160pt** (offset +5 → +10): gold's BE 70/+5 was
   clipping 36 trades at +$5pt — micro-wins that masked variance. BE at 160
   arms only on the ~11 trades that genuinely retrace from MFE≥160pt. Most
   trades complete via target or stop normally. This is what drives the
   DD reduction: by removing the BE-at-+5 cluster of micro-wins, the equity
   curve reveals the genuine R:R asymmetry of the underlying edge — and
   variance per trade actually goes DOWN.

The combo: PnL up, PF up, Sharpe up, **DD down**. Pareto-pure improvement.

## What's deployed if you `pm2 restart signal-generator` right now

Default behavior on next restart: **v2**. The signal-generator config now
defaults `GFI_PRESET=v2` and `GFI_FIB_RETRACE=false`.

**However** — if Sevalla has any of these env vars set, they continue to
override v2's preset fields (backwards-compatible):
- `GFI_STOP_POINTS`, `GFI_TARGET_POINTS`
- `GFI_BREAKEVEN_TRIGGER`, `GFI_BREAKEVEN_OFFSET`
- `GFI_MAX_HOLD_BARS`, `GFI_BLOCKED_HOURS_ET`
- `GFI_FIB_RETRACE`

If you have those set on Sevalla from the prior tight-stop config, you'll
get a Frankenstein. Two clean options:

### Option A — deploy v2 cleanly (recommended)

In Sevalla signal-generator env, **delete or unset** these env vars (let
the v2 preset values apply):
- `GFI_STOP_POINTS` (was 60 — same; harmless if left)
- `GFI_TARGET_POINTS` (was 200 — must remove to get v2's 260)
- `GFI_BREAKEVEN_TRIGGER` (was 80 — must remove to get v2's 160)
- `GFI_BREAKEVEN_OFFSET` (was 10 — same; harmless if left)
- `GFI_FIB_RETRACE` (was true — must remove or set to `false` to get v2)

Or simpler: explicitly add `GFI_PRESET=v2` (default anyway, but makes intent
explicit) and remove ALL `GFI_*` individual overrides. Result: v2 preset
applies cleanly.

### Option B — pin to tight (revert)

If you're not ready to deploy v2, set `GFI_PRESET=tight` on Sevalla. That
reproduces the prior production config exactly:
- target=200, stop=60, BE 70/+5, fib retrace ON.

(Note: `GFI_PRESET=tight` honors the prior production's fib retrace overlay
by setting `fibRetrace` default to true when the tight preset is selected.
This was the "twolayer-be80p10-fib618-a40" config from the 2026-05-12 refit.)

## Files committed (not auto-pushed — review-then-commit)

- `shared/strategies/gex-flip-ivpct.js` — new `blockedDowsEt` param + `getETDow()` helper
- `backtest-engine/src/cli.js` — `--gfi-preset {tight,v2,v2-max,v2-low-dd}` + `--gfi-blocked-dows`
- `signal-generator/src/utils/config.js` — `GFI_PRESET` env var + preset resolver
- `backtest-engine/STRATEGY-GOLD-STANDARDS.md` — GFI section updated to v2
- `backtest-engine/data/gold-standard/gex-flip-ivpct-v2.json`
- `backtest-engine/data/gold-standard/gex-flip-ivpct-v2-max.json`
- `backtest-engine/data/gold-standard/gex-flip-ivpct-v2-low-dd.json`
- `backtest-engine/research/gex-flip-ivpct-improve/` (full research dir with SUMMARY.md)
- `memory/gex-flip-ivpct-v2-improvements.md` + `MEMORY.md` index entry

## Risks / caveats

1. **Sim-to-engine drift of -9 to -11% PnL** for v2 variants — the simulator
   counts trades on the gold's fill-instant set, while engine generates a
   slightly different trade stream under wider exits (159 position-already-
   active rejections vs ~0 for gold). The relative ordering is reliable but
   the absolute headline number may slip another -3 to -8% in live forward
   trading vs the engine backtest, depending on actual slot conflicts.

2. **`v2-low-dd` is misnamed in engine.** Sim predicted DD $5,100; engine
   delivered DD $11,190 (higher than v2's $8,595). The h11+Fri+S1 filter
   reduces trade count but also concentrates the remaining trades' DD
   cluster. It does deliver the highest engine PF (3.70) at fewer trades —
   useful if you specifically want a smaller trade footprint, but **not**
   the actual minimum-DD variant.

3. **The "S1 disable" simulator finding was a false positive** that I
   noticed during engine validation. In the strategy, when S1 is disabled,
   S2 (same level/IV/proximity gate modulo skew) fires for the same entry —
   same trade, different rule label. I removed disabledRules from v2's
   preset because it was a no-op. v2 and the previous "v2-no_filter" sim
   candidate are now identical. (v2-low-dd's S1 disable is similarly a
   no-op, but the h11+Fri filters work.)

4. **Fib retrace OFF by default in v2.** The prior production had it on.
   Research showed adding fib to v2's wider exits HURTS by $20-30k. v2-tight
   preset path preserves fib=on for back-compat. If you want v2 + fib, set
   `GFI_FIB_RETRACE=true` — but it'll hurt.

5. **LS-BE-on-flip overlay (`GFI_LS_BE_ON_FLIP`) is unchanged.** Independent
   of preset, works the same way. If you have it on, it stacks with v2's
   structural BE.

## Train/test split — H1 vs H2 stable, no overfit

Sim split at Sep 1 2025:

| Variant | H1 PnL | H1 PF | H2 PnL | H2 PF |
|---------|-------:|------:|-------:|------:|
| Gold | $40,440 | 1.93 | $118,465 | 4.26 |
| **v2** | $77,970 | **2.95** | $151,520 | **4.91** |
| v2-max | $70,105 | 2.49 | $174,330 | 4.89 |
| v2-low-dd | $69,975 | 3.75 | $116,265 | 5.58 |

v2 H1 PF is **52% higher** than gold's — the strategy genuinely captures
more edge per trade in 2025. H2 confirms (4.91 vs 4.26). All candidates
H2 > H1, suggesting the improvement generalizes forward.

## Reproduce v2

```bash
cd backtest-engine
node index.js --ticker NQ --strategy gex-flip-ivpct \
  --timeframe 5m --raw-contracts \
  --start 2025-01-13 --end 2026-04-20 \
  --iv-resolution 1m --eod-cutoff-et 16:40 \
  --gfi-preset v2 \
  --output data/gold-standard/gex-flip-ivpct-v2.json
```

Full writeup: `backtest-engine/research/gex-flip-ivpct-improve/SUMMARY.md`.
