#!/usr/bin/env python3
"""
Intraday cumulative-PnL stop-rule analysis.

Question: if cumulative PnL through ET hour X is below threshold Y, does the
rest of the day statistically recover, or get worse?

Approach: for each session and ET hour, compute realized PnL through that hour
(sum of trades that EXITED by hour) and remaining PnL (sum of trades that
exited after). Then bucket by intraday PnL and report rest-of-day distribution.

If a (hour, threshold) bucket reliably shows negative expected rest-of-day,
that's a stop-trading rule. Reliable means n large enough AND the bad-recovery
rate beats the false-positive rate from skipping recoverable days.
"""

import csv
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from statistics import mean, median

ROOT = Path(__file__).resolve().parent.parent.parent

# ── Load trades ───────────────────────────────────────────────────────────
trades = []
with open(ROOT / 'research/4strategy-portfolio/output/A-with-lstb-trades.csv') as f:
    for row in csv.DictReader(f):
        try:
            entry = datetime.strptime(row['entryTime_et'], '%Y-%m-%d %H:%M:%S')
            exit_ = datetime.strptime(row['exitTime_et'], '%Y-%m-%d %H:%M:%S')
        except Exception:
            continue
        # Trade CSV's netPnL is already in NQ ($20/pt). The daily CSV is in
        # MNQ — different files, different units. We use trade-level NQ here.
        pnl_nq = float(row['netPnL'])
        trades.append({
            'date': entry.strftime('%Y-%m-%d'),
            'entry_hour': entry.hour,
            'exit_hour': exit_.hour,
            'exit_dt': exit_,
            'strategy': row['strategyKey'],
            'pnl': pnl_nq,
        })

# Group trades by session (date)
by_date = defaultdict(list)
for t in trades:
    by_date[t['date']].append(t)

sessions = sorted(by_date.keys())
print(f'Sessions: {len(sessions)}   Trades: {len(trades)}\n')

# ── For each session, build cumulative-realized PnL by ET hour ────────────
# We use EXIT hour for "when PnL was realized." Trades that exited at hour H
# count toward cumulative-through-H. Trades exiting after H count toward
# rest-of-day.
HOURS = list(range(0, 24))

def cum_at_or_before(day_trades, h):
    return sum(t['pnl'] for t in day_trades if t['exit_dt'].hour <= h)

def cum_after(day_trades, h):
    return sum(t['pnl'] for t in day_trades if t['exit_dt'].hour > h)

# ── Hourly bucket analysis: by hour, by PnL bucket → rest-of-day distribution ──
def fmt_money(n):
    return f'${n:,.0f}' if n >= 0 else f'-${abs(n):,.0f}'

print('═' * 90)
print('  REST-OF-DAY PNL DISTRIBUTION  given cumulative-by-hour-X is below threshold')
print('═' * 90)
print()
print('For each (ET hour, intraday PnL threshold), shows what happens in the REMAINDER of the day:')
print('  - n  = sessions matching the threshold at that hour')
print('  - rest avg/med = mean/median of remaining-day realized PnL')
print('  - pos% = pct of those sessions where rest-of-day was positive')
print('  - rec% = pct of those sessions where end-of-day was NET POSITIVE (recovered to green)')
print()
print(f'{"Hour ET":>7}  {"PnL ≤":>10}  {"n":>4}  {"rest avg":>10}  {"rest med":>10}  {"pos%":>5}  {"rec%":>5}  {"avg full-day":>13}')
print('-' * 90)

THRESHOLDS = [-5000, -3000, -2000, -1000, -500, 0]
INTRADAY_HOURS = [6, 8, 9, 10, 11, 12, 13, 14, 15]  # ET clock

for h in INTRADAY_HOURS:
    for thresh in THRESHOLDS:
        bucket = []
        for date in sessions:
            cum_through_h = cum_at_or_before(by_date[date], h)
            if cum_through_h > thresh: continue
            rest = cum_after(by_date[date], h)
            full = cum_through_h + rest
            bucket.append({'date': date, 'through_h': cum_through_h, 'rest': rest, 'full': full})
        if len(bucket) < 3:
            print(f'  {h:>5}ET  ≤ {fmt_money(thresh):>8}  {len(bucket):>4}  {"(too few)":>10}')
            continue
        rest_avg = mean(b['rest'] for b in bucket)
        rest_med = median(b['rest'] for b in bucket)
        full_avg = mean(b['full'] for b in bucket)
        pos_pct = len([b for b in bucket if b['rest'] > 0]) / len(bucket) * 100
        rec_pct = len([b for b in bucket if b['full'] > 0]) / len(bucket) * 100
        flag = ' ⚠' if rest_avg < -500 else ''
        print(f'  {h:>5}ET  ≤ {fmt_money(thresh):>8}  {len(bucket):>4}  {fmt_money(rest_avg):>10}  {fmt_money(rest_med):>10}  {pos_pct:>4.0f}%  {rec_pct:>4.0f}%  {fmt_money(full_avg):>13}{flag}')
    print()

# ── Best-case rule simulation ────────────────────────────────────────────
print('═' * 90)
print('  STOP-RULE SIMULATION')
print('═' * 90)
print()
print('If we apply the rule "stop trading by hour H if cumulative PnL ≤ threshold":')
print('  - "saved" trades: rest-of-day trades that did NOT happen')
print('  - "actual" PnL: realized PnL through hour H (kept) + any open-then-closed trades that span boundary')
print('  - simplification: we assume rule blocks all NEW entries from hour H onward, but trades open at H run to natural exit')
print('  - we cannot simulate that perfectly from this CSV (no entry/exit timing of open trades at H), so approximation:')
print('    final-with-rule = cum_through_H_inclusive  (i.e., assume everything still-running at H gets closed at H)')
print('    This is PESSIMISTIC — real "block new entries" would keep open winners running.')
print()

baseline_total = sum(sum(t['pnl'] for t in by_date[d]) for d in sessions)
print(f'Baseline (no rule): ${baseline_total:,.0f} over {len(sessions)} sessions')
print()

print(f'{"Hour ET":>7}  {"PnL ≤":>10}  {"# blocked":>10}  {"rule total":>12}  {"vs baseline":>12}  {"per-day":>8}')
print('-' * 80)
for h in INTRADAY_HOURS:
    for thresh in THRESHOLDS:
        rule_total = 0
        n_blocked = 0
        for d in sessions:
            cum = cum_at_or_before(by_date[d], h)
            full = sum(t['pnl'] for t in by_date[d])
            if cum <= thresh:
                # Rule fires — keep only cum_through_h, blockall rest.
                rule_total += cum
                n_blocked += 1
            else:
                rule_total += full
        delta = rule_total - baseline_total
        flag = ' ✓' if delta > 0 else ''
        print(f'  {h:>5}ET  ≤ {fmt_money(thresh):>8}  {n_blocked:>10}  {fmt_money(rule_total):>12}  {fmt_money(delta):>12}  {fmt_money(delta/len(sessions)):>8}{flag}')
    print()
