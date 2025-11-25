#!/bin/bash

# Slingshot Microservices Stop Script
# This script stops all running services

echo "Stopping Slingshot Microservices..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Base directory
SERVICES_DIR="/mnt/c/projects/ereptor/slingshot/services"

# Function to stop a service
stop_service() {
    local service_name=$1
    local pid_file="${SERVICES_DIR}/${service_name}/${service_name}.pid"

    echo -e "${YELLOW}Stopping ${service_name}...${NC}"

    if [ -f "$pid_file" ]; then
        local pid=$(cat "$pid_file")
        if kill -0 $pid 2>/dev/null; then
            kill $pid
            sleep 1
            if kill -0 $pid 2>/dev/null; then
                # Force kill if still running
                kill -9 $pid
            fi
            echo -e "${GREEN}✓ ${service_name} stopped${NC}"
        else
            echo -e "${YELLOW}${service_name} was not running${NC}"
        fi
        rm -f "$pid_file"
    else
        echo -e "${YELLOW}No PID file found for ${service_name}${NC}"
        # Try to find and kill by name
        pkill -f "${service_name}/index.js" 2>/dev/null
    fi
}

# Stop services in reverse order
services=("monitoring-service" "trade-orchestrator" "market-data-service" "tradovate-service" "webhook-gateway")

for service in "${services[@]}"; do
    stop_service "$service"
done

echo ""
echo -e "${GREEN}All services stopped!${NC}"