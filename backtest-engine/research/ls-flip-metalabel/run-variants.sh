#!/usr/bin/env bash
# Causal FCFS engine runs for the meta-label filters expressible with existing params.
# Each is a full 16mo backtest; sequential. Headline ltAlign filter is tested separately
# (needs strategy code; see 05-* once wired).
set -u
cd "$(dirname "$0")/../.."
OUT=research/ls-flip-metalabel/output/engine-runs
mkdir -p "$OUT"
COMMON=(--ticker NQ --strategy ls-flip-trigger-bar --timeframe 1m --raw-contracts
  --start 2025-01-13 --end 2026-04-23
  --ls-1m-file research/lt-extraction/output/nq_ls_1m_raw.csv
  --eod-cutoff-et 15:45 --lstb-preset v3)

run () {
  local name="$1"; shift
  echo "=== $name :: $* ==="
  node --max-old-space-size=8192 index.js "${COMMON[@]}" "$@" \
    --output-json "$OUT/$name.json" > "$OUT/$name.log" 2>&1
  echo "    done $name"
}

# drop overnight 0-4 ET (on top of v3's already-blocked 5,16-23) -> only trades 6-15 ET
run drop0to4        --lstb-blocked-hours "0,1,2,3,4,5,16,17,18,19,20,21,22,23"
# tighter min trigger range
run minR5           --lstb-min-range 5
run minR8           --lstb-min-range 8
# combine hour + range
run drop0to4_minR5  --lstb-blocked-hours "0,1,2,3,4,5,16,17,18,19,20,21,22,23" --lstb-min-range 5
# RTH-concentrate: only 9-14 ET (block everything else)
run rthOnly_9to14   --lstb-blocked-hours "0,1,2,3,4,5,6,7,8,15,16,17,18,19,20,21,22,23"
# RTH + range
run rth_minR5       --lstb-blocked-hours "0,1,2,3,4,5,6,7,8,15,16,17,18,19,20,21,22,23" --lstb-min-range 5
# tighten big-body filter (cbAtr Q4/Q5 were worse)
run cbatr090        --lstb-cb-atr-max 0.90
run drop0to4_cbatr  --lstb-blocked-hours "0,1,2,3,4,5,16,17,18,19,20,21,22,23" --lstb-cb-atr-max 0.90
echo "ALL VARIANTS DONE"
