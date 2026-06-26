#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/../.."
OUT=research/ls-flip-metalabel/output/engine-runs
COMMON=(--ticker NQ --strategy ls-flip-trigger-bar --timeframe 1m --raw-contracts
  --start 2025-01-13 --end 2026-04-23
  --ls-1m-file research/lt-extraction/output/nq_ls_1m_raw.csv
  --lt-1m-file research/lt-extraction/output/nq_lt_1m_raw.csv
  --eod-cutoff-et 15:45 --lstb-preset v3)
run(){ local n="$1";shift;echo "=== $n :: $* ===";node --max-old-space-size=8192 index.js "${COMMON[@]}" "$@" --output-json "$OUT/$n.json" > "$OUT/$n.log" 2>&1;echo "  done $n";}
run flipAtLevel               --lstb-require-flip-at-level
run ltAlign_flipAtLevel       --lstb-require-lt-align --lstb-require-flip-at-level
run ltAlign_flipAtLevel_a075  --lstb-require-lt-align --lstb-require-flip-at-level --lstb-flip-at-level-atr 0.75
echo "FLIP-AT-LEVEL VARIANTS DONE"
