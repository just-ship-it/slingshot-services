#!/bin/bash
cd /home/drew/projects/slingshot-services/backtest-engine
for lag in 60000 120000 180000 300000; do
  LS_LAG_MS=$lag SHORT_STATE=0 python3 research/dealer-reaction/04-state-machine.py full >/dev/null 2>&1
  cp research/dealer-reaction/fsm_full.csv research/dealer-reaction/fsm_lag${lag}.csv
  echo "lag ${lag} done"
done
echo LAGDONE
