#!/usr/bin/env bash
# Signal Lifecycle Test Script
# Interactive menu that injects trade signals via Redis to exercise every lifecycle path.
# Auto-verifies state across all 3 service layers after every action.
# Dependencies: bash, redis-cli, curl, jq, bc

set -euo pipefail

# --- Configuration ---
TRADOVATE="http://localhost:3011"
ORCHESTRATOR="http://localhost:3013"
SIGNAL_GEN="http://localhost:3015"
SERVICES=("3011:tradovate" "3013:orchestrator" "3014:monitoring" "3015:signal-gen" "3017:macro" "3018:ai-trader" "3019:data-service")

NQ_SYMBOL="NQH6"
ES_SYMBOL="ESH6"

NQ_PRICE=0
ES_PRICE=0
ACCOUNT_ID=""

# How long to wait for order lifecycle events before verifying (seconds)
VERIFY_DELAY=3

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# --- Core Helpers ---

fetch_prices() {
  local resp
  resp=$(curl -sf "${ORCHESTRATOR}/api/trading/enhanced-status" 2>/dev/null) || {
    echo -e "${RED}Failed to reach orchestrator at ${ORCHESTRATOR}${NC}"
    return 1
  }

  NQ_PRICE=$(echo "$resp" | jq -r '.marketPrices.NQ.price // .marketPrices.MNQ.price // 0')
  ES_PRICE=$(echo "$resp" | jq -r '.marketPrices.ES.price // .marketPrices.MES.price // 0')

  if [[ "$NQ_PRICE" == "0" || "$NQ_PRICE" == "null" ]]; then
    echo -e "${YELLOW}Warning: No NQ price from orchestrator, using default 25000${NC}"
    NQ_PRICE=25000
  fi
  if [[ "$ES_PRICE" == "0" || "$ES_PRICE" == "null" ]]; then
    echo -e "${YELLOW}Warning: No ES price from orchestrator, using default 6882${NC}"
    ES_PRICE=6882
  fi
}

fetch_account_id() {
  local resp
  resp=$(curl -sf "${TRADOVATE}/accounts" 2>/dev/null) || {
    echo -e "${YELLOW}Warning: Could not fetch Tradovate accounts — broker verification disabled${NC}"
    return 0
  }
  ACCOUNT_ID=$(echo "$resp" | jq -r '.[0].id // empty')
  if [[ -z "$ACCOUNT_ID" ]]; then
    echo -e "${YELLOW}Warning: No accounts found — broker verification disabled${NC}"
  else
    local acct_name
    acct_name=$(echo "$resp" | jq -r '.[0].name // "?"')
    echo -e "${GREEN}Tradovate account: ${acct_name} (id: ${ACCOUNT_ID})${NC}"
  fi
}

publish_signal() {
  local payload="$1"
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
  local envelope="{\"timestamp\":\"${ts}\",\"channel\":\"trade.signal\",\"data\":${payload}}"

  echo -e "${CYAN}Publishing to trade.signal:${NC}"
  echo "$envelope" | jq .
  redis-cli PUBLISH trade.signal "$envelope" > /dev/null
  echo -e "${GREEN}Published.${NC}"
}

# --- 3-Layer Verification ---

verify_all() {
  local context="${1:-}" # optional context string like "after place_limit" or "after cancel"
  local delay="${2:-$VERIFY_DELAY}"

  echo ""
  echo -e "${MAGENTA}${BOLD}--- Verifying state${context:+ ($context)} ---${NC}"
  echo -e "${DIM}Waiting ${delay}s for events to propagate...${NC}"
  sleep "$delay"

  verify_broker
  echo ""
  verify_orchestrator
  echo ""
  verify_strategies
  echo ""
  echo -e "${MAGENTA}${BOLD}--- Verification complete ---${NC}"
}

verify_broker() {
  echo -e "${MAGENTA}[BROKER] Tradovate API (ground truth)${NC}"
  if [[ -z "$ACCOUNT_ID" ]]; then
    echo -e "  ${DIM}(skipped — no account ID)${NC}"
    return 0
  fi

  # Positions
  local positions
  positions=$(curl -sf "${TRADOVATE}/positions/${ACCOUNT_ID}" 2>/dev/null) || {
    echo -e "  ${RED}Failed to query broker positions${NC}"; return 0
  }
  local open_positions
  open_positions=$(echo "$positions" | jq '[.[] | select(.netPos != 0)]')
  local pos_count
  pos_count=$(echo "$open_positions" | jq 'length')

  echo -e "  ${BOLD}Positions (${pos_count}):${NC}"
  if [[ "$pos_count" -gt 0 ]]; then
    echo "$open_positions" | jq -r '.[] | "    \(.contractId) netPos=\(.netPos) @ \(.netPrice)"'
  else
    echo "    (flat)"
  fi

  # Orders — filter to active only
  local orders
  orders=$(curl -sf "${TRADOVATE}/orders/${ACCOUNT_ID}" 2>/dev/null) || {
    echo -e "  ${RED}Failed to query broker orders${NC}"; return 0
  }
  local active_orders
  active_orders=$(echo "$orders" | jq '[.[] | select(.ordStatus == "Working" or .ordStatus == "Pending" or .ordStatus == "PendingNew" or .ordStatus == "Suspended")]')
  local ord_count
  ord_count=$(echo "$active_orders" | jq 'length')

  echo -e "  ${BOLD}Active Orders (${ord_count}):${NC}"
  if [[ "$ord_count" -gt 0 ]]; then
    echo "$active_orders" | jq -r '.[] | "    #\(.id) \(.action // "?") \(.symbol // .contractName // "?") \(.orderType // "?"): price=\(.price // .stopPrice // "?") qty=\(.qty // .orderQty // "?") status=\(.ordStatus)"'
  else
    echo "    (none)"
  fi

  # Strategy mappings
  local mappings
  mappings=$(curl -sf "${TRADOVATE}/api/order-strategy-mappings" 2>/dev/null) || return 0
  local map_count
  map_count=$(echo "$mappings" | jq '.count // 0')
  if [[ "$map_count" -gt 0 ]]; then
    echo -e "  ${BOLD}Order->Strategy Mappings (${map_count}):${NC}"
    echo "$mappings" | jq -r '.mappings[]? | "    order #\(.orderId) -> \(.strategy)"'
  fi
}

verify_orchestrator() {
  echo -e "${MAGENTA}[ORCHESTRATOR] Trade Orchestrator State${NC}"
  local resp
  resp=$(curl -sf "${ORCHESTRATOR}/api/trading/enhanced-status" 2>/dev/null) || {
    echo -e "  ${RED}Orchestrator unreachable${NC}"; return 0
  }

  # Trading enabled
  echo -e "  Trading Enabled: $(echo "$resp" | jq -r '.tradingEnabled')"

  # Positions
  local pos_count
  pos_count=$(echo "$resp" | jq '.openPositions | length')
  echo -e "  ${BOLD}Positions (${pos_count}):${NC}"
  if [[ "$pos_count" -gt 0 ]]; then
    echo "$resp" | jq -r '.openPositions[] | "    \(.symbol) \(.side) \(.netPos)x @ \(.entryPrice) | P&L: \(.unrealizedPnL // "?") | Stop: \(.stopPrice // "none") | Target: \(.targetPrice // "none") | Strategy: \(.signalContext.strategy // "?")"'
  else
    echo "    (flat)"
  fi

  # Pending orders
  local ord_count
  ord_count=$(echo "$resp" | jq '.pendingOrders | length')
  echo -e "  ${BOLD}Pending Entry Orders (${ord_count}):${NC}"
  if [[ "$ord_count" -gt 0 ]]; then
    echo "$resp" | jq -r '.pendingOrders[] | "    #\(.orderId) \(.action) \(.symbol) @ \(.price) [\(.signalContext.strategy // "?")] | \(.marketDistance.points // "?")pts \(.marketDistance.direction // "")"'
  else
    echo "    (none)"
  fi

  # Working orders (raw — includes bracket legs the enhanced-status hides)
  local working
  working=$(curl -sf "${ORCHESTRATOR}/api/trading/orders" 2>/dev/null) || return 0
  local work_count
  work_count=$(echo "$working" | jq 'length')
  if [[ "$work_count" -gt 0 ]]; then
    echo -e "  ${BOLD}All Working Orders incl. brackets (${work_count}):${NC}"
    echo "$working" | jq -r 'to_entries[] | "    #\(.key) \(.value.action // "?") \(.value.symbol // "?") \(.value.orderType // "?"): price=\(.value.price // .value.stopPrice // "?") status=\(.value.status // "?")"'
  fi

  # Strategy state from orchestrator
  local strat_state
  strat_state=$(echo "$resp" | jq '.strategyState // empty' 2>/dev/null)
  if [[ -n "$strat_state" && "$strat_state" != "null" ]]; then
    echo -e "  ${BOLD}Multi-Strategy State:${NC}"
    echo "$strat_state" | jq .
  fi
}

verify_strategies() {
  echo -e "${MAGENTA}[SIGNAL-GEN] Strategy Engine State${NC}"
  local resp
  resp=$(curl -sf "${SIGNAL_GEN}/strategy/status" 2>/dev/null) || {
    echo -e "  ${RED}Signal generator unreachable${NC}"; return 0
  }

  echo "$resp" | jq -r '.strategies[]? | "  \(.constant // .name): enabled=\(.enabled) | in_position=\(.position.in_position) | pending=\(.pending_orders.count // 0) | ready=\(.evaluation_readiness.ready) | session=\(.session.in_session)"'

  # Show position details if any strategy is in position
  local in_pos
  in_pos=$(echo "$resp" | jq '[.strategies[]? | select(.position.in_position == true)]')
  local in_pos_count
  in_pos_count=$(echo "$in_pos" | jq 'length')
  if [[ "$in_pos_count" -gt 0 ]]; then
    echo -e "  ${BOLD}Strategy positions:${NC}"
    echo "$in_pos" | jq -r '.[] | "    \(.constant // .name): \(.position.current.side // "?") \(.position.current.symbol // "?") @ \(.position.current.entryPrice // "?")"'
  fi

  # Show blockers for any strategy that's not ready
  local not_ready
  not_ready=$(echo "$resp" | jq '[.strategies[]? | select(.evaluation_readiness.ready == false) | {name: (.constant // .name), blockers: .evaluation_readiness.blockers}]')
  local not_ready_count
  not_ready_count=$(echo "$not_ready" | jq 'length')
  if [[ "$not_ready_count" -gt 0 ]]; then
    echo -e "  ${BOLD}Blocked strategies:${NC}"
    echo "$not_ready" | jq -r '.[] | "    \(.name): \(.blockers | join(", "))"'
  fi
}

# --- Convenience status checks (manual menu items) ---

check_status() {
  echo ""
  verify_broker
  echo ""
  verify_orchestrator
}

check_strategies() {
  echo ""
  verify_strategies
}

check_health() {
  echo -e "\n${BOLD}=== Service Health ===${NC}"
  for svc in "${SERVICES[@]}"; do
    local port="${svc%%:*}"
    local name="${svc##*:}"
    local status
    if curl -sf "http://localhost:${port}/health" > /dev/null 2>&1; then
      status="${GREEN}UP${NC}"
    else
      status="${RED}DOWN${NC}"
    fi
    printf "  %-15s (:%s)  %b\n" "$name" "$port" "$status"
  done
}

check_signal_registry() {
  echo -e "\n${BOLD}=== Signal Registry ===${NC}"
  local resp
  resp=$(curl -sf "${ORCHESTRATOR}/api/trading/signal-registry?includeLifecycles=true" 2>/dev/null) || {
    echo -e "${RED}Orchestrator unreachable${NC}"; return 1
  }

  echo -e "${BOLD}Stats:${NC}"
  echo "$resp" | jq '.signalRegistryStats'

  local lifecycle_count
  lifecycle_count=$(echo "$resp" | jq '.signalLifecycles | length // 0')
  if [[ "$lifecycle_count" -gt 0 ]]; then
    echo -e "\n${BOLD}Recent Signal Lifecycles (last 5):${NC}"
    echo "$resp" | jq '[.signalLifecycles | to_entries | sort_by(.value.createdAt) | reverse | .[:5] | .[] | {signalId: .key, strategy: .value.strategy, status: .value.status, orders: (.value.orders // [] | length), created: .value.createdAt}]'
  fi
}

cleanup() {
  echo -e "\n${BOLD}=== Cleanup: closing all positions & cancelling all orders ===${NC}"
  local strategies=("IV_SKEW_GEX" "ES_CROSS_SIGNAL" "MNQ_ADAPTIVE_SCALPER" "AI_TRADER")
  local symbols=("$NQ_SYMBOL" "$ES_SYMBOL" "$NQ_SYMBOL" "$NQ_SYMBOL")
  local sides=("buy" "sell")

  for i in "${!strategies[@]}"; do
    local strat="${strategies[$i]}"
    local sym="${symbols[$i]}"

    echo -e "${YELLOW}Closing ${strat}...${NC}"
    publish_signal "{\"action\":\"position_closed\",\"symbol\":\"${sym}\",\"side\":\"buy\",\"strategy\":\"${strat}\"}"

    for side in "${sides[@]}"; do
      publish_signal "{\"action\":\"cancel_limit\",\"symbol\":\"${sym}\",\"side\":\"${side}\",\"strategy\":\"${strat}\",\"reason\":\"cleanup\"}"
    done
  done

  verify_all "after cleanup" 4
}

# --- Price math helpers ---
calc() { echo "$1" | bc | sed 's/\..*//' ; }

nq_fill_buy()    { calc "${NQ_PRICE} + 5"; }
nq_fill_sell()   { calc "${NQ_PRICE} - 5"; }
nq_wont_fill()   { calc "${NQ_PRICE} - 300"; }
# Tight stops: must be below actual fill price (which can be well below the limit
# on demo). Use spot - 15 to guarantee validity while still triggering quickly.
nq_tight_stop()  { calc "${NQ_PRICE} - 15"; }

es_fill_buy()    { calc "${ES_PRICE} + 5"; }
es_fill_sell()   { calc "${ES_PRICE} - 5"; }
es_wont_fill()   { calc "${ES_PRICE} - 300"; }
es_tight_stop()  { calc "${ES_PRICE} - 5"; }

# --- Signal builders (each calls verify_all after publishing) ---

# IV_SKEW_GEX (NQ) — 70pt stop, 70pt target, no trailing
ivskew_buy_fill() {
  local p; p=$(nq_fill_buy)
  local sl; sl=$(calc "${p} - 70")
  local tp; tp=$(calc "${p} + 70")
  publish_signal "{\"action\":\"place_limit\",\"side\":\"buy\",\"symbol\":\"${NQ_SYMBOL}\",\"price\":${p},\"stop_loss\":${sl},\"take_profit\":${tp},\"quantity\":1,\"strategy\":\"IV_SKEW_GEX\"}"
  verify_all "IV_SKEW_GEX buy limit @ ${p} — expect FILL + bracket"
}

ivskew_buy_tight_stop() {
  local p; p=$(nq_fill_buy)
  local sl; sl=$(nq_tight_stop)
  local tp; tp=$(calc "${p} + 70")
  publish_signal "{\"action\":\"place_limit\",\"side\":\"buy\",\"symbol\":\"${NQ_SYMBOL}\",\"price\":${p},\"stop_loss\":${sl},\"take_profit\":${tp},\"quantity\":1,\"strategy\":\"IV_SKEW_GEX\"}"
  verify_all "IV_SKEW_GEX buy tight stop=${sl} — expect FILL then STOP OUT" 5
}

ivskew_buy_wont_fill() {
  local p; p=$(nq_wont_fill)
  local sl; sl=$(calc "${p} - 70")
  local tp; tp=$(calc "${p} + 70")
  publish_signal "{\"action\":\"place_limit\",\"side\":\"buy\",\"symbol\":\"${NQ_SYMBOL}\",\"price\":${p},\"stop_loss\":${sl},\"take_profit\":${tp},\"quantity\":1,\"strategy\":\"IV_SKEW_GEX\"}"
  verify_all "IV_SKEW_GEX buy far below @ ${p} — expect PENDING at broker"
}

ivskew_cancel() {
  publish_signal "{\"action\":\"cancel_limit\",\"symbol\":\"${NQ_SYMBOL}\",\"side\":\"buy\",\"strategy\":\"IV_SKEW_GEX\",\"reason\":\"test_cancel\"}"
  verify_all "IV_SKEW_GEX cancel — expect NO pending orders at broker"
}

ivskew_close() {
  publish_signal "{\"action\":\"position_closed\",\"symbol\":\"${NQ_SYMBOL}\",\"side\":\"buy\",\"strategy\":\"IV_SKEW_GEX\"}"
  verify_all "IV_SKEW_GEX close — expect FLAT everywhere"
}

ivskew_buy_reject() {
  echo -e "${YELLOW}Sending duplicate buy — expect rejection if already in NQ position${NC}"
  local p; p=$(nq_fill_buy)
  local sl; sl=$(calc "${p} - 70")
  local tp; tp=$(calc "${p} + 70")
  publish_signal "{\"action\":\"place_limit\",\"side\":\"buy\",\"symbol\":\"${NQ_SYMBOL}\",\"price\":${p},\"stop_loss\":${sl},\"take_profit\":${tp},\"quantity\":1,\"strategy\":\"IV_SKEW_GEX\"}"
  verify_all "IV_SKEW_GEX duplicate — expect REJECTED, no new orders at broker"
}

ivskew_sell_fill() {
  local p; p=$(nq_fill_sell)
  local sl; sl=$(calc "${p} + 70")
  local tp; tp=$(calc "${p} - 70")
  publish_signal "{\"action\":\"place_limit\",\"side\":\"sell\",\"symbol\":\"${NQ_SYMBOL}\",\"price\":${p},\"stop_loss\":${sl},\"take_profit\":${tp},\"quantity\":1,\"strategy\":\"IV_SKEW_GEX\"}"
  verify_all "IV_SKEW_GEX sell limit @ ${p} — expect FILL + bracket (short)"
}

# ES_CROSS_SIGNAL (ES) — 10pt stop, 10pt target, trailing 3/3
escross_buy_fill() {
  local p; p=$(es_fill_buy)
  local sl; sl=$(calc "${p} - 10")
  local tp; tp=$(calc "${p} + 10")
  publish_signal "{\"action\":\"place_limit\",\"side\":\"buy\",\"symbol\":\"${ES_SYMBOL}\",\"price\":${p},\"stop_loss\":${sl},\"take_profit\":${tp},\"trailing_trigger\":3,\"trailing_offset\":3,\"quantity\":1,\"strategy\":\"ES_CROSS_SIGNAL\"}"
  verify_all "ES_CROSS_SIGNAL buy limit @ ${p} — expect FILL + bracket + trailing"
}

escross_buy_tight_stop() {
  local p; p=$(es_fill_buy)
  local sl; sl=$(es_tight_stop)
  local tp; tp=$(calc "${p} + 10")
  publish_signal "{\"action\":\"place_limit\",\"side\":\"buy\",\"symbol\":\"${ES_SYMBOL}\",\"price\":${p},\"stop_loss\":${sl},\"take_profit\":${tp},\"trailing_trigger\":3,\"trailing_offset\":3,\"quantity\":1,\"strategy\":\"ES_CROSS_SIGNAL\"}"
  verify_all "ES_CROSS_SIGNAL buy tight stop=${sl} — expect FILL then STOP OUT" 5
}

escross_buy_wont_fill() {
  local p; p=$(es_wont_fill)
  local sl; sl=$(calc "${p} - 10")
  local tp; tp=$(calc "${p} + 10")
  publish_signal "{\"action\":\"place_limit\",\"side\":\"buy\",\"symbol\":\"${ES_SYMBOL}\",\"price\":${p},\"stop_loss\":${sl},\"take_profit\":${tp},\"trailing_trigger\":3,\"trailing_offset\":3,\"quantity\":1,\"strategy\":\"ES_CROSS_SIGNAL\"}"
  verify_all "ES_CROSS_SIGNAL buy far below @ ${p} — expect PENDING at broker"
}

escross_cancel() {
  publish_signal "{\"action\":\"cancel_limit\",\"symbol\":\"${ES_SYMBOL}\",\"side\":\"buy\",\"strategy\":\"ES_CROSS_SIGNAL\",\"reason\":\"test_cancel\"}"
  verify_all "ES_CROSS_SIGNAL cancel — expect NO pending orders at broker"
}

escross_close() {
  publish_signal "{\"action\":\"position_closed\",\"symbol\":\"${ES_SYMBOL}\",\"side\":\"buy\",\"strategy\":\"ES_CROSS_SIGNAL\"}"
  verify_all "ES_CROSS_SIGNAL close — expect FLAT everywhere"
}

escross_buy_reject() {
  echo -e "${YELLOW}Sending duplicate buy — expect rejection if already in ES position${NC}"
  local p; p=$(es_fill_buy)
  local sl; sl=$(calc "${p} - 10")
  local tp; tp=$(calc "${p} + 10")
  publish_signal "{\"action\":\"place_limit\",\"side\":\"buy\",\"symbol\":\"${ES_SYMBOL}\",\"price\":${p},\"stop_loss\":${sl},\"take_profit\":${tp},\"trailing_trigger\":3,\"trailing_offset\":3,\"quantity\":1,\"strategy\":\"ES_CROSS_SIGNAL\"}"
  verify_all "ES_CROSS_SIGNAL duplicate — expect REJECTED, no new orders at broker"
}

# MNQ_ADAPTIVE_SCALPER (NQ) — 40pt stop, 50pt target, trailing 3/1
mnqscalp_buy_fill() {
  local p; p=$(nq_fill_buy)
  local sl; sl=$(calc "${p} - 40")
  local tp; tp=$(calc "${p} + 50")
  publish_signal "{\"action\":\"place_limit\",\"side\":\"buy\",\"symbol\":\"${NQ_SYMBOL}\",\"price\":${p},\"stop_loss\":${sl},\"take_profit\":${tp},\"trailing_trigger\":3,\"trailing_offset\":1,\"quantity\":1,\"strategy\":\"MNQ_ADAPTIVE_SCALPER\"}"
  verify_all "MNQ_ADAPTIVE_SCALPER buy limit @ ${p} — expect FILL + bracket + trailing"
}

mnqscalp_buy_tight_stop() {
  local p; p=$(nq_fill_buy)
  local sl; sl=$(nq_tight_stop)
  local tp; tp=$(calc "${p} + 50")
  publish_signal "{\"action\":\"place_limit\",\"side\":\"buy\",\"symbol\":\"${NQ_SYMBOL}\",\"price\":${p},\"stop_loss\":${sl},\"take_profit\":${tp},\"trailing_trigger\":3,\"trailing_offset\":1,\"quantity\":1,\"strategy\":\"MNQ_ADAPTIVE_SCALPER\"}"
  verify_all "MNQ_ADAPTIVE_SCALPER buy tight stop=${sl} — expect FILL then STOP OUT" 5
}

mnqscalp_buy_wont_fill() {
  local p; p=$(nq_wont_fill)
  local sl; sl=$(calc "${p} - 40")
  local tp; tp=$(calc "${p} + 50")
  publish_signal "{\"action\":\"place_limit\",\"side\":\"buy\",\"symbol\":\"${NQ_SYMBOL}\",\"price\":${p},\"stop_loss\":${sl},\"take_profit\":${tp},\"trailing_trigger\":3,\"trailing_offset\":1,\"quantity\":1,\"strategy\":\"MNQ_ADAPTIVE_SCALPER\"}"
  verify_all "MNQ_ADAPTIVE_SCALPER buy far below @ ${p} — expect PENDING at broker"
}

mnqscalp_cancel() {
  publish_signal "{\"action\":\"cancel_limit\",\"symbol\":\"${NQ_SYMBOL}\",\"side\":\"buy\",\"strategy\":\"MNQ_ADAPTIVE_SCALPER\",\"reason\":\"test_cancel\"}"
  verify_all "MNQ_ADAPTIVE_SCALPER cancel — expect NO pending orders at broker"
}

mnqscalp_close() {
  publish_signal "{\"action\":\"position_closed\",\"symbol\":\"${NQ_SYMBOL}\",\"side\":\"buy\",\"strategy\":\"MNQ_ADAPTIVE_SCALPER\"}"
  verify_all "MNQ_ADAPTIVE_SCALPER close — expect FLAT everywhere"
}

# AI_TRADER (NQ) — 30pt stop, 45pt target, no trailing
aitrader_buy_fill() {
  local p; p=$(nq_fill_buy)
  local sl; sl=$(calc "${p} - 30")
  local tp; tp=$(calc "${p} + 45")
  publish_signal "{\"action\":\"place_limit\",\"side\":\"buy\",\"symbol\":\"${NQ_SYMBOL}\",\"price\":${p},\"stop_loss\":${sl},\"take_profit\":${tp},\"quantity\":1,\"strategy\":\"AI_TRADER\"}"
  verify_all "AI_TRADER buy limit @ ${p} — expect FILL + bracket"
}

aitrader_buy_tight_stop() {
  local p; p=$(nq_fill_buy)
  local sl; sl=$(nq_tight_stop)
  local tp; tp=$(calc "${p} + 45")
  publish_signal "{\"action\":\"place_limit\",\"side\":\"buy\",\"symbol\":\"${NQ_SYMBOL}\",\"price\":${p},\"stop_loss\":${sl},\"take_profit\":${tp},\"quantity\":1,\"strategy\":\"AI_TRADER\"}"
  verify_all "AI_TRADER buy tight stop=${sl} — expect FILL then STOP OUT" 5
}

aitrader_buy_wont_fill() {
  local p; p=$(nq_wont_fill)
  local sl; sl=$(calc "${p} - 30")
  local tp; tp=$(calc "${p} + 45")
  publish_signal "{\"action\":\"place_limit\",\"side\":\"buy\",\"symbol\":\"${NQ_SYMBOL}\",\"price\":${p},\"stop_loss\":${sl},\"take_profit\":${tp},\"quantity\":1,\"strategy\":\"AI_TRADER\"}"
  verify_all "AI_TRADER buy far below @ ${p} — expect PENDING at broker"
}

aitrader_cancel() {
  publish_signal "{\"action\":\"cancel_limit\",\"symbol\":\"${NQ_SYMBOL}\",\"side\":\"buy\",\"strategy\":\"AI_TRADER\",\"reason\":\"test_cancel\"}"
  verify_all "AI_TRADER cancel — expect NO pending orders at broker"
}

aitrader_close() {
  publish_signal "{\"action\":\"position_closed\",\"symbol\":\"${NQ_SYMBOL}\",\"side\":\"buy\",\"strategy\":\"AI_TRADER\"}"
  verify_all "AI_TRADER close — expect FLAT everywhere"
}

# --- Cross-strategy tests ---

cross_nq_es_both_long() {
  echo -e "${BOLD}Placing NQ long (IV_SKEW_GEX) + ES long (ES_CROSS_SIGNAL) — both should succeed${NC}"

  local nq_p; nq_p=$(nq_fill_buy)
  local nq_sl; nq_sl=$(calc "${nq_p} - 70")
  local nq_tp; nq_tp=$(calc "${nq_p} + 70")
  publish_signal "{\"action\":\"place_limit\",\"side\":\"buy\",\"symbol\":\"${NQ_SYMBOL}\",\"price\":${nq_p},\"stop_loss\":${nq_sl},\"take_profit\":${nq_tp},\"quantity\":1,\"strategy\":\"IV_SKEW_GEX\"}"

  echo ""
  local es_p; es_p=$(es_fill_buy)
  local es_sl; es_sl=$(calc "${es_p} - 10")
  local es_tp; es_tp=$(calc "${es_p} + 10")
  publish_signal "{\"action\":\"place_limit\",\"side\":\"buy\",\"symbol\":\"${ES_SYMBOL}\",\"price\":${es_p},\"stop_loss\":${es_sl},\"take_profit\":${es_tp},\"trailing_trigger\":3,\"trailing_offset\":3,\"quantity\":1,\"strategy\":\"ES_CROSS_SIGNAL\"}"

  verify_all "NQ+ES both long — expect 2 positions, 2 sets of brackets" 4
}

cross_nq_long_es_short() {
  echo -e "${BOLD}Placing NQ long (IV_SKEW_GEX) then ES short — ES should be VETOED (opposite direction filter)${NC}"

  local nq_p; nq_p=$(nq_fill_buy)
  local nq_sl; nq_sl=$(calc "${nq_p} - 70")
  local nq_tp; nq_tp=$(calc "${nq_p} + 70")
  publish_signal "{\"action\":\"place_limit\",\"side\":\"buy\",\"symbol\":\"${NQ_SYMBOL}\",\"price\":${nq_p},\"stop_loss\":${nq_sl},\"take_profit\":${nq_tp},\"quantity\":1,\"strategy\":\"IV_SKEW_GEX\"}"

  echo ""
  echo -e "${YELLOW}Waiting 3s for NQ fill before sending ES short...${NC}"
  sleep 3

  local es_p; es_p=$(es_fill_sell)
  local es_sl; es_sl=$(calc "${es_p} + 10")
  local es_tp; es_tp=$(calc "${es_p} - 10")
  publish_signal "{\"action\":\"place_limit\",\"side\":\"sell\",\"symbol\":\"${ES_SYMBOL}\",\"price\":${es_p},\"stop_loss\":${es_sl},\"take_profit\":${es_tp},\"trailing_trigger\":3,\"trailing_offset\":3,\"quantity\":1,\"strategy\":\"ES_CROSS_SIGNAL\"}"

  verify_all "NQ long + ES short — expect NQ position ONLY, ES rejected at broker" 4
}

cross_nq_mutual_exclusion() {
  echo -e "${BOLD}Testing NQ mutual exclusion: IV_SKEW_GEX position should block MNQ_ADAPTIVE_SCALPER and AI_TRADER${NC}"

  echo -e "${YELLOW}Step 1: Place IV_SKEW_GEX buy...${NC}"
  local p; p=$(nq_fill_buy)
  local sl; sl=$(calc "${p} - 70")
  local tp; tp=$(calc "${p} + 70")
  publish_signal "{\"action\":\"place_limit\",\"side\":\"buy\",\"symbol\":\"${NQ_SYMBOL}\",\"price\":${p},\"stop_loss\":${sl},\"take_profit\":${tp},\"quantity\":1,\"strategy\":\"IV_SKEW_GEX\"}"

  echo -e "${YELLOW}Waiting 3s for fill...${NC}"
  sleep 3

  echo -e "${YELLOW}Step 2: Attempt MNQ_ADAPTIVE_SCALPER buy — should be REJECTED...${NC}"
  local p2; p2=$(nq_fill_buy)
  local sl2; sl2=$(calc "${p2} - 40")
  local tp2; tp2=$(calc "${p2} + 50")
  publish_signal "{\"action\":\"place_limit\",\"side\":\"buy\",\"symbol\":\"${NQ_SYMBOL}\",\"price\":${p2},\"stop_loss\":${sl2},\"take_profit\":${tp2},\"trailing_trigger\":3,\"trailing_offset\":1,\"quantity\":1,\"strategy\":\"MNQ_ADAPTIVE_SCALPER\"}"

  echo ""
  echo -e "${YELLOW}Step 3: Attempt AI_TRADER buy — should be REJECTED...${NC}"
  local p3; p3=$(nq_fill_buy)
  local sl3; sl3=$(calc "${p3} - 30")
  local tp3; tp3=$(calc "${p3} + 45")
  publish_signal "{\"action\":\"place_limit\",\"side\":\"buy\",\"symbol\":\"${NQ_SYMBOL}\",\"price\":${p3},\"stop_loss\":${sl3},\"take_profit\":${tp3},\"quantity\":1,\"strategy\":\"AI_TRADER\"}"

  verify_all "NQ mutual exclusion — expect 1 NQ position (IV_SKEW_GEX only), no extra orders" 4
}

# --- Menu ---

print_menu() {
  echo ""
  echo -e "${BOLD}=== Slingshot Signal Lifecycle Tester ===${NC}"
  echo -e "NQ: ${GREEN}\$${NQ_PRICE}${NC}  |  ES: ${GREEN}\$${ES_PRICE}${NC}  |  Account: ${ACCOUNT_ID:-none}"
  echo ""
  echo -e "${BOLD}--- Utilities ---${NC}"
  echo "  0) Refresh prices"
  echo "  1) Check positions & orders (broker + orchestrator)"
  echo "  2) Check strategy status (signal-generator)"
  echo "  3) Check service health"
  echo "  4) Cleanup: close all positions + cancel all orders"
  echo "  5) Signal registry (full signal lifecycle tracking)"
  echo ""
  echo -e "${BOLD}--- IV_SKEW_GEX (NQ) ---${NC}"
  echo " 10) BUY limit near spot -> should fill -> bracket active"
  echo " 11) BUY limit tight stop -> fill -> stop hits quickly"
  echo " 12) BUY limit far below spot -> stays pending (won't fill)"
  echo " 13) Cancel pending limit from test 12"
  echo " 14) Close position manually (position_closed)"
  echo " 15) BUY while already in position -> REJECTED"
  echo " 16) SELL limit near spot -> should fill"
  echo ""
  echo -e "${BOLD}--- ES_CROSS_SIGNAL (ES) ---${NC}"
  echo " 20) BUY limit near spot -> should fill (w/ trailing 3/3)"
  echo " 21) BUY limit tight stop -> fill -> stop hits"
  echo " 22) BUY limit far below -> stays pending"
  echo " 23) Cancel pending from test 22"
  echo " 24) Close position manually"
  echo " 25) BUY while already in position -> REJECTED"
  echo ""
  echo -e "${BOLD}--- MNQ_ADAPTIVE_SCALPER (NQ) ---${NC}"
  echo " 30) BUY limit near spot -> should fill (w/ trailing 3/1)"
  echo " 31) BUY limit tight stop -> fill -> stop hits"
  echo " 32) BUY limit far below -> stays pending"
  echo " 33) Cancel pending from test 32"
  echo " 34) Close position manually"
  echo ""
  echo -e "${BOLD}--- AI_TRADER (NQ) ---${NC}"
  echo " 40) BUY limit near spot -> should fill"
  echo " 41) BUY limit tight stop -> fill -> stop hits"
  echo " 42) BUY limit far below -> stays pending"
  echo " 43) Cancel pending from test 42"
  echo " 44) Close position manually"
  echo ""
  echo -e "${BOLD}--- Cross-Strategy ---${NC}"
  echo " 50) NQ long + ES long -> both succeed (independent products)"
  echo " 51) NQ long + ES short -> ES VETOED (opposite direction filter)"
  echo " 52) NQ position blocks other NQ strategies"
  echo ""
  echo "  q) Quit"
}

handle_choice() {
  # Auto-refresh prices before any test that places orders
  case "$1" in
    [1-9][0-9]) fetch_prices 2>/dev/null ;;
  esac

  case "$1" in
    0)  fetch_prices ;;
    1)  check_status ;;
    2)  check_strategies ;;
    3)  check_health ;;
    4)  cleanup ;;
    5)  check_signal_registry ;;

    10) ivskew_buy_fill ;;
    11) ivskew_buy_tight_stop ;;
    12) ivskew_buy_wont_fill ;;
    13) ivskew_cancel ;;
    14) ivskew_close ;;
    15) ivskew_buy_reject ;;
    16) ivskew_sell_fill ;;

    20) escross_buy_fill ;;
    21) escross_buy_tight_stop ;;
    22) escross_buy_wont_fill ;;
    23) escross_cancel ;;
    24) escross_close ;;
    25) escross_buy_reject ;;

    30) mnqscalp_buy_fill ;;
    31) mnqscalp_buy_tight_stop ;;
    32) mnqscalp_buy_wont_fill ;;
    33) mnqscalp_cancel ;;
    34) mnqscalp_close ;;

    40) aitrader_buy_fill ;;
    41) aitrader_buy_tight_stop ;;
    42) aitrader_buy_wont_fill ;;
    43) aitrader_cancel ;;
    44) aitrader_close ;;

    50) cross_nq_es_both_long ;;
    51) cross_nq_long_es_short ;;
    52) cross_nq_mutual_exclusion ;;

    q|Q) echo "Bye."; exit 0 ;;
    *)  echo -e "${RED}Unknown choice: $1${NC}" ;;
  esac
}

# --- Main ---

# Check dependencies
for cmd in redis-cli curl jq bc; do
  command -v "$cmd" > /dev/null 2>&1 || { echo -e "${RED}Missing dependency: ${cmd}${NC}"; exit 1; }
done

echo -e "${BOLD}Initializing...${NC}"
fetch_prices
fetch_account_id

echo ""
echo -e "${BOLD}Tip:${NC} Run ${CYAN}pm2 logs trade-orchestrator --lines 0${NC} in another terminal to watch events in real time."

while true; do
  print_menu
  echo ""
  read -rp "Choice: " choice
  handle_choice "$choice"
done
