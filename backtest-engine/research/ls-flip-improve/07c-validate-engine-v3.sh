#!/bin/bash
# Phase 7c — Third batch.
# Runs after batches v1 (A-D) and v2 (E-H) complete.
#   - candI: noAsia+minR3, t=15 s=12, BE 8/+3 — top combined config (BE+wide-stop+filter)
#   - candJ: noAsia+minR3, t=15 s=12, BE 8/+2 — vary BE offset
#   - candK: noAsia+minR3, t=20 s=12, BE 10/+1 — combine wider target with BE
#   - candL: noAsia,        t=15 s=12, no BE   — verify minR3 effect
#   - candM: noAsia+minR3, orig stp=12 trail 12/5 — wider stop trail variant
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

# I — combined top config: noAsia+minR3, t=15 s=12, BE 8/+3
run "candI_noAsia_minR3_t15_s12_be8off3" \
  --lstb-blocked-hours "${SKIP_NOASIA}" \
  --lstb-min-range 3 \
  --lstb-target-pts 15 --lstb-stop-pts 12 \
  --lstb-breakeven-stop --lstb-be-trigger 8 --lstb-be-offset 3

# J — wider stops + BE 8/+2 (less aggressive lock)
run "candJ_noAsia_minR3_t15_s12_be8off2" \
  --lstb-blocked-hours "${SKIP_NOASIA}" \
  --lstb-min-range 3 \
  --lstb-target-pts 15 --lstb-stop-pts 12 \
  --lstb-breakeven-stop --lstb-be-trigger 8 --lstb-be-offset 2

# K — wider target combo
run "candK_noAsia_minR3_t20_s12_be10off1" \
  --lstb-blocked-hours "${SKIP_NOASIA}" \
  --lstb-min-range 3 \
  --lstb-target-pts 20 --lstb-stop-pts 12 \
  --lstb-breakeven-stop --lstb-be-trigger 10 --lstb-be-offset 1

# L — control: same as I without minR3 filter, to isolate filter contribution
run "candL_noAsia_t15_s12_be8off3" \
  --lstb-blocked-hours "${SKIP_NOASIA}" \
  --lstb-target-pts 15 --lstb-stop-pts 12 \
  --lstb-breakeven-stop --lstb-be-trigger 8 --lstb-be-offset 3

# M — wider stop trail variant (cand C with stop=12 instead of 8)
run "candM_noAsia_minR3_orig_stp12_tr12off5" \
  --lstb-blocked-hours "${SKIP_NOASIA}" \
  --lstb-min-range 3 \
  --lstb-stop-pts 12 \
  --lstb-trail-trigger 12 --lstb-trail-offset 5

# Re-run cand B with the BE fix to validate
run "candB2_noAsia_minR3_tgt15_stp8_be8off3_FIXED" \
  --lstb-blocked-hours "${SKIP_NOASIA}" \
  --lstb-min-range 3 \
  --lstb-target-pts 15 --lstb-stop-pts 8 \
  --lstb-breakeven-stop --lstb-be-trigger 8 --lstb-be-offset 3

# Max-PnL candidate from fine-grained sweep: t=25 s=12 (no BE)
run "candN_noAsia_minR3_t25_s12" \
  --lstb-blocked-hours "${SKIP_NOASIA}" \
  --lstb-min-range 3 \
  --lstb-target-pts 25 --lstb-stop-pts 12

# Maxer: t=25 s=12 with BE 12/+2 (preserve some downside protection)
run "candO_noAsia_minR3_t25_s12_be12off2" \
  --lstb-blocked-hours "${SKIP_NOASIA}" \
  --lstb-min-range 3 \
  --lstb-target-pts 25 --lstb-stop-pts 12 \
  --lstb-breakeven-stop --lstb-be-trigger 12 --lstb-be-offset 2
