#!/bin/bash

# Slingshot Microservices Stop Script
# This script stops all running services using PM2

echo "Stopping Slingshot Microservices..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Stop all PM2 processes
echo -e "${YELLOW}Stopping all PM2 processes...${NC}"
pm2 stop all

# Delete all PM2 processes (optional - removes them from PM2 list)
echo -e "${YELLOW}Deleting PM2 processes...${NC}"
pm2 delete all

echo ""
echo -e "${GREEN}All services stopped!${NC}"
echo ""
echo "To start services again, run: ./start-all.sh"