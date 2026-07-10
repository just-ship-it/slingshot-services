#!/usr/bin/env python3
"""Build weekly OHLC series from 1m OHLCV CSVs for report scoring.

ETFs (QQQ, SPY): straight aggregation of all rows.
Futures (NQ, ES): per-hour volume-primary contract (mirrors filterPrimaryContract),
calendar-spread rows (symbol contains '-') dropped. Weekly hi/lo is taken from the
contract that was primary in the FIRST hour of the week (levels quoted Sunday refer
to that contract), so roll weeks don't mix price spaces.

Output: weekly/<SYM>_weekly.csv with columns
  week_monday,open,high,low,close,n_bars,symbol
week_monday = ISO date of that week's Monday (weeks are Mon..Fri by trade date,
using the bar's UTC date shifted so Sunday-evening Globex bars belong to Monday).
"""

import csv
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

BASE = Path("/home/drew/projects/slingshot-services/backtest-engine/data/ohlcv")
OUT = Path(__file__).parent / "weekly"
OUT.mkdir(exist_ok=True)

FILES = {
    "QQQ": (BASE / "qqq/QQQ_ohlcv_1m.csv", False),
    "SPY": (BASE / "spy/SPY_ohlcv_1m.csv", False),
    "NQ": (BASE / "nq/NQ_ohlcv_1m.csv", True),
    "ES": (BASE / "es/ES_ohlcv_1m.csv", True),
}

START = "2023-04-01"  # a bit before the first report


def trade_date(ts: str):
    """UTC timestamp -> effective trade date. Globex Sunday-evening (>=22:00 UTC
    Sunday) counts as Monday's session; likewise any day's >=22:00 rolls forward."""
    d = date.fromisoformat(ts[:10])
    hour = int(ts[11:13])
    if hour >= 22:
        d += timedelta(days=1)
    return d


def week_monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def aggregate(sym, path, is_futures):
    # pass 1 (futures only): hourly volume by contract
    hour_primary = {}
    if is_futures:
        hourly = defaultdict(lambda: defaultdict(float))
        with open(path) as f:
            r = csv.reader(f)
            header = next(r)
            ci = {c: i for i, c in enumerate(header)}
            ncols = len(header)
            for row in r:
                if len(row) < ncols:
                    continue
                ts = row[ci["ts_event"]]
                if ts < START:
                    continue
                symcol = row[ci["symbol"]]
                if "-" in symcol:
                    continue
                hourly[ts[:13]][symcol] += float(row[ci["volume"]])
        hour_primary = {h: max(v, key=v.get) for h, v in hourly.items()}

    # pass 2: weekly OHLC
    weeks = {}
    with open(path) as f:
        r = csv.reader(f)
        header = next(r)
        ci = {c: i for i, c in enumerate(header)}
        ncols = len(header)
        for row in r:
            if len(row) < ncols:
                continue
            ts = row[ci["ts_event"]]
            if ts < START:
                continue
            symcol = row[ci["symbol"]]
            if is_futures:
                if "-" in symcol or hour_primary.get(ts[:13]) != symcol:
                    continue
            d = trade_date(ts)
            if d.weekday() >= 5:  # Sat (rare data noise)
                continue
            wk = week_monday(d)
            o, h, l, c = (float(row[ci[k]]) for k in ("open", "high", "low", "close"))
            w = weeks.get(wk)
            if w is None:
                # week_contract: primary contract at first bar of week
                weeks[wk] = {"open": o, "high": h, "low": l, "close": c,
                             "n": 1, "sym": symcol, "last_ts": ts}
            else:
                if is_futures and symcol != w["sym"]:
                    continue  # stay in the Monday-primary contract's price space
                w["high"] = max(w["high"], h)
                w["low"] = min(w["low"], l)
                if ts >= w["last_ts"]:
                    w["close"], w["last_ts"] = c, ts
                w["n"] += 1

    out = OUT / f"{sym}_weekly.csv"
    with open(out, "w", newline="") as f:
        wtr = csv.writer(f)
        wtr.writerow(["week_monday", "open", "high", "low", "close", "n_bars", "symbol"])
        for wk in sorted(weeks):
            w = weeks[wk]
            wtr.writerow([wk.isoformat(), w["open"], w["high"], w["low"],
                          w["close"], w["n"], w["sym"]])
    print(f"{sym}: {len(weeks)} weeks -> {out.name}")


for sym, (path, fut) in FILES.items():
    aggregate(sym, path, fut)
