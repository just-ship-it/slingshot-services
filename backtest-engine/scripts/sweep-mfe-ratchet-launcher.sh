#!/bin/bash
# Wait for any other "node index" backtests to finish, then launch the sweep.
# Keeps total backtest parallelism within the 2-process ceiling.

set -u
cd "$(dirname "$0")/.."

LOG=/home/drew/projects/slingshot-services/backtest-engine/research/mfe-ratchet-gfi/sweep.log
mkdir -p "$(dirname "$LOG")"

OTHER_PIDS=$(ps -ef | grep "node index" | grep -v grep | awk '{print $2}' | tr '\n' ' ')
if [ -n "$OTHER_PIDS" ]; then
  echo "[$(date '+%H:%M:%S')] Waiting for other node-index processes to clear: $OTHER_PIDS" >> "$LOG"
fi

while true; do
  count=$(ps -ef | grep "node index" | grep -v grep | grep -v "sweep-mfe-ratchet" | wc -l)
  if [ "$count" -eq 0 ]; then
    break
  fi
  sleep 30
done

echo "[$(date '+%H:%M:%S')] CPU clear. Launching sweep." >> "$LOG"
exec node scripts/sweep-mfe-ratchet-gfi.js >> "$LOG" 2>&1
