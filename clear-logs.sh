#!/bin/bash

# Clear logs script for Slingshot Services
# This script clears all log files from the microservices to prepare for a clean run

echo "🧹 Clearing logs for Slingshot Services..."

# Define the services
services=(
    "monitoring-service"
    "trade-orchestrator"
    "tradovate-service"
    "signal-generator"
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

# Clear PM2 logs
echo "📋 Clearing PM2 logs..."
pm2 flush
echo "✅ PM2 logs cleared"

echo "🎉 All logs cleared! Ready for a clean run."
echo ""
echo "💡 Next steps:"
echo "   1. Close/cancel any open positions/orders in Tradovate"
echo "   2. Restart trade-orchestrator to sync fresh state"
echo "   3. Run your test signals"