#!/bin/bash

# Slingshot Microservices Startup Script
# This script starts all services in the correct order

echo "Starting Slingshot Microservices..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Base directory
SERVICES_DIR="/mnt/c/projects/ereptor/slingshot/services"

# Function to check if Redis is running
check_redis() {
    echo -e "${YELLOW}Checking Redis...${NC}"
    if redis-cli ping > /dev/null 2>&1; then
        echo -e "${GREEN}✓ Redis is running${NC}"
        return 0
    else
        echo -e "${RED}✗ Redis is not running${NC}"
        echo "Please start Redis first: redis-server"
        return 1
    fi
}

# Function to install dependencies
install_deps() {
    local service_dir=$1
    local service_name=$2

    echo -e "${YELLOW}Installing dependencies for ${service_name}...${NC}"
    cd "$service_dir"
    if [ -f "package.json" ]; then
        npm install
        echo -e "${GREEN}✓ Dependencies installed for ${service_name}${NC}"
    else
        echo -e "${RED}✗ No package.json found for ${service_name}${NC}"
    fi
}

# Function to start a service
start_service() {
    local service_dir=$1
    local service_name=$2

    echo -e "${YELLOW}Starting ${service_name}...${NC}"
    cd "$service_dir"

    # Start service in background
    nohup node index.js > logs/${service_name}.log 2>&1 &
    local pid=$!

    # Save PID
    echo $pid > ${service_name}.pid

    sleep 2

    # Check if service started successfully
    if kill -0 $pid 2>/dev/null; then
        echo -e "${GREEN}✓ ${service_name} started (PID: $pid)${NC}"
        return 0
    else
        echo -e "${RED}✗ Failed to start ${service_name}${NC}"
        return 1
    fi
}

# Main execution
cd "$SERVICES_DIR"

# Check Redis first
if ! check_redis; then
    exit 1
fi

# Create logs directory
mkdir -p logs

# Install shared dependencies
echo -e "${YELLOW}Installing shared dependencies...${NC}"
cd shared
npm install
cd ..

# Install dependencies for each service
services=("webhook-gateway" "tradovate-service" "market-data-service" "trade-orchestrator" "monitoring-service")

for service in "${services[@]}"; do
    install_deps "$SERVICES_DIR/$service" "$service"
done

# Copy .env file if not exists
if [ ! -f "$SERVICES_DIR/shared/.env" ]; then
    if [ -f "$SERVICES_DIR/shared/.env.example" ]; then
        echo -e "${YELLOW}Creating .env file from template...${NC}"
        cp "$SERVICES_DIR/shared/.env.example" "$SERVICES_DIR/shared/.env"
        echo -e "${RED}Please edit $SERVICES_DIR/shared/.env with your credentials${NC}"
        exit 1
    fi
fi

# Start services in order
echo -e "${YELLOW}Starting services...${NC}"

# Start webhook gateway first (no dependencies)
start_service "$SERVICES_DIR/webhook-gateway" "webhook-gateway"

# Start tradovate service (depends on message bus)
sleep 1
start_service "$SERVICES_DIR/tradovate-service" "tradovate-service"

# Start market data service (depends on message bus and tradovate)
sleep 1
start_service "$SERVICES_DIR/market-data-service" "market-data-service"

# Start trade orchestrator (depends on message bus)
sleep 1
start_service "$SERVICES_DIR/trade-orchestrator" "trade-orchestrator"

# Start monitoring service (depends on message bus)
sleep 1
start_service "$SERVICES_DIR/monitoring-service" "monitoring-service"

echo ""
echo -e "${GREEN}All services started!${NC}"
echo ""
echo "Service URLs:"
echo "  Webhook Gateway:    http://localhost:3010/health"
echo "  Tradovate Service:  http://localhost:3011/health"
echo "  Market Data:        http://localhost:3012/health"
echo "  Trade Orchestrator: http://localhost:3013/health"
echo "  Monitoring:         http://localhost:3014/health"
echo ""
echo "Monitoring Dashboard: http://localhost:3014/api/dashboard"
echo "WebSocket:           ws://localhost:3014"
echo ""
echo "To stop all services, run: ./stop-all.sh"
echo "To view logs, check the logs/ directory"