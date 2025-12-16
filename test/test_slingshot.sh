#!/bin/bash

# Slingshot Multi-Strategy Test Script
# Usage: ./test_slingshot.sh <current_price> <scenario_number>
# Example: ./test_slingshot.sh 25160 1

WEBHOOK_URL="${WEBHOOK_URL:-http://localhost:3000/webhook}"
SECRET="${SECRET:-YOUR_SECRET}"

PRICE=${1:-25000}
SCENARIO=${2:-0}

# Calculate order prices (100 points away from market so they don't fill)
BUY_PRICE=$((PRICE - 100))
SELL_PRICE=$((PRICE + 100))

# Stop/target offsets
STOP_OFFSET=50
TARGET_OFFSET=100

BUY_STOP=$((BUY_PRICE - STOP_OFFSET))
BUY_TARGET=$((BUY_PRICE + TARGET_OFFSET))
SELL_STOP=$((SELL_PRICE + STOP_OFFSET))
SELL_TARGET=$((SELL_PRICE - TARGET_OFFSET))

echo "============================================"
echo "Market Price: $PRICE"
echo "Buy orders at: $BUY_PRICE (stop: $BUY_STOP, target: $BUY_TARGET)"
echo "Sell orders at: $SELL_PRICE (stop: $SELL_STOP, target: $SELL_TARGET)"
echo "Webhook: $WEBHOOK_URL"
echo "============================================"
echo ""

send_signal() {
    local payload="$1"
    local description="$2"
    echo ">>> $description"
    echo "$payload" | jq . 2>/dev/null || echo "$payload"
    curl -s -X POST "$WEBHOOK_URL" \
        -H "Content-Type: application/json" \
        -d "$payload"
    echo -e "\n"
}

case $SCENARIO in
    1)
        echo "=== SCENARIO 1: LDPS long signal while flat ==="
        send_signal "{
            \"webhook_type\": \"trade_signal\",
            \"secret\": \"$SECRET\",
            \"action\": \"place_limit\",
            \"side\": \"buy\",
            \"symbol\": \"MNQ\",
            \"price\": $BUY_PRICE,
            \"stop_loss\": $BUY_STOP,
            \"take_profit\": $BUY_TARGET,
            \"quantity\": 1,
            \"strategy\": \"LDPS\"
        }" "LDPS Long Limit Order"
        ;;
        
    2)
        echo "=== SCENARIO 2: Both strategies signal long (same direction) ==="
        send_signal "{
            \"webhook_type\": \"trade_signal\",
            \"secret\": \"$SECRET\",
            \"action\": \"place_limit\",
            \"side\": \"buy\",
            \"symbol\": \"MNQ\",
            \"price\": $BUY_PRICE,
            \"stop_loss\": $BUY_STOP,
            \"take_profit\": $BUY_TARGET,
            \"quantity\": 1,
            \"strategy\": \"LDPS\"
        }" "LDPS Long Limit Order"
        
        sleep 1
        
        send_signal "{
            \"webhook_type\": \"trade_signal\",
            \"secret\": \"$SECRET\",
            \"action\": \"place_limit\",
            \"side\": \"buy\",
            \"symbol\": \"MNQ\",
            \"price\": $((BUY_PRICE - 10)),
            \"stop_loss\": $((BUY_STOP - 10)),
            \"take_profit\": $((BUY_TARGET - 10)),
            \"quantity\": 1,
            \"strategy\": \"OptimalEntry\"
        }" "OES Long Limit Order (slightly lower)"
        ;;
        
    3)
        echo "=== SCENARIO 3: Opposite direction signals (LDPS long, OES short) ==="
        send_signal "{
            \"webhook_type\": \"trade_signal\",
            \"secret\": \"$SECRET\",
            \"action\": \"place_limit\",
            \"side\": \"buy\",
            \"symbol\": \"MNQ\",
            \"price\": $BUY_PRICE,
            \"stop_loss\": $BUY_STOP,
            \"take_profit\": $BUY_TARGET,
            \"quantity\": 1,
            \"strategy\": \"LDPS\"
        }" "LDPS Long Limit Order"
        
        sleep 1
        
        send_signal "{
            \"webhook_type\": \"trade_signal\",
            \"secret\": \"$SECRET\",
            \"action\": \"place_limit\",
            \"side\": \"sell\",
            \"symbol\": \"MNQ\",
            \"price\": $SELL_PRICE,
            \"stop_loss\": $SELL_STOP,
            \"take_profit\": $SELL_TARGET,
            \"quantity\": 1,
            \"strategy\": \"OptimalEntry\"
        }" "OES Short Limit Order"
        ;;
        
    4)
        echo "=== SCENARIO 4: LDPS short signal ==="
        send_signal "{
            \"webhook_type\": \"trade_signal\",
            \"secret\": \"$SECRET\",
            \"action\": \"place_limit\",
            \"side\": \"sell\",
            \"symbol\": \"MNQ\",
            \"price\": $SELL_PRICE,
            \"stop_loss\": $SELL_STOP,
            \"take_profit\": $SELL_TARGET,
            \"quantity\": 1,
            \"strategy\": \"LDPS\"
        }" "LDPS Short Limit Order"
        ;;
        
    5)
        echo "=== SCENARIO 5: OES long signal ==="
        send_signal "{
            \"webhook_type\": \"trade_signal\",
            \"secret\": \"$SECRET\",
            \"action\": \"place_limit\",
            \"side\": \"buy\",
            \"symbol\": \"MNQ\",
            \"price\": $BUY_PRICE,
            \"stop_loss\": $BUY_STOP,
            \"take_profit\": $BUY_TARGET,
            \"quantity\": 1,
            \"strategy\": \"OptimalEntry\"
        }" "OES Long Limit Order"
        ;;
        
    6)
        echo "=== SCENARIO 6: Cancel LDPS order (expired) ==="
        send_signal "{
            \"webhook_type\": \"trade_signal\",
            \"secret\": \"$SECRET\",
            \"action\": \"cancel_limit\",
            \"side\": \"buy\",
            \"symbol\": \"MNQ\",
            \"reason\": \"expired\",
            \"quantity\": 1,
            \"strategy\": \"LDPS\"
        }" "LDPS Cancel (expired)"
        ;;
        
    7)
        echo "=== SCENARIO 7: Cancel OES order (bias flip) ==="
        send_signal "{
            \"webhook_type\": \"trade_signal\",
            \"secret\": \"$SECRET\",
            \"action\": \"cancel_limit\",
            \"side\": \"sell\",
            \"symbol\": \"MNQ\",
            \"reason\": \"bias_flip\",
            \"quantity\": 1,
            \"strategy\": \"OptimalEntry\"
        }" "OES Cancel (bias flip)"
        ;;
        
    8)
        echo "=== SCENARIO 8: Position closed (LDPS long) ==="
        send_signal "{
            \"webhook_type\": \"trade_signal\",
            \"secret\": \"$SECRET\",
            \"action\": \"position_closed\",
            \"side\": \"long\",
            \"symbol\": \"MNQ\",
            \"exit_price\": $PRICE,
            \"strategy\": \"LDPS\"
        }" "LDPS Position Closed"
        ;;
        
    9)
        echo "=== SCENARIO 9: Position closed (OES short) ==="
        send_signal "{
            \"webhook_type\": \"trade_signal\",
            \"secret\": \"$SECRET\",
            \"action\": \"position_closed\",
            \"side\": \"short\",
            \"symbol\": \"MNQ\",
            \"exit_price\": $PRICE,
            \"strategy\": \"OptimalEntry\"
        }" "OES Position Closed"
        ;;
        
    10)
        echo "=== SCENARIO 10: Race condition (simultaneous signals) ==="
        send_signal "{
            \"webhook_type\": \"trade_signal\",
            \"secret\": \"$SECRET\",
            \"action\": \"place_limit\",
            \"side\": \"buy\",
            \"symbol\": \"MNQ\",
            \"price\": $BUY_PRICE,
            \"stop_loss\": $BUY_STOP,
            \"take_profit\": $BUY_TARGET,
            \"quantity\": 1,
            \"strategy\": \"LDPS\"
        }" "LDPS Long" &
        
        send_signal "{
            \"webhook_type\": \"trade_signal\",
            \"secret\": \"$SECRET\",
            \"action\": \"place_limit\",
            \"side\": \"sell\",
            \"symbol\": \"MNQ\",
            \"price\": $SELL_PRICE,
            \"stop_loss\": $SELL_STOP,
            \"take_profit\": $SELL_TARGET,
            \"quantity\": 1,
            \"strategy\": \"OptimalEntry\"
        }" "OES Short" &
        
        wait
        ;;
        
    *)
        echo "Available scenarios:"
        echo "  1  - LDPS long signal (flat)"
        echo "  2  - Both long (same direction)"
        echo "  3  - Opposite directions (LDPS long, OES short)"
        echo "  4  - LDPS short signal"
        echo "  5  - OES long signal"
        echo "  6  - Cancel LDPS (expired)"
        echo "  7  - Cancel OES (bias flip)"
        echo "  8  - Position closed (LDPS long)"
        echo "  9  - Position closed (OES short)"
        echo "  10 - Race condition (simultaneous)"
        echo ""
        echo "Usage: ./test_slingshot.sh <current_price> <scenario>"
        echo "Example: ./test_slingshot.sh 25160 3"
        echo ""
        echo "Environment variables:"
        echo "  WEBHOOK_URL - default: http://localhost:3000/webhook"
        echo "  SECRET      - default: YOUR_SECRET"
        ;;
esac
