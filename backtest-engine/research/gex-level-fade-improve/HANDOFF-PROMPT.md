# Overnight Research Task — GEX-LEVEL-FADE Strategy Improvement

**Drop this entire file as the opening prompt in a fresh Claude Code session for the slingshot-services repo.** It contains everything needed to start; no context from prior sessions is required.

---

Overnight research task: **dramatically improve PnL and risk-adjusted performance of the GEX-LEVEL-FADE (glf) strategy gold standard.**

The strategy is one of three live production strategies. Current honest gold standard (2026-05-15, post stop-misalignment-bug fix):

- **758 trades / $103,791 PnL / WR 22.16% / PF 1.45 / Sharpe 3.94 / MaxDD 7.04%** over Jan 2025 → Apr 2026 (~16 months, 1 contract, $311k on 3ct).
- Config: `--glf-entry-window 09:00-10:30 --glf-target-pts 100 --glf-stop-pts 18 --glf-max-hold 180 --glf-include-gex` (no maxpen filter).
- Gold trades JSON: `backtest-engine/data/gold-standard/gex-level-fade.json` (ALL-levels variant).
- Pareto alternative (low-DD): GEX-only mode `+ --glf-levels NONE` → 200 trades / WR 28% / PF 1.97 / Sharpe 3.26 / DD **3.92%** / $55.4k. JSON: `data/gold-standard/gex-level-fade-gexonly.json`.
- **Stop-misalignment bug history (2026-05-15)**: strategy used to set `stopLoss = signal_price ± stopPts` (signal price = level price, NOT actualEntry); favorable next-bar opens left stops on wrong side, immediately firing as stop_loss with POSITIVE PnL. Fixed by passing `stopDistance` so engine re-anchors. Pre-fix configs (0.5pt stop, 100/8, etc.) were phantom — all current gold numbers are honest post-fix.
- Full backtest command and history in `CLAUDE.md` under "Gold Standard Commands" (search for "level-fade" — note that section may not be present in CLAUDE.md; see `memory/level-reaction-research.md` for the canonical writeup).

**Key strategy characteristics:**

- **Tight 18pt stop, wide 100pt target** = ~5.5:1 R:R. Low WR (22%) but the wins are big.
- **9:00-10:30 ET entry window** — adding 10:30-12:00 drops PF 1.45 → 1.30, DD blows from 7% to 10.4%; full-day collapses to PF 1.02 / DD 48.9%.
- **Tight stops mean very high exposure to Drew's "MFE 60-80% of TP → bounce to SL" pattern.** This strategy is the BEST candidate for testing market-aware exits.
- **Multi-strategy work (2026-05-17)** found 25% of all trades instant-stop in <5min; 70% of those are from glf @ 09-10 ET. Best portfolio-level filter was "drop SHORT entries 10-11 ET" — but that's a portfolio-level call, not a per-strategy call.

**Goal**: dramatically improve PnL and risk-adjusted performance while keeping the **core entry logic unchanged** (level-fade detection at the existing entry conditions). Stops, targets, BE, trailing stops, hour filters, DOW filters, level-type filters, regime filters, market-aware exit overlays are all open for tuning.

## Methodology template

Two prior successful uses of this methodology — read them first:

* `backtest-engine/research/gex-lt-3m-improve/SUMMARY.md` — most recent. Per-rule sweeps; $179k → $218k (+22%), Sharpe +43%, DD -33%. Built the `--glx-preset` flag and `GLX_PRESET` env var pattern.
* `backtest-engine/research/ls-flip-improve/SUMMARY.md` — earlier. +114% PnL on LSTB by widening exits + adding BE + hour filter + min-range filter.
* `backtest-engine/research/market-aware-exits/SUMMARY.md` — extremely relevant here. Built a market-aware exit simulator with 3 mechanics (double-rejection, MFE-fraction-of-TP, velocity reversal). Found these DIDN'T help gex-lt-3m-crossover v3 because v3's per-rule BE already covers the pattern. **glf has no per-rule BE and tight stops — much more pattern exposure expected here.**

The general flow:

1. Walk each gold-standard trade's fill instant forward in 1s OHLCV recording per-bar `[t, hi, lo, c]` favorable-positive offsets.
2. Build an in-memory simulator that re-plays alternative exit policies on the walk data.
3. Feature-bucket per-trade PnL to find filter levers (by-hour, by-DOW, by-level-type, by-regime, by-DTE).
4. Cartesian-sweep exits and filters; pick Pareto-best candidates.
5. **Test market-aware exits aggressively** — reuse `research/market-aware-exits/02-sim-market-aware.js` simulator.
6. Validate top candidates in the actual engine (max 2 in parallel).
7. Save the winner as a new gold-standard JSON; document in SUMMARY.md.

**Do NOT just copy prior scripts** — glf is single-strategy (no per-rule slice). Use `02-sim-market-aware.js` as the base (it already supports baseline + DR + MFT + VR mechanics); adapt the policy struct to glf's single-policy shape.

## Mandatory constraints

- **1s OHLCV honesty**: any research producing WR/PF/DD numbers must walk 1s data from `fill_ts` forward. See CLAUDE.md "CRITICAL: Strategy research MUST use 1s OHLCV from the fill instant onward."
- **The stop-misalignment bug is FIXED in current strategy code, but** if any sweep variant produces PF/Sharpe materially above 1.45/3.94 you should suspect this bug or a related lookahead. Use the existing engine `stopDistance` re-anchoring (line ~453 in `trade-simulator.js`); any new exit logic that emits a stop should also emit `stopDistance` defensively.
- **EOD cutoff 16:40 ET** for backtest reproduction. Production live cutoff is 15:45 ET (memory `production-eod-cutoff.md`).
- **Raw contracts + primary-contract filter** (`--raw-contracts`) — GEX levels are in raw price space.
- **Drew's preference is PF/Sharpe/DD over raw PnL** (memory `feedback_pf_over_pnl`). 22% WR with PF 1.45 means most trades lose but big winners pay. Don't try to "improve WR" by cutting target — Drew's user-win philosophy: "small repeated wins fine, but don't sacrifice the fat tail."
- **Time-in-trade is first-class risk** (memory `feedback_time_as_risk`).

## Strategy plumbing — what you can change cheaply

- **Strategy file**: `shared/strategies/gex-level-fade.js`.
- **Backtest CLI flags** (existing — extensive):
  - Exits: `--glf-target-pts`, `--glf-stop-pts`, `--glf-max-hold`, `--glf-limit-timeout-bars`, `--glf-trailing-trigger`, `--glf-trailing-offset`, `--glf-breakeven-trigger`, `--glf-breakeven-offset`
  - Entry filters: `--glf-entry-window`, `--glf-no-entry-window`, `--glf-blocked-hours`, `--glf-blocked-regimes`, `--glf-direction` (long/short/fade), `--glf-min-ep`, `--glf-include-gex`, `--glf-no-include-gex-levels`, `--glf-gex-types`, `--glf-levels` (e.g. "S1,S2,R1" or "NONE" for GEX-only)
  - Quality filters: `--glf-max-last-pen`, `--glf-min-last-bars`, `--glf-min-rej-5m`, `--glf-min-rej-15m`, `--glf-rej-wick-pts`, `--glf-min-vol-bursts`, `--glf-vol-burst-mult`
- **CLI wiring note**: `--glf-trailing-trigger/offset` and `--glf-breakeven-trigger/offset` were fixed 2026-05-15 — confirmed wired. `--no-include-gex-levels` no longer clobbers `--glf-include-gex`.
- **Add a `--glf-preset` shortcut** (recommended — see lstb/glx/gfi patterns). Put the preset block FIRST in the glf cli section; individual flags override.
- **Engine `stopDistance` / `targetDistance` re-anchoring**: glf already emits `stopDistance` since the 2026-05-15 fix. Confirm any new exit logic preserves this.
- **Live signal-generator wiring**: `signal-generator/src/utils/config.js` already has `getGexLevelFadeParams()` with extensive env var support (GLF_TARGET_POINTS, GLF_STOP_POINTS, GLF_MAX_HOLD_BARS, GLF_LIMIT_TIMEOUT_BARS, GLF_MIN_EPISODE_NUM, GLF_INCLUDE_GEX, GLF_ENTRY_START/END_HOUR/MIN, GLF_BLOCKED_HOURS_ET, GLF_BLOCKED_REGIMES, GLF_COOLDOWN_MS, GLF_DIRECTION_MODE, plus quality filters and trailing/BE). Add `GLF_PRESET` env var to mirror the CLI preset.
- **Live overlay already in place**: `GLF_LS_BE_ON_FLIP` (LS-BE-on-flip overlay; default +10 offset). Make sure new presets compose cleanly — don't double-set BE in conflicting ways.
- **Live deployment status**: glf is enabled in production. Any preset changes ship LIVE immediately on next signal-generator restart unless gated behind a non-default env var. Default to current gold for safety in your preset bundle.

## Market-aware exits — primary lever to test

See `memory/market-aware-exits-idea.md` and `backtest-engine/research/market-aware-exits/SUMMARY.md`.

**glf is the BEST candidate** for market-aware exits in the portfolio because:
1. **Tight 18pt stop + 100pt target** → wide MFE band where price is "in the trade" but not protected. Trades reaching 50-80pt MFE (50-80% of TP) then reversing to -18pt SL is exactly Drew's failure pattern.
2. **No BE rule currently** (well, there's the LS-BE-on-flip overlay, but no structural BE). Adding even simple BE-at-MFE=50pt would protect the mid-MFE band.
3. **22% WR with PF 1.45** = lots of losing trades. Many of those losers probably have meaningful MFE that could be captured.

Specifically test (cheapest first):
1. **Baseline structural BE** — sweep `breakevenTrigger ∈ [20, 30, 40, 50, 60, 70, 80, 90]` × `breakevenOffset ∈ [0, 5, 10, 15, 20]`. The strategy has the wiring but no current BE config.
2. **Double-rejection of MFE extreme** — `02-sim-market-aware.js` mechanic (1). MFE peak + retrace + re-touch → close or tighten.
3. **MFE-as-fraction-of-TP scaling** — mechanic (2). When MFE ≥ X% of TP, lock Y% of MFE.
4. **Velocity reversal** — mechanic (3). MFE plateau + adverse-bar spike → close.
5. **Trail stop sweeps** — `trailingTrigger` × `trailingOffset` grids.

Expected: at least ONE of these mechanics should produce a meaningful lift here, because the structure of glf (tight stop, wide target, no BE) is exactly what these mechanics target.

## Per-trade feature analysis — likely high-value levers

Before sweeping exits, do feature analysis:

- **By hour** within 09:00-10:30 entry window (and check if extending to 10:30-11:00 or 11:00-12:00 helps with new exits).
- **By DOW** — check Drew's gex-lt-3m-improve playbook (Thu/Fri were losers for L_S4).
- **By level type**: S1/S2/S3/S4/S5 vs R1-R5 vs PutWall/CallWall/GammaFlip. Some level types likely have very different MFE/MAE distributions.
- **By regime** — `gexLevels.regime` is already in scope; the existing default blocks `strong_negative`. Verify and potentially extend.
- **By DTE / IV bucket** if available.
- **By approach/penetration depth** — the strategy fires after the level has been touched/penetrated; deeper penetration may correlate with weaker fade probability.

Use `gex-lt-3m-improve/04-per-rule-features.js` as a structural template (adapt to single-strategy slice).

## Operational limits

- **Max 2 backtests running in parallel** (memory `feedback_max_2_backtests_parallel.md`). Check `ps -ef | grep "node index" | grep -v grep | wc -l` before launching.
- **Engine validation runtime**: ~17 min per 16-month run; ~30 min when 2 are running in parallel.
- **1s OHLCV is 8GB**; stream it with readline + ISO timestamp lex-compare.
- **Sevalla MCP** available for prod log inspection (app IDs in `deploy.config.json` and CLAUDE.md).

## Output expected by morning

- New gold-standard JSONs in `data/gold-standard/gex-level-fade-v2-{recommended,max,low-dd}.json` (or equivalent Pareto-best names).
- A `SUMMARY.md` in `backtest-engine/research/gex-level-fade-improve/` — methodology, headline metrics, mechanism analysis (especially market-aware contribution), train/test split for stability.
- Strategy + CLI + `signal-generator/config.js` changes ready to commit. Implement a `--glf-preset` shortcut. Mirror the same presets in `getGexLevelFadeParams()` via a `GLF_PRESET` env var.
- Updated MEMORY.md entry marking the new gold standard. New per-topic memory file at `memory/gex-level-fade-v2-improvements.md`.
- A morning-check summary message with: headline result + Pareto alternates table + Sevalla deployment notes (env vars).

## Approach guidance

- **Drew's user-win philosophy**: "small repeated wins fine (5pts × 5 = 25pts)" but "don't sacrifice the fat-tail target." Keep the 100pt target as the default; only scrap it if the data clearly says a tighter target works AND the fat-tail capture isn't lost.
- **The stop curve is non-monotonic**: 8pt $58k, 10pt $68k but DD blows to 16%, 12pt $65k DD 17.5%, 15pt $79k Sh 2.64, 20pt $88k Sh 2.76 DD 9.7% (peak), 25pt $83k, 30pt $69k, 40pt $107k DD 22.9%. The current 18pt is a slightly-above-noise-zone choice; **20pt may be a better gold** but not validated. Test 18pt vs 20pt early.
- **Bias toward exploration breadth** — don't fixate on a single hypothesis.
- **Drew is asleep until morning** — don't ask clarifying questions; make reasonable judgment calls and document them in SUMMARY.md. Use AskUserQuestion only if genuinely blocked. Auto Mode is in effect.
- **Time is fluid; don't waste cycles polling**. Use `run_in_background` Bash with `until ! ps -p <pid> > /dev/null; do sleep 60; done` to wait for long backtests/sweeps.

Work autonomously through the night. Headline goal: meaningful improvement on $103k/PF 1.45/Sharpe 3.94/DD 7.04% — prioritize Sharpe and DD lift. Market-aware exits + structural BE are the highest-EV things to test. Validate top candidates in the engine, save the artifacts, write a clear morning summary.
