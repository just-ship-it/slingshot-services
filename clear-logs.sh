#!/bin/bash

# Clear logs script for Slingshot Services
# This script clears all log files from the microservices to prepare for a clean run

echo "🧹 Clearing logs for Slingshot Services..."

# Define the services
services=(
    "market-data-service"
    "monitoring-service"
    "trade-orchestrator"
    "tradovate-service"
    "webhook-gateway"
)

# Clear logs for each service
for service in "${services[@]}"; do
    log_dir="${service}/logs"

    if [ -d "$log_dir" ]; then
        echo "📁 Clearing logs in $log_dir..."

        # Remove all .log files in the logs directory
        find "$log_dir" -name "*.log" -type f -exec rm -f {} \;

        echo "✅ Cleared logs for $service"
    else
        echo "⚠️  Log directory not found: $log_dir"
    fi
done

# Clear the main logs directory at project root
if [ -d "logs" ]; then
    echo "📁 Clearing logs in project root logs directory..."
    find "logs" -name "*.log" -type f -exec rm -f {} \;
    echo "✅ Cleared project root logs"
else
    echo "⚠️  Project root logs directory not found"
fi

# Also clear signal context
signal_context_file="trade-orchestrator/data/signal-context.json"
if [ -f "$signal_context_file" ]; then
    echo "🔄 Resetting signal context..."
    cat > "$signal_context_file" << 'EOF'
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)",
  "signalContext": {},
  "version": "1.0"
}
EOF
    echo "✅ Signal context reset"
fi

echo "🎉 All logs cleared! Ready for a clean run."
echo ""
echo "💡 Next steps:"
echo "   1. Close/cancel any open positions/orders in Tradovate"
echo "   2. Restart trade-orchestrator to sync fresh state"
echo "   3. Run your test signals"