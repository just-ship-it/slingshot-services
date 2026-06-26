#!/usr/bin/env bash
# Causal FCFS engine runs for the ltAlign meta-label filter (needs strategy code,
# now wired via --lstb-require-lt-align) alone and combined with hour/range filters.
set -u
cd "$(dirname "$0")/../.."
OUT=research/ls-flip-metalabel/output/engine-runs
mkdir -p "$OUT"
COMMON=(--ticker NQ --strategy ls-flip-trigger-bar --timeframe 1m --raw-contracts
  --start 2025-01-13 --end 2026-04-23
  --ls-1m-file research/lt-extraction/output/nq_ls_1m_raw.csv
  --eod-cutoff-et 15:45 --lstb-preset v3)
run () { local name="$1"; shift; echo "=== $name :: $* ==="; \
  node --max-old-space-size=8192 index.js "${COMMON[@]}" "$@" --output-json "$OUT/$name.json" > "$OUT/$name.log" 2>&1; echo "    done $name"; }

run ltAlign                 --lstb-require-lt-align
run ltAlign_drop0to4        --lstb-require-lt-align --lstb-blocked-hours "0,1,2,3,4,5,16,17,18,19,20,21,22,23"
run ltAlign_minR5           --lstb-require-lt-align --lstb-min-range 5
run ltAlign_rth9to14        --lstb-require-lt-align --lstb-blocked-hours "0,1,2,3,4,5,6,7,8,15,16,17,18,19,20,21,22,23"
run ltAlign_drop0to4_minR5  --lstb-require-lt-align --lstb-blocked-hours "0,1,2,3,4,5,16,17,18,19,20,21,22,23" --lstb-min-range 5
run ltAlign_rth_minR5       --lstb-require-lt-align --lstb-blocked-hours "0,1,2,3,4,5,6,7,8,15,16,17,18,19,20,21,22,23" --lstb-min-range 5
echo "ALL LTALIGN VARIANTS DONE"
