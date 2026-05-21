#!/bin/bash
# Phase 7b — Second batch with wider stops (peak in fine-grained sweep).
set -e
cd "$(dirname "$0")/../.."
mkdir -p research/ls-flip-improve/output/engine-runs

SKIP_NOASIA="5,16,17,18,19,20,21,22,23"

COMMON="--ticker NQ --strategy ls-flip-trigger-bar --timeframe 1m --raw-contracts \
  --start 2025-01-13 --end 2026-04-23 \
  --ls-1m-file research/lt-extraction/output/nq_ls_1m_raw.csv \
  --eod-cutoff-et 15:45"

run() {
  local LABEL=$1; shift
  local OUT="research/ls-flip-improve/output/engine-runs/${LABEL}.json"
  if [ -f "${OUT}" ]; then echo "skip ${LABEL} (exists)"; return; fi
  echo
  echo "=== ${LABEL} ==="
  echo "$@"
  node index.js ${COMMON} "$@" --output-json "${OUT}" 2>&1 | tail -50
}

# Candidate E — max PnL, wide stop (best in fine sweep)
run "candE_noAsia_minR3_t15_s12" \
  --lstb-blocked-hours "${SKIP_NOASIA}" \
  --lstb-min-range 3 \
  --lstb-target-pts 15 --lstb-stop-pts 12

# Candidate F — balanced with BE (top Sharpe-balanced in fine sweep)
run "candF_noAsia_minR3_t15_s12_be10off1" \
  --lstb-blocked-hours "${SKIP_NOASIA}" \
  --lstb-min-range 3 \
  --lstb-target-pts 15 --lstb-stop-pts 12 \
  --lstb-breakeven-stop --lstb-be-trigger 10 --lstb-be-offset 1

# Candidate G — wider target, very aggressive
run "candG_noAsia_minR3_t25_s12" \
  --lstb-blocked-hours "${SKIP_NOASIA}" \
  --lstb-min-range 3 \
  --lstb-target-pts 25 --lstb-stop-pts 12

# Candidate H — high-Sharpe tight scalp (top by Sharpe)
run "candH_noAsia_minR3_t10_s9_be6off1" \
  --lstb-blocked-hours "${SKIP_NOASIA}" \
  --lstb-min-range 3 \
  --lstb-target-pts 10 --lstb-stop-pts 9 \
  --lstb-breakeven-stop --lstb-be-trigger 6 --lstb-be-offset 1
