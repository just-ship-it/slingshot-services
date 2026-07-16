#!/usr/bin/env python3
"""Per-entry-hour (ET) edge analysis for LSTB backtest JSONs.

Usage: python3 analyze-hours.py <backtest.json> [--periods]

For each ET entry hour: n, WR, PF, net PnL, avg/trade, t-stat, and
per-period (H2'23 / 2024 / 2025 / 2026) sign stability. Then a marginal
leave-one-hour-out table: book PnL / daily Sharpe / maxDD with that hour's
trades removed (approximation — slot interactions ignored; confirm any
candidate block with a real engine rerun).
"""
import json, sys, math
from collections import defaultdict
from datetime import datetime
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")

def load(path):
    d = json.load(open(path))
    trades = [t for t in d["trades"] if t.get("status") == "completed" and t.get("netPnL") is not None]
    return d, trades

def et_dt(ms):
    return datetime.fromtimestamp(ms / 1000, tz=ET)

def period_of(dt):
    if dt.year == 2023: return "2023H2"
    return str(dt.year)

def pf(pnls):
    g = sum(p for p in pnls if p > 0); l = -sum(p for p in pnls if p < 0)
    return g / l if l > 0 else float("inf")

def tstat(pnls):
    n = len(pnls)
    if n < 2: return 0.0
    m = sum(pnls) / n
    var = sum((p - m) ** 2 for p in pnls) / (n - 1)
    return m / math.sqrt(var / n) if var > 0 else 0.0

def daily_series(trades, skip_hour=None):
    days = defaultdict(float)
    for t in trades:
        dt = et_dt(t["entryTime"])
        if skip_hour is not None and dt.hour == skip_hour: continue
        days[dt.strftime("%Y-%m-%d")] += t["netPnL"]
    return [days[k] for k in sorted(days)]

def sharpe_dd(daily):
    n = len(daily)
    if n < 2: return 0.0, 0.0
    m = sum(daily) / n
    var = sum((x - m) ** 2 for x in daily) / (n - 1)
    sh = m / math.sqrt(var) * math.sqrt(252) if var > 0 else 0.0
    eq = peak = dd = 0.0
    for x in daily:
        eq += x
        peak = max(peak, eq)
        dd = max(dd, peak - eq)
    return sh, dd

def main(path):
    d, trades = load(path)
    print(f"{path}: {len(trades)} completed trades, "
          f"{d['config']['startDate'][:10]} → {d['config']['endDate'][:10]}")
    total = sum(t["netPnL"] for t in trades)
    base_sh, base_dd = sharpe_dd(daily_series(trades))
    print(f"TOTAL net ${total:,.0f} | PF {pf([t['netPnL'] for t in trades]):.2f} | "
          f"daily Sharpe {base_sh:.2f} | maxDD ${base_dd:,.0f}\n")

    byhour = defaultdict(list); byhp = defaultdict(lambda: defaultdict(list))
    for t in trades:
        dt = et_dt(t["entryTime"])
        byhour[dt.hour].append(t["netPnL"])
        byhp[dt.hour][period_of(dt)].append(t["netPnL"])

    periods = ["2023H2", "2024", "2025", "2026"]
    print(f"{'hr':>3} {'n':>5} {'WR%':>5} {'PF':>5} {'net$':>9} {'avg$':>7} {'t':>6}  " +
          " ".join(f"{p:>8}" for p in periods) + "  sign-consistency")
    for h in sorted(byhour):
        p = byhour[h]
        wr = 100 * sum(1 for x in p if x > 0) / len(p)
        cells, signs = [], []
        for per in periods:
            pp = byhp[h].get(per)
            if pp:
                s = sum(pp); cells.append(f"{s:>8,.0f}"); signs.append(s > 0)
            else:
                cells.append(f"{'—':>8}")
        cons = f"{sum(signs)}/{len(signs)}+" if signs else "—"
        print(f"{h:>3} {len(p):>5} {wr:>5.1f} {pf(p):>5.2f} {sum(p):>9,.0f} "
              f"{sum(p)/len(p):>7.1f} {tstat(p):>6.2f}  " + " ".join(cells) + f"  {cons}")

    print("\nLEAVE-ONE-HOUR-OUT (marginal effect of blocking each hour):")
    print(f"{'hr':>3} {'ΔPnL$':>9} {'PF→':>6} {'Sharpe→':>8} {'ΔSh':>6} {'maxDD→$':>9} {'ΔDD$':>8}")
    for h in sorted(byhour):
        rest = [t["netPnL"] for t in trades if et_dt(t["entryTime"]).hour != h]
        sh, dd = sharpe_dd(daily_series(trades, skip_hour=h))
        print(f"{h:>3} {sum(byhour[h]):>9,.0f} {pf(rest):>6.2f} {sh:>8.2f} "
              f"{sh-base_sh:>+6.2f} {dd:>9,.0f} {dd-base_dd:>+8,.0f}")

if __name__ == "__main__":
    main(sys.argv[1])
