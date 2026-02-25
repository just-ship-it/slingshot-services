#!/bin/bash

# Slingshot - Start trade execution services only (no signal generators)
# Use this for manual trading via the Quick Order panel or TestTrading interface.

echo "Starting Slingshot trade execution services..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SERVICES_DIR="/home/drew/projects/slingshot-services"

# Check Redis
echo -e "${YELLOW}Checking Redis...${NC}"
if ! redis-cli ping > /dev/null 2>&1; then
    echo -e "${RED}✗ Redis is not running. Please start Redis first: redis-server${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Redis is running${NC}"

cd "$SERVICES_DIR"
mkdir -p logs

# Copy .env file if not exists
if [ ! -f "$SERVICES_DIR/shared/.env" ]; then
    if [ -f "$SERVICES_DIR/shared/.env.example" ]; then
        echo -e "${YELLOW}Creating .env file from template...${NC}"
        cp "$SERVICES_DIR/shared/.env.example" "$SERVICES_DIR/shared/.env"
        echo -e "${RED}Please edit $SERVICES_DIR/shared/.env with your credentials${NC}"
        exit 1
    fi
fi

# Stop any existing PM2 processes first
pm2 delete all 2>/dev/null || true

# Start only the trade execution stack
SERVICES="tradovate-service,trade-orchestrator,monitoring-service,data-service,dashboard,cloudflared"

echo -e "${YELLOW}Starting: ${SERVICES}${NC}"
pm2 start "$SERVICES_DIR/ecosystem.config.cjs" --only "$SERVICES"

sleep 3

echo ""
echo -e "${GREEN}Trade execution services started!${NC}"
echo -e "${YELLOW}Signal generators are NOT running - manual orders only.${NC}"
echo ""
echo "PM2 Commands:"
echo "  pm2 status      - View all services"
echo "  pm2 logs        - View all logs"
echo "  pm2 monit       - Real-time monitoring"
echo ""
echo "Service URLs:"
echo "  Dashboard:        http://localhost:3020"
echo "  Webhook Endpoint: http://localhost:3014/webhook"
echo "  Tradovate:        http://localhost:3011/health"
echo "  Orchestrator:     http://localhost:3013/health"
echo "  Data Service:     http://localhost:3019/health"
echo "  Monitoring:       http://localhost:3014/health"
echo ""
echo "Cloudflare Tunnel:"
echo "  slingshot.ereptortrading.com → localhost:3014"
echo ""
echo "To stop: ./stop-all.sh"
