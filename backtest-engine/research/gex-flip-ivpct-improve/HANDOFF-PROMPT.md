# Overnight Research Task — GEX-FLIP-IVPCT Strategy Improvement

**Drop this entire file as the opening prompt in a fresh Claude Code session for the slingshot-services repo.** It contains everything needed to start; no context from prior sessions is required.

---

Overnight research task: **dramatically improve risk-adjusted performance of the GEX-FLIP-IVPCT (gfi) strategy gold standard.**

The strategy is one of three live production strategies. Current tight-stop gold standard (2026-05-12):

- **172 trades / $157,329 PnL / WR 61.6% / PF 2.99 / Sharpe 6.41 / MaxDD 11.3%** over Jan 2025 → Apr 2026 (~16 months).
- Single-strategy (not multi-rule). One global stop/target/BE setting applies to all signals.
- Tight-stop config: `--gfi-stop-pts 60 --gfi-target-pts 200 --gfi-breakeven-stop --gfi-breakeven-trigger 70 --gfi-breakeven-offset 5 --gfi-blocked-hours 6,7,8`
- Max single-trade loss capped at -$1,240; max giveback -$2,520; 10 painful losers.
- Gold trades JSON: `backtest-engine/data/gold-standard/gex-flip-ivpct-tight-s60t200be70.json`.
- Pareto alternatives:
  - **Zero-giveback**: `--gfi-stop-pts 60 --gfi-target-pts 150 --gfi-breakeven-trigger 50 --gfi-breakeven-offset 5 --gfi-blocked-hours 6,7,8` → 168 trades, $92k, PF 2.38, **0 painful**.
  - **Balanced**: `--gfi-stop-pts 60 --gfi-target-pts 180 --gfi-breakeven-trigger 60 --gfi-breakeven-offset 5 --gfi-blocked-hours 6,7,8` → 161 trades, $115k, PF 2.64, 4 painful.
- Pre-refit wide-stop baseline (do NOT pursue): 143 trades, $275k PnL, PF 4.29, Sharpe 10.60, DD 4.16% — but max single loss $3,720 and 15 painful givebacks. Untradable on small accounts.
- Gold backtest command and full history in `CLAUDE.md` under "Gold Standard Commands" → GEX-FLIP-IVPCT section.

**Goal**: improve **risk-adjusted** performance (PF, Sharpe, DD) over the tight-stop gold while keeping the **core entry logic unchanged** (the gex flip + iv pct detector at its existing thresholds). Stops, targets, BE, trailing stops, fib-retrace exit, magnet ratchet, hour filters, DOW filters, regime filters are all open for tuning. **Do not pursue raw PnL at the cost of wider single-trade losses** — Drew explicitly chose the tight-stop refit over the wide-stop $275k baseline for that reason. The $1,240 single-trade loss cap is a hard constraint.

## Methodology template

Two prior successful uses of this methodology — read them first:
* `backtest-engine/research/gex-lt-3m-improve/SUMMARY.md` — most recent, closest fit (per-rule sweeps; rule-shaped trade set). Net result: $179k → $218k (+22%), Sharpe +43%, DD -33%. Built the `--glx-preset` flag and `GLX_PRESET` env var pattern.
* `backtest-engine/research/ls-flip-improve/SUMMARY.md` — earlier, similar shape. +114% PnL on LSTB by widening exits + adding BE + hour filter + min-range filter.

The general flow:

1. Walk each gold-standard trade's fill instant forward in 1s OHLCV recording per-bar `[t, hi, lo, c]` favorable-positive offsets.
2. Build an in-memory simulator that re-plays alternative exit policies on the walk data without re-streaming 1s.
3. Feature-bucket per-trade PnL to find filter levers (by-hour, by-DOW, by-regime, by-IV-bucket, by-level type).
4. Cartesian-sweep exits and filters; pick Pareto-best candidates.
5. Validate top candidates in the actual engine (max 2 in parallel, see operational limits).
6. Save the winner as a new gold-standard JSON; document in SUMMARY.md.

**Do NOT just copy prior scripts** — they're shaped around per-rule strategies. gfi is single-strategy. Build gfi-shaped equivalents: simpler in some ways (no per-rule × hour matrix) but with more exit-mechanic combinations (this strategy already has BE, magnet ratchet, fib retrace).

## Mandatory constraints

- **1s OHLCV honesty**: any research producing WR/PF/DD numbers must walk 1s data from `fill_ts` forward — not 1m bars, not "retroactive 1s resolve from minute start." See CLAUDE.md "CRITICAL: Strategy research MUST use 1s OHLCV from the fill instant onward."
- **5m timeframe + 1m IV resolution** (`--timeframe 5m --iv-resolution 1m`) — REQUIRED for parity. 15m IV causes L1↔L4 / S1↔S2 rule swaps. `--timeframe 1m` puts evaluations on a different bar grid and only ~1/142 trades line up exactly.
- **EOD cutoff 16:40 ET** for backtest reproduction. Production live cutoff is 15:45 ET (see memory `production-eod-cutoff.md`) — note this means live PnL will be slightly below backtest.
- **Raw contracts with primary-contract filter** (`--raw-contracts`) — GEX levels are in raw price space. See CLAUDE.md "CRITICAL: Price Space & Contract Rollover Rules."
- **Drew's preference is PF/Sharpe/DD over raw PnL** (see memory `feedback_pf_over_pnl`). The whole point of the tight-stop refit was sacrificing PnL for risk-adjusted improvement. Don't backslide.
- **Max single-trade loss must stay ≤ $1,240** (= 60pt stop + slip × $20). Any variant that widens stops violates Drew's small-account hard constraint.
- **Time-in-trade is first-class risk** (memory `feedback_time_as_risk`). Faster +X in 10min beats slower +2X in 6hr.
- **Lookahead-bias correction history**: gfi has had multiple lookahead-bias fixes through 2026-05-06 (GEX cbbo bucketing, IV CSV regen, etc.). The current tight-stop gold is post-fix. Suspect this bug FIRST if any sweep variant produces PF/Sharpe materially above 6.41/3.0. See CLAUDE.md.

## Strategy plumbing — what you can change cheaply

- **Strategy file**: `shared/strategies/gex-flip-ivpct.js`.
- **Backtest CLI flags** (existing):
  - Exits: `--gfi-stop-pts`, `--gfi-target-pts`, `--gfi-breakeven-stop`, `--gfi-breakeven-trigger`, `--gfi-breakeven-offset`, `--gfi-trailing-trigger`, `--gfi-trailing-offset`
  - Filters: `--gfi-blocked-hours`
  - Magnet ratchet: `--gfi-magnet-ratchet`, `--gfi-magnet-lock-pct`, `--gfi-magnet-recency-hours`, `--gfi-magnet-fixed-per-tier`, `--gfi-magnet-fallback-tiers`
  - Fib retrace: `--gfi-fib-retrace`, `--gfi-fib-retrace-pct`, `--gfi-fib-activation-mfe`, `--gfi-fib-conditional`, `--gfi-fib-conditional-mode`
- **CLI wiring gotcha (memorize)**: `--gfi-breakeven-stop` MUST be applied AFTER the engine-wide `--breakeven-stop` block in `cli.js` because that block has `default: false` and would otherwise clobber the strategy-specific setter. Same trap as lstb. See lines around 2089-2096 in `cli.js` for the existing fix.
- **Add new `--gfi-*` flags as needed**. If you introduce a `--gfi-preset` shortcut (recommended — see lstb / glx patterns), put it FIRST in the gfi block so individual flags can still override. Engine `stopDistance`/`targetDistance` re-anchoring already exists in `trade-simulator.js` if your config emits those fields.
- **Live signal-generator wiring**: `signal-generator/src/utils/config.js` already exposes `GFI_STOP_POINTS`, `GFI_TARGET_POINTS`, `GFI_BREAKEVEN_STOP`, `GFI_BREAKEVEN_TRIGGER`, `GFI_BREAKEVEN_OFFSET`, `GFI_BLOCKED_HOURS_ET`. Add new env vars there for any live-relevant param. Recommended pattern from lstb/glx: implement a `GFI_PRESET` env var with named bundles. Default current gold for safety; flip to new gold once validated.
- **Live deployment status**: gfi is enabled in production (`enabled: true` in `signal-generator/strategy-config.json`). Any preset changes ship LIVE immediately on next signal-generator restart unless gated behind a non-default env var. Be conservative — keep the existing tight-stop as the default in your preset bundle; new gold as opt-in OR new default with clear documentation.
- **Live overlay already in place**: `GFI_LS_BE_ON_FLIP` (LS-BE-on-flip overlay from research/ls-overlay). Make sure new presets compose cleanly with this — don't double-set BE in conflicting ways.

## Market-aware exits — likely worth testing here

See `memory/market-aware-exits-idea.md` and `backtest-engine/research/market-aware-exits/SUMMARY.md`. The market-aware exit research (2026-05-21) tested 3 mechanics on gex-lt-3m-crossover v3 and found none improved it because v3's per-rule BE already covers the failure pattern. **gfi is a different story** — its existing fib-retrace exit already implements a related idea, and the strategy has only ONE BE rule (not per-rule), so trades at certain MFE bands may not be protected.

Specifically test:
1. **Double-rejection of MFE extreme** — track running MFE peak, count touches within Npt, exit/tighten on 2nd rejection.
2. **MFE-as-fraction-of-TP scaling** — when MFE ≥ X% of TP, lock Y% of MFE. Self-adjusts to target=150/180/200 variants.
3. **Velocity reversal at MFE peak** — MFE plateau + adverse-bar spike → close. Price-proxy version (no volume).
4. **Fib retrace re-tuning** — current fib-retrace is tuned for the wide-stop variant; the tight-stop gold's params may be suboptimal. Sweep `fibRetracePct ∈ [0.5, 0.618, 0.7]` × `fibActivationMFE ∈ [30, 45, 60, 80, 100]`.

The research/market-aware-exits/02-sim-market-aware.js simulator can be adapted directly — it already has DR / MFT / VR mechanics implemented.

## Operational limits

- **Max 2 backtests running in parallel** (memory `feedback_max_2_backtests_parallel.md` — kills the CPU otherwise). Check `ps -ef | grep "node index" | grep -v grep | wc -l` before launching. For sweeps, prefer one in-memory script over N parallel CLI runs.
- **Engine validation runtime**: ~17 min per 16-month run; ~30 min when 2 are running in parallel (CPU contention).
- **1s OHLCV is 8GB** (`backtest-engine/data/ohlcv/nq/NQ_ohlcv_1s.csv`); stream it with readline + ISO timestamp lex-compare. Do NOT load it.
- **Sevalla MCP** available for prod log inspection if needed (app IDs in `deploy.config.json` and CLAUDE.md).

## Output expected by morning

- New gold-standard JSONs in `data/gold-standard/gex-flip-ivpct-v2-{recommended,low-dd,balanced}.json` (or equivalent Pareto-best names — copy the lstb / glx conventions).
- A `SUMMARY.md` in `backtest-engine/research/gex-flip-ivpct-improve/` — methodology, headline metrics, mechanism analysis, train/test split (H1 Jan-Aug 2025 vs H2 Sep 2025-Apr 2026) for stability.
- Strategy + CLI + `signal-generator/config.js` changes ready to commit. Implement a `--gfi-preset` shortcut analogous to lstb's `--lstb-preset` and glx's `--glx-preset`. Mirror the same presets in `getGexFlipIvpctParams()` via a `GFI_PRESET` env var.
- Updated MEMORY.md entry marking the new gold standard and superseding the tight-stop refit reference. New per-topic memory file at `memory/gex-flip-ivpct-v2-improvements.md` following the lstb/glx v3 entry structure.
- A morning-check summary message with: headline result + Pareto alternates table + Sevalla deployment notes (which env vars need to be set, if any, vs which come "for free" from default preset).

## Approach guidance

- **Drew prefers risk-adjusted lifts over absolute PnL.** Read this carefully and don't backslide into wider stops. The whole point of the tight-stop refit was to cap losses.
- **Bias toward exploration breadth** — don't fixate on a single hypothesis. The lstb winner came from compounding four levers; glx from per-rule wider exits + filters. gfi may need different levers (fib retrace re-tune + market-aware + magnet ratchet + targeted filters).
- **Single-strategy analysis is simpler than per-rule but has fewer levers** — once stop=60 is locked in, the playing field is target × BE × trail × fib × filters. Most of the lift will come from combinations of these.
- **Examine MFE/MAE distributions carefully**. The wide-stop $275k baseline's strength came from giving big MFE moves room to run. The tight-stop refit's weakness is that some 200pt-target trades have MFE 80-150pt and then reverse. Look for an exit policy that protects those mid-MFE trades without sacrificing the runners.
- **Drew is asleep until morning** — don't ask clarifying questions; make reasonable judgment calls and document them in SUMMARY.md. Use AskUserQuestion only if genuinely blocked. Auto Mode is in effect.
- **Time is fluid; don't waste cycles polling**. Use `run_in_background` Bash with `until ! ps -p <pid> > /dev/null; do sleep 60; done` to wait for long backtests/sweeps.

Work autonomously through the night. Headline: improve risk-adjusted performance over $157k/PF 2.99/Sharpe 6.41/DD 11.3% while keeping max single-trade loss ≤ $1,240. Prefer Sharpe and DD improvements over absolute PnL. Validate top candidates in the engine, save the artifacts, write a clear morning summary.
