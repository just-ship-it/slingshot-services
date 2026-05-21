#!/bin/bash
# Phase 7 — Engine validation runs for top candidates.
#
# Each run produces a trades JSON. Output dir: research/ls-flip-improve/output/engine-runs/

set -e
cd "$(dirname "$0")/../.."
mkdir -p research/ls-flip-improve/output/engine-runs

NO_ASIA="0,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23"
# Note: noAsia = block hours 16-23 + 5 (i.e. keep 0-4 + 6-15). The strategy
# uses blockedHoursEt as the SKIP list, so we list hours to skip.
# Hours to skip: 5, 16, 17, 18, 19, 20, 21, 22, 23  (skip all evening/Asia)
# Hours to keep: 0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15
SKIP_NOASIA="5,16,17,18,19,20,21,22,23"

COMMON="--ticker NQ --strategy ls-flip-trigger-bar --timeframe 1m --raw-contracts \
  --start 2025-01-13 --end 2026-04-23 \
  --ls-1m-file research/lt-extraction/output/nq_ls_1m_raw.csv \
  --eod-cutoff-et 15:45"

run() {
  local LABEL=$1; shift
  local OUT="research/ls-flip-improve/output/engine-runs/${LABEL}.json"
  echo
  echo "=== ${LABEL} ==="
  echo "$@"
  node index.js ${COMMON} "$@" --output-json "${OUT}" 2>&1 | tail -80

  echo "Wrote ${OUT}"
}

# Candidate A — max PnL simple
run "candA_noAsia_tgt15_stp8" \
  --lstb-blocked-hours "${SKIP_NOASIA}" \
  --lstb-target-pts 15 --lstb-stop-pts 8

# Candidate B — balanced (BE + range filter)
run "candB_noAsia_minR3_tgt15_stp8_be8off3" \
  --lstb-blocked-hours "${SKIP_NOASIA}" \
  --lstb-min-range 3 \
  --lstb-target-pts 15 --lstb-stop-pts 8 \
  --lstb-breakeven-stop --lstb-be-trigger 8 --lstb-be-offset 3

# Candidate C — high Sharpe (trail, keep orig target)
run "candC_noAsia_minR3_orig_stp8_tr12off5" \
  --lstb-blocked-hours "${SKIP_NOASIA}" \
  --lstb-min-range 3 \
  --lstb-stop-pts 8 \
  --lstb-trail-trigger 12 --lstb-trail-offset 5

# Candidate D — wide target
run "candD_noAsia_tgt30_origStop" \
  --lstb-blocked-hours "${SKIP_NOASIA}" \
  --lstb-target-pts 30
