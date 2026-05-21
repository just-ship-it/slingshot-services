# Overnight Research Task — GEX_LT_3M_CROSSOVER Strategy Improvement

**Drop this entire file as the opening prompt in a fresh Claude Code session for the slingshot-services repo.** It contains everything needed to start; no context from prior sessions is required.

---

Overnight research task: **dramatically improve PnL of the GEX_LT_3M_CROSSOVER strategy gold standard.**

The strategy is one of three live production strategies. Current "W12+SCW-PM-block" gold (2026-05-18):

- **888 trades / $179,201 PnL / WR 47.6% / PF 1.44 / Sharpe 6.12 / MaxDD 8.26%** over Jan 2025 → Apr 2026 (~16 months).
- 4 active rules: `L_S4` (LONG @ S4 support TP=120/SL=50/mh=90), `S_GF_SOLO` (SHORT @ gamma_flip TP=60/SL=50/mh=90), `S_CW` (SHORT @ call_wall TP=120/SL=50/mh=90, **blocked 14:00-15:59 ET**), `S_R4` (SHORT @ R4 resistance TP=80/SL=50/mh=60). 7 other rules dropped for PF<1.0.
- Gold trades JSON: `backtest-engine/data/gold-standard/gex-lt-3m-crossover.json`.
- Gold backtest command and full v2 history are in `CLAUDE.md` under "Gold Standard Commands" → GEX-LT-3M-Crossover section.

**Goal**: dramatically improve PnL while keeping the **core entry logic unchanged** (the LT × GEX 3-minute crossover detector firing at the existing level set). Stops, targets, BE rules, trailing stops, hour filters, regime filters, per-rule parameters, additional rule activations/deactivations are all open for tuning.

## Methodology template (used successfully for the LS_FLIP_TRIGGER_BAR v3 work — +114% PnL achieved)

See `backtest-engine/research/ls-flip-improve/SUMMARY.md` and the scripts `01-walk-fill-instants.js` through `13-pick-best-and-save.js`. The general flow:

1. Walk each gold-standard trade's fill instant forward in 1s OHLCV recording per-bar `[t, hi, lo, c]` favorable-positive offsets.
2. Build a fast in-memory simulator that re-plays alternative exits on the walk data without re-streaming 1s.
3. Feature-bucket per-trade PnL to find filter levers (by-rule, by-hour, by-regime, by-level, by-day-of-week).
4. Cartesian-sweep exits and filters; pick Pareto-best candidates.
5. Validate top candidates in the actual engine (max 2 in parallel, see operational limits below).
6. Save the winner as new gold-standard JSON; document in SUMMARY.md.

**Do NOT just copy the LSTB scripts** — they're shaped around flip-bar events. Build glx-shaped equivalents (likely per-rule, since each rule has its own MFE/MAE profile and its own stops/targets in the current config).

## Mandatory constraints

- **1s OHLCV honesty**: any research producing WR/PF/DD numbers must walk 1s data from `fill_ts` forward — not 1m bars, not "retroactive 1s resolve from minute start." See CLAUDE.md "CRITICAL: Strategy research MUST use 1s OHLCV from the fill instant onward."
- **EOD cutoff 15:45 ET** for production parity (live force-flats at 15:45 via Sevalla env `EOD_CUTOFF_ET=15:45`).
- **Raw contracts with primary-contract filter** (`--raw-contracts`) — LT and GEX levels are in raw price space. See CLAUDE.md "CRITICAL: Price Space & Contract Rollover Rules."
- **Drew's preference is PF/Sharpe/DD over raw PnL** (see memory `feedback_pf_over_pnl`). When configs are close, prefer the better risk-adjusted one.
- **Time-in-trade is first-class risk** (see memory `feedback_time_as_risk`). Faster +X in 10min beats slower +2X in 6hr.

## Strategy plumbing — what you can change cheaply

- **Strategy file**: `shared/strategies/gex-lt-3m-crossover.js`.
- **Backtest CLI flags** (existing): `--glx-disable-rules`, `--glx-rule-overrides`, `--glx-force-any`, `--glx-entry-window`, `--glx-blocked-hours`.
- **Add new `--glx-*` flags as needed**. Follow the lstb pattern in `backtest-engine/src/cli.js`: any BE/trail wiring MUST go AFTER the engine-wide `--breakeven-stop` block (search the file for "ls-flip-trigger-bar BE/trail (post-engine-wide)") — the engine-wide block has `default: false` and otherwise clobbers your strategy-specific setter. Same trap exists for `gex-flip-ivpct`. See lstb memory entry for the full explanation.
- **Engine `targetDistance` / `stopDistance` re-anchoring** already exists in `trade-simulator.js` (added during LSTB work) and works for any strategy that emits those fields in the signal — use it if your new config uses fixed-point exits relative to entry.
- **Live signal-generator wiring**: `signal-generator/src/strategy/strategy-factory.js`'s `createGexLt3mCrossoverStrategy()`. Live env vars + the param getter in `signal-generator/src/utils/config.js` (current: `GLX_LS_BE_ON_FLIP`, `GLX_LS_BE_OFFSET`). Add new env vars / fields here for any live-relevant param. Recommended pattern from the LSTB work: implement a `--glx-preset` shortcut with named bundles (`v2`, `v3`, `v3-max`, `v3-balanced`, `v3-low-dd`) that load the full config at once; mirror the same presets in `getGexLt3mCrossoverParams()`.
- **Live deployment**: strategy is already enabled in prod (`enabled: true` in `signal-generator/strategy-config.json`). Tradovate OSO bracket placement via `tradovate-connector._placeBracket()` already handles `stopLoss`/`takeProfit`/`breakevenStop` fields generically — no connector changes needed unless you add a fundamentally new exit type.

## Operational limits

- **Max 2 backtests running in parallel** (memory `feedback_max_2_backtests_parallel.md` — kills the CPU otherwise). Check `ps -ef | grep "node index" | grep -v grep | wc -l` before launching. For sweeps, prefer one in-memory script over N parallel CLI runs.
- **1s OHLCV is 8GB** (`backtest-engine/data/ohlcv/nq/NQ_ohlcv_1s.csv`); stream it with readline + ISO timestamp lex-compare for date-range filtering. Do NOT load it.
- **Sevalla MCP** available for prod log inspection if needed (app IDs in `deploy.config.json` and CLAUDE.md).

## Output expected by morning

- New gold-standard JSONs in `data/gold-standard/gex-lt-3m-crossover-v3-{max,balanced,low-dd}.json` (or equivalent Pareto-best names — copy the LSTB convention).
- A `SUMMARY.md` in `backtest-engine/research/gex-lt-3m-improve/` — methodology, headline metrics, mechanism analysis, train/test split (H1 Jan-Aug 2025 vs H2 Sep 2025-Apr 2026) for stability.
- Strategy + CLI + `signal-generator/config.js` changes ready to commit. Implement a `--glx-preset` shortcut analogous to LSTB's `--lstb-preset`.
- Updated MEMORY.md entry marking the new gold standard and superseding the W12+SCW-PM-block reference. New per-topic memory file at `memory/gex-lt-3m-crossover-v3-improvements.md` (or similar) following the LSTB v3 entry's structure.
- A morning-check summary message with: headline result + Pareto alternates table + Sevalla deployment notes (which env vars need to be set, if any, vs which come "for free" from default preset).

## Approach guidance

- **Bias toward exploration breadth** — don't fixate on a single hypothesis. The LSTB winner came from compounding four levers (wider exits + BE + Asia-hour block + tiny-bar filter); glx may need different levers.
- **Per-rule analysis is likely the right unit** — each of the 4 active rules has its own characteristics. Examine MFE/MAE distributions per rule, per-rule giveback, per-rule WR by hour-of-day. Some rules may benefit from BE, others from wider targets, others from tighter stops.
- **Drew is asleep until morning** — don't ask clarifying questions; make reasonable judgment calls and document them in SUMMARY.md. Use AskUserQuestion only if genuinely blocked. Auto Mode is in effect.

Work autonomously through the night. Headline: improve $179k by as much as cleanly possible, prefer risk-adjusted lifts over absolute PnL, validate in the engine, save the artifacts, and write a clear morning summary.
