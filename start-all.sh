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
SERVICES_DIR="/home/drew/projects/slingshot-services"

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
    elif [ -f "requirements.txt" ]; then
        # For Python services
        if ! command -v python3 &> /dev/null; then
            echo -e "${RED}✗ Python3 not found for ${service_name}${NC}"
            return 1
        fi
        pip install -r requirements.txt
        echo -e "${GREEN}✓ Python dependencies installed for ${service_name}${NC}"
    else
        echo -e "${YELLOW}⚠ No dependency file found for ${service_name}${NC}"
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
services=("tradovate-service" "trade-orchestrator" "monitoring-service" "signal-generator")

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

# Start services using PM2
echo -e "${YELLOW}Starting services with PM2...${NC}"

# Stop any existing PM2 processes first
pm2 delete all 2>/dev/null || true

# Start all services using ecosystem config
pm2 start "$SERVICES_DIR/ecosystem.config.cjs"

# Wait a moment for services to initialize
sleep 3

echo ""
echo -e "${GREEN}All services started with PM2!${NC}"
echo ""
echo "PM2 Commands:"
echo "  pm2 status      - View all services"
echo "  pm2 logs        - View all logs"
echo "  pm2 monit       - Real-time monitoring"
echo "  pm2 restart all - Restart all services"
echo "  pm2 stop all    - Stop all services"
echo ""
echo "Service URLs:"
echo "  Monitoring (PUBLIC): http://localhost:3014/health"
echo "  Webhook Endpoint:    http://localhost:3014/webhook"
echo "  Dashboard API:       http://localhost:3014/api/dashboard"
echo ""
echo "Internal Services (localhost only):"
echo "  Tradovate Service:  http://localhost:3011/health"
echo "  Trade Orchestrator: http://localhost:3013/health"
echo "  Signal Gen (NQ):    http://localhost:3015/health"
echo "  Signal Gen (ES):    http://localhost:3016/health"
echo ""
echo "WebSocket:           ws://localhost:3014"
echo ""
echo "Cloudflare Tunnel:"
echo "  slingshot.ereptortrading.com → localhost:3014"
echo "  Tunnel logs: pm2 logs cloudflared"
echo ""
echo "To stop all services, run: ./stop-all.sh"
echo "To view logs, check the logs/ directory"