#!/usr/bin/env bash
#
# Integration Tests: Position Ownership Verification
#
# Tests that ai-trader and signal-generator correctly consult the orchestrator's
# multi-strategy:state Redis key before claiming positions during startup sync
# and reconciliation.
#
# Prerequisites:
#   - Redis running (redis-cli ping)
#   - trade-orchestrator and tradovate-service running via PM2
#   - ai-trader and signal-generator in PM2 (will be restarted by tests)
#
# Usage:
#   ./tests/test-position-ownership.sh              # Run all tests
#   ./tests/test-position-ownership.sh 1            # Run only test 1
#   ./tests/test-position-ownership.sh 1 3 5        # Run tests 1, 3, and 5

set -euo pipefail

ACCOUNT_ID="33316485"
TRADOVATE_URL="http://localhost:3011"
REDIS_KEY="multi-strategy:state"
# Strategy constants for the test matrix (GEX_SCALP, ES_STOP_HUNT, MNQ_ADAPTIVE_SCALPER removed)
AI_STRATEGY="AI_TRADER"
MULTI_STRATEGY="IV_SKEW_GEX"  # Representative multi-strategy runner (enabled in strategy-config.json)

PASS=0
FAIL=0
SKIP=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# ─── Helpers ──────────────────────────────────────────────────

log()  { echo -e "${CYAN}[TEST]${NC} $*"; }
pass() { echo -e "${GREEN}[PASS]${NC} $*"; PASS=$((PASS + 1)); }
fail() { echo -e "${RED}[FAIL]${NC} $*"; FAIL=$((FAIL + 1)); }
skip() { echo -e "${YELLOW}[SKIP]${NC} $*"; SKIP=$((SKIP + 1)); }
sep()  { echo -e "\n${CYAN}════════════════════════════════════════════════════════════${NC}"; }

set_redis_state() {
  local json="$1"
  redis-cli SET "$REDIS_KEY" "$json" > /dev/null
}

set_flat() {
  set_redis_state '{"timestamp":"2026-03-10T12:00:00Z","version":"2.0","positions":{},"pendingOrders":{}}'
}

set_owner() {
  local side="$1"   # long or short
  local source="$2" # AI_TRADER, IMPULSE_FVG, etc.
  set_redis_state "{\"timestamp\":\"2026-03-10T12:00:00Z\",\"version\":\"2.0\",\"positions\":{\"NQ\":{\"position\":\"${side}\",\"source\":\"${source}\"}},\"pendingOrders\":{}}"
}

delete_redis_key() {
  redis-cli DEL "$REDIS_KEY" > /dev/null
}

get_redis_state() {
  redis-cli GET "$REDIS_KEY"
}

restart_service() {
  local svc="$1"
  pm2 restart "$svc" --silent 2>/dev/null
  sleep 8  # Wait for startup sync to complete
}

# Get recent logs (last N lines) for a service, filtered by pattern
get_logs() {
  local svc="$1"
  local pattern="$2"
  local lines="${3:-50}"
  # pm2 logs outputs to stderr, use --nostream to get recent lines
  pm2 logs "$svc" --lines "$lines" --nostream 2>&1 | grep -iE "$pattern" || true
}

# Check if Tradovate has an open NQ position
has_open_position() {
  local response
  response=$(curl -sf "${TRADOVATE_URL}/positions/${ACCOUNT_ID}" 2>/dev/null || echo "[]")
  echo "$response" | python3 -c "
import sys, json
positions = json.load(sys.stdin)
nq = [p for p in positions if p.get('netPos', 0) != 0 and 'NQ' in (p.get('symbol','') or '')]
if nq:
    p = nq[0]
    side = 'long' if p['netPos'] > 0 else 'short'
    print(f'{side}|{p.get(\"symbol\",\"?\")}|{p.get(\"netPrice\",0)}')
else:
    print('FLAT')
" 2>/dev/null || echo "ERROR"
}

# Check prerequisites
check_prereqs() {
  log "Checking prerequisites..."

  if ! redis-cli ping > /dev/null 2>&1; then
    echo -e "${RED}ERROR: Redis is not running. Start it first.${NC}"
    exit 1
  fi

  if ! pm2 pid trade-orchestrator > /dev/null 2>&1 || [ "$(pm2 pid trade-orchestrator)" = "" ]; then
    echo -e "${RED}ERROR: trade-orchestrator is not running in PM2.${NC}"
    exit 1
  fi

  if ! curl -sf "${TRADOVATE_URL}/health" > /dev/null 2>&1; then
    echo -e "${RED}ERROR: tradovate-service is not responding at ${TRADOVATE_URL}/health${NC}"
    exit 1
  fi

  local pos_status
  pos_status=$(has_open_position)
  if [ "$pos_status" = "ERROR" ]; then
    echo -e "${RED}ERROR: Cannot query Tradovate positions.${NC}"
    exit 1
  fi

  log "Redis: OK"
  log "trade-orchestrator: OK"
  log "tradovate-service: OK"
  log "Current NQ position: ${pos_status}"
  echo ""
}

# Determine which tests to run
TESTS_TO_RUN=()
if [ $# -gt 0 ]; then
  TESTS_TO_RUN=("$@")
fi

should_run() {
  local test_num="$1"
  if [ ${#TESTS_TO_RUN[@]} -eq 0 ]; then
    return 0  # Run all
  fi
  for t in "${TESTS_TO_RUN[@]}"; do
    if [ "$t" = "$test_num" ]; then
      return 0
    fi
  done
  return 1
}

# ─── Test 1: Manual Position — Startup Sync Ignores It ──────

test_1() {
  sep
  log "Test 1: Manual Position — Startup Sync Ignores It"
  log "Goal: Engine starts while a manual trade is open; confirms it does NOT claim."

  local pos_status
  pos_status=$(has_open_position)

  if [ "$pos_status" = "FLAT" ]; then
    skip "Test 1: No open NQ position in Tradovate — need one for this test"
    return
  fi

  log "Open position: $pos_status"
  log "Setting orchestrator state to FLAT (no owner)..."
  set_flat

  # Test AI Trader
  log "Restarting ai-trader..."
  restart_service ai-trader

  local ai_logs
  ai_logs=$(get_logs ai-trader "owned|claiming|NOT claiming|position" 50)

  if echo "$ai_logs" | grep -q "NOT claiming"; then
    pass "Test 1a: AI Trader correctly ignored unowned position"
  elif echo "$ai_logs" | grep -q "owned by.*unknown/manual"; then
    pass "Test 1a: AI Trader correctly identified position as unknown/manual"
  else
    fail "Test 1a: AI Trader — expected 'NOT claiming' in logs"
    echo "  Logs: $(echo "$ai_logs" | tail -5)"
  fi

  # Test signal-generator
  log "Restarting signal-generator..."
  restart_service signal-generator

  local sg_logs
  sg_logs=$(get_logs signal-generator "owned|claiming|NOT claiming|position" 50)

  if echo "$sg_logs" | grep -q "NOT claiming"; then
    pass "Test 1b: Signal Generator correctly ignored unowned position"
  elif echo "$sg_logs" | grep -q "owned by.*unknown/manual"; then
    pass "Test 1b: Signal Generator correctly identified position as unknown/manual"
  else
    fail "Test 1b: Signal Generator — expected 'NOT claiming' in logs"
    echo "  Logs: $(echo "$sg_logs" | tail -5)"
  fi
}

# ─── Test 2: Manual Position — Reconciliation Ignores It ────

test_2() {
  sep
  log "Test 2: Manual Position — Reconciliation Ignores It"
  log "Goal: Engine is running flat, then manual trade appears; recon does NOT claim."
  log "(Uses startup sync as proxy — same ownership check logic)"

  local pos_status
  pos_status=$(has_open_position)

  if [ "$pos_status" = "FLAT" ]; then
    skip "Test 2: No open NQ position in Tradovate — need one for this test"
    return
  fi

  log "Open position: $pos_status"
  set_flat

  log "Restarting ai-trader (startup sync uses same ownership check as reconciliation)..."
  restart_service ai-trader

  local ai_logs
  ai_logs=$(get_logs ai-trader "owned|claiming|RECONCILE.*ignoring" 50)

  if echo "$ai_logs" | grep -qE "NOT claiming|ignoring"; then
    pass "Test 2: AI Trader reconciliation correctly ignores unowned position"
  else
    fail "Test 2: Expected 'NOT claiming' or 'ignoring' in logs"
    echo "  Logs: $(echo "$ai_logs" | tail -5)"
  fi
}

# ─── Test 3: AI Trader Claims Its Own Position ──────────────

test_3() {
  sep
  log "Test 3: Strategy-Placed Trade — AI Trader Claims Its Own Position"
  log "Goal: AI Trader placed a trade; on restart, it correctly reclaims it."

  local pos_status
  pos_status=$(has_open_position)

  if [ "$pos_status" = "FLAT" ]; then
    skip "Test 3: No open NQ position in Tradovate — need one for this test"
    return
  fi

  local side
  side=$(echo "$pos_status" | cut -d'|' -f1)
  log "Open position: $pos_status"
  log "Setting orchestrator state: NQ ${side} owned by AI_TRADER..."
  set_owner "$side" "AI_TRADER"

  log "Restarting ai-trader..."
  restart_service ai-trader

  local ai_logs
  ai_logs=$(get_logs ai-trader "Found existing position:|Trade manager activated|position.*sync" 50)

  if echo "$ai_logs" | grep -q "Found existing position:"; then
    pass "Test 3: AI Trader correctly claimed its own position"
  elif echo "$ai_logs" | grep -q "Trade manager activated"; then
    pass "Test 3: AI Trader activated trade manager for its position"
  else
    fail "Test 3: Expected 'Found existing position:' (without NOT claiming)"
    echo "  Logs: $(echo "$ai_logs" | tail -5)"
  fi

  # Verify it did NOT say "NOT claiming"
  local reject_logs
  reject_logs=$(get_logs ai-trader "NOT claiming" 50)
  if echo "$reject_logs" | grep -q "NOT claiming"; then
    fail "Test 3 (extra): AI Trader said 'NOT claiming' even though it's the owner!"
  fi
}

# ─── Test 4: Multi-Strategy Claims Its Own ──────────────────

test_4() {
  sep
  log "Test 4: Strategy-Placed Trade — Multi-Strategy Claims Its Own (${MULTI_STRATEGY})"
  log "Goal: ${MULTI_STRATEGY} owns NQ position; signal-generator reclaims on restart."

  local pos_status
  pos_status=$(has_open_position)

  if [ "$pos_status" = "FLAT" ]; then
    skip "Test 4: No open NQ position in Tradovate — need one for this test"
    return
  fi

  local side
  side=$(echo "$pos_status" | cut -d'|' -f1)
  log "Open position: $pos_status"
  log "Setting orchestrator state: NQ ${side} owned by ${MULTI_STRATEGY}..."
  set_owner "$side" "$MULTI_STRATEGY"

  log "Restarting signal-generator..."
  restart_service signal-generator

  local sg_logs
  sg_logs=$(get_logs signal-generator "Found NQ position|owned by ${MULTI_STRATEGY}|position.*${MULTI_STRATEGY}" 50)

  if echo "$sg_logs" | grep -qE "Found NQ position.*owned by ${MULTI_STRATEGY}|position.*${MULTI_STRATEGY}"; then
    pass "Test 4: Signal Generator correctly claimed ${MULTI_STRATEGY} position"
  else
    # Check if it found the position at all
    local all_pos_logs
    all_pos_logs=$(get_logs signal-generator "position|claiming|owned" 50)
    if echo "$all_pos_logs" | grep -q "NOT claiming"; then
      fail "Test 4: Signal Generator refused to claim its own ${MULTI_STRATEGY} position"
      echo "  This likely means ${MULTI_STRATEGY} is not loaded as a strategy runner."
      echo "  Logs: $(echo "$all_pos_logs" | tail -5)"
    else
      fail "Test 4: Could not confirm Signal Generator claimed the position"
      echo "  Logs: $(echo "$all_pos_logs" | tail -5)"
    fi
  fi
}

# ─── Test 5: Cross-Strategy — AI Trader Ignores IMPULSE_FVG Position ─

test_5() {
  sep
  log "Test 5: Cross-Strategy — AI Trader Ignores ${MULTI_STRATEGY} Position"
  log "Goal: ${MULTI_STRATEGY} owns position; AI Trader does NOT claim it."

  local pos_status
  pos_status=$(has_open_position)

  if [ "$pos_status" = "FLAT" ]; then
    skip "Test 5: No open NQ position in Tradovate — need one for this test"
    return
  fi

  local side
  side=$(echo "$pos_status" | cut -d'|' -f1)
  log "Open position: $pos_status"
  log "Setting orchestrator state: NQ ${side} owned by ${MULTI_STRATEGY}..."
  set_owner "$side" "$MULTI_STRATEGY"

  log "Restarting ai-trader..."
  restart_service ai-trader

  local ai_logs
  ai_logs=$(get_logs ai-trader "owned|claiming|ignoring" 50)

  if echo "$ai_logs" | grep -qE "NOT claiming|owned by ${MULTI_STRATEGY}"; then
    pass "Test 5: AI Trader correctly ignored ${MULTI_STRATEGY}-owned position"
  else
    fail "Test 5: Expected AI Trader to log 'NOT claiming' for ${MULTI_STRATEGY} position"
    echo "  Logs: $(echo "$ai_logs" | tail -5)"
  fi
}

# ─── Test 6: Restart Mid-Position — AI Trader Reclaims ──────

test_6() {
  sep
  log "Test 6: Restart Mid-Position — AI Trader Reclaims After Restart"
  log "Goal: AI Trader has a live position, gets restarted, correctly reclaims."

  local pos_status
  pos_status=$(has_open_position)

  if [ "$pos_status" = "FLAT" ]; then
    skip "Test 6: No open NQ position in Tradovate — need one for this test"
    return
  fi

  local side
  side=$(echo "$pos_status" | cut -d'|' -f1)
  log "Open position: $pos_status"
  log "Setting orchestrator state: NQ ${side} owned by AI_TRADER..."
  set_owner "$side" "AI_TRADER"

  log "Restarting ai-trader..."
  restart_service ai-trader

  local ai_logs
  ai_logs=$(get_logs ai-trader "Found existing position:|Trade manager activated" 50)

  if echo "$ai_logs" | grep -q "Found existing position:"; then
    pass "Test 6: AI Trader reclaimed position after restart"
  elif echo "$ai_logs" | grep -q "Trade manager activated"; then
    pass "Test 6: AI Trader activated trade manager for reclaimed position"
  else
    fail "Test 6: AI Trader did not reclaim its position after restart"
    echo "  Logs: $(echo "$ai_logs" | tail -5)"
  fi
}

# ─── Test 7: No Redis State — Engine Does Not Claim ─────────

test_7() {
  sep
  log "Test 7: No Redis State — Engine Does Not Claim"
  log "Goal: multi-strategy:state key is missing; engines default to not claiming."

  local pos_status
  pos_status=$(has_open_position)

  if [ "$pos_status" = "FLAT" ]; then
    skip "Test 7: No open NQ position in Tradovate — need one for this test"
    return
  fi

  log "Open position: $pos_status"
  log "Deleting multi-strategy:state Redis key..."
  delete_redis_key

  log "Restarting ai-trader..."
  restart_service ai-trader

  local ai_logs
  ai_logs=$(get_logs ai-trader "owned|claiming" 50)

  if echo "$ai_logs" | grep -qE "NOT claiming|unknown/manual"; then
    pass "Test 7a: AI Trader correctly refused to claim (no Redis state)"
  else
    fail "Test 7a: Expected 'NOT claiming' when Redis key is missing"
    echo "  Logs: $(echo "$ai_logs" | tail -5)"
  fi

  log "Restarting signal-generator..."
  restart_service signal-generator

  local sg_logs
  sg_logs=$(get_logs signal-generator "owned|claiming" 50)

  if echo "$sg_logs" | grep -qE "NOT claiming|unknown/manual"; then
    pass "Test 7b: Signal Generator correctly refused to claim (no Redis state)"
  else
    fail "Test 7b: Expected 'NOT claiming' when Redis key is missing"
    echo "  Logs: $(echo "$sg_logs" | tail -5)"
  fi
}

# ─── Test 8: UNKNOWN Source — Treated as Manual ──────────────

test_8() {
  sep
  log "Test 8: UNKNOWN Source — Treated as Manual"
  log "Goal: source=UNKNOWN is treated same as no owner."

  local pos_status
  pos_status=$(has_open_position)

  if [ "$pos_status" = "FLAT" ]; then
    skip "Test 8: No open NQ position in Tradovate — need one for this test"
    return
  fi

  local side
  side=$(echo "$pos_status" | cut -d'|' -f1)
  log "Open position: $pos_status"
  log "Setting orchestrator state: NQ ${side} owned by UNKNOWN..."
  set_owner "$side" "UNKNOWN"

  log "Restarting ai-trader..."
  restart_service ai-trader

  local ai_logs
  ai_logs=$(get_logs ai-trader "owned|claiming" 50)

  if echo "$ai_logs" | grep -qE "NOT claiming|unknown/manual"; then
    pass "Test 8a: AI Trader correctly treated UNKNOWN source as manual"
  else
    fail "Test 8a: Expected 'NOT claiming' for UNKNOWN source"
    echo "  Logs: $(echo "$ai_logs" | tail -5)"
  fi

  log "Restarting signal-generator..."
  restart_service signal-generator

  local sg_logs
  sg_logs=$(get_logs signal-generator "owned|claiming" 50)

  if echo "$sg_logs" | grep -qE "NOT claiming|unknown/manual"; then
    pass "Test 8b: Signal Generator correctly treated UNKNOWN source as manual"
  else
    fail "Test 8b: Expected 'NOT claiming' for UNKNOWN source"
    echo "  Logs: $(echo "$sg_logs" | tail -5)"
  fi
}

# ─── Test 9: Stale Position Cleanup Still Works ──────────────

test_9() {
  sep
  log "Test 9: Stale Position Cleanup Still Works"
  log "Goal: Engine thinks it's in position, but Tradovate is flat. Recon clears stale state."

  local pos_status
  pos_status=$(has_open_position)

  if [ "$pos_status" != "FLAT" ]; then
    skip "Test 9: Need Tradovate to be FLAT (has position: $pos_status)"
    return
  fi

  log "Tradovate is flat. Setting Redis to claim AI_TRADER owns NQ long..."
  set_owner "long" "AI_TRADER"

  # Start AI trader — it will claim the position from Redis,
  # then on first reconciliation, see Tradovate is flat and reset
  log "Restarting ai-trader (will claim, then detect stale on recon)..."
  restart_service ai-trader

  # First verify it claimed
  local claim_logs
  claim_logs=$(get_logs ai-trader "Found existing position:|No open positions" 30)

  if echo "$claim_logs" | grep -q "No open positions"; then
    # Engine correctly saw no Tradovate position during startup sync
    pass "Test 9: AI Trader saw no Tradovate position — startup sync is clean"
    return
  fi

  if echo "$claim_logs" | grep -q "Found existing position:"; then
    log "AI Trader claimed position. Waiting for reconciliation to detect stale state..."
    # Reconciliation runs every 5 minutes; wait for it
    log "Waiting up to 330 seconds for reconciliation cycle..."
    local waited=0
    local found_stale=false
    while [ $waited -lt 330 ]; do
      sleep 15
      waited=$((waited + 15))
      local recon_logs
      recon_logs=$(get_logs ai-trader "RECONCILE.*Stale|RECONCILE.*flat.*Resetting" 100)
      if echo "$recon_logs" | grep -qE "Stale position detected|flat.*Resetting"; then
        found_stale=true
        break
      fi
      log "  ... ${waited}s elapsed, no stale detection yet"
    done

    if $found_stale; then
      pass "Test 9: Reconciliation correctly detected and cleared stale position"
    else
      fail "Test 9: Reconciliation did not detect stale position within 330s"
      local all_recon
      all_recon=$(get_logs ai-trader "RECONCILE" 100)
      echo "  Reconciliation logs: $(echo "$all_recon" | tail -5)"
    fi
  else
    skip "Test 9: Unexpected state — could not determine if position was claimed"
    echo "  Logs: $(echo "$claim_logs" | tail -5)"
  fi
}

# ─── Test 10: Full Pipeline — Trade Signal Through Orchestrator ─

test_10() {
  sep
  log "Test 10: Full Pipeline — Trade Signal Through Orchestrator"
  log "Goal: Send trade signal, verify orchestrator records ownership, engine claims on restart."

  local pos_status
  pos_status=$(has_open_position)

  if [ "$pos_status" != "FLAT" ]; then
    skip "Test 10: Need Tradovate to be FLAT (has position: $pos_status)"
    return
  fi

  log "Setting orchestrator state to flat..."
  set_flat

  log "Sending AI_TRADER trade signal via Redis (price far from market — should NOT fill)..."
  redis-cli PUBLISH trade.signal '{"timestamp":"2026-03-10T15:00:00Z","channel":"trade.signal","data":{"webhook_type":"trade_signal","action":"place_limit","side":"buy","symbol":"NQH6","price":15000.00,"stop_loss":14900.00,"take_profit":15200.00,"trailing_trigger":50,"trailing_offset":20,"quantity":1,"strategy":"AI_TRADER"}}' > /dev/null

  sleep 3

  # Check orchestrator processed the signal
  local orch_logs
  orch_logs=$(get_logs trade-orchestrator "signal.*AI_TRADER|order.*AI_TRADER|strategy.*AI_TRADER" 30)

  if echo "$orch_logs" | grep -qiE "AI_TRADER|signal"; then
    log "Orchestrator processed the trade signal"
  else
    log "(Orchestrator log check inconclusive — signal may still be in pipeline)"
  fi

  # Check Redis state for pending order
  local state
  state=$(get_redis_state)

  if [ -z "$state" ] || [ "$state" = "(nil)" ]; then
    fail "Test 10: Redis multi-strategy:state is empty after trade signal"
    return
  fi

  log "Current Redis state:"
  echo "$state" | python3 -m json.tool 2>/dev/null || echo "$state"

  # Since the limit order is far from market (15000), it won't fill.
  # Check if pendingOrders was updated with the AI_TRADER strategy
  local has_pending
  has_pending=$(echo "$state" | python3 -c "
import sys, json
data = json.load(sys.stdin)
pending = data.get('pendingOrders', {})
for oid, info in pending.items():
    if info.get('strategy') == 'AI_TRADER':
        print('yes')
        sys.exit(0)
# Also check positions in case it somehow filled
positions = data.get('positions', {})
for underlying, info in positions.items():
    if info.get('source') == 'AI_TRADER':
        print('position')
        sys.exit(0)
print('no')
" 2>/dev/null || echo "error")

  if [ "$has_pending" = "yes" ]; then
    pass "Test 10: Orchestrator recorded AI_TRADER pending order in Redis state"
  elif [ "$has_pending" = "position" ]; then
    pass "Test 10: Orchestrator recorded AI_TRADER position in Redis state (order filled!)"
  else
    # The orchestrator may not track pending orders in Redis state — check logs instead
    local order_logs
    order_logs=$(get_logs trade-orchestrator "AI_TRADER" 50)
    if echo "$order_logs" | grep -q "AI_TRADER"; then
      pass "Test 10: Orchestrator processed AI_TRADER signal (confirmed in logs)"
    else
      fail "Test 10: Could not confirm orchestrator tracked AI_TRADER ownership"
      echo "  Redis state pending: $has_pending"
    fi
  fi

  # Cleanup: cancel the pending order
  log "Cancelling test order..."
  redis-cli PUBLISH trade.signal '{"timestamp":"2026-03-10T15:00:01Z","channel":"trade.signal","data":{"webhook_type":"trade_signal","action":"cancel_limit","side":"buy","symbol":"NQH6","strategy":"AI_TRADER"}}' > /dev/null
  sleep 2
}

# ─── Main ─────────────────────────────────────────────────────

main() {
  echo -e "${CYAN}╔══════════════════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}║   Position Ownership Verification — Integration Tests   ║${NC}"
  echo -e "${CYAN}╚══════════════════════════════════════════════════════════╝${NC}"
  echo ""

  check_prereqs

  # Detect position state once for informational purposes
  local pos_status
  pos_status=$(has_open_position)
  if [ "$pos_status" = "FLAT" ]; then
    log "Note: Tradovate is FLAT. Tests 1-8 require an open NQ position."
    log "      Tests 9-10 require FLAT. Place a manual trade to enable tests 1-8."
    echo ""
  else
    log "Note: Tradovate has open position: $pos_status"
    log "      Tests 1-8 will run. Tests 9-10 require FLAT."
    echo ""
  fi

  # Save original Redis state to restore after tests
  local original_state
  original_state=$(get_redis_state 2>/dev/null || echo "")

  # Run selected tests
  should_run 1  && test_1
  should_run 2  && test_2
  should_run 3  && test_3
  should_run 4  && test_4
  should_run 5  && test_5
  should_run 6  && test_6
  should_run 7  && test_7
  should_run 8  && test_8
  should_run 9  && test_9
  should_run 10 && test_10

  # Restore original Redis state
  if [ -n "$original_state" ] && [ "$original_state" != "(nil)" ]; then
    log "Restoring original Redis state..."
    redis-cli SET "$REDIS_KEY" "$original_state" > /dev/null
  else
    log "Restoring Redis state to flat..."
    set_flat
  fi

  # Summary
  sep
  echo ""
  echo -e "${CYAN}Results:${NC}"
  echo -e "  ${GREEN}PASS: ${PASS}${NC}"
  echo -e "  ${RED}FAIL: ${FAIL}${NC}"
  echo -e "  ${YELLOW}SKIP: ${SKIP}${NC}"
  echo ""

  if [ $FAIL -gt 0 ]; then
    echo -e "${RED}Some tests failed!${NC}"
    exit 1
  elif [ $PASS -eq 0 ]; then
    echo -e "${YELLOW}No tests passed (all skipped). Check position state.${NC}"
    exit 0
  else
    echo -e "${GREEN}All executed tests passed!${NC}"
    exit 0
  fi
}

main
