#!/usr/bin/env python3
"""LT-level magnet race study (Phase 1).

At each sample time t: spot = last 1m close (raw, primary contract). Take the
nearest LT level above and below spot (levels known at t — no lookahead). Walk
1m bars forward until the first of the two levels is TOUCHED (high>=up or
low<=down). Record winner, distances, sentiment, level ranks, time-to-touch.
Races are censored at contract rollover, data end, or a horizon.

Fair-random-walk baseline: P(up first) = d_down / (d_up + d_down)  (gambler's ruin).
Edge = systematic deviation from that, and feature-conditional deviations.

LT timestamps are America/New_York; OHLCV is UTC.
Usage: lt-magnet-race.py NQ|ES15|ES1H|ES1D
"""

import csv
import sys
import numpy as np
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = Path("/home/drew/projects/slingshot-services/backtest-engine/data")
HERE = Path(__file__).parent
OUT = HERE / "races"
OUT.mkdir(exist_ok=True)

ET = ZoneInfo("America/New_York")

CFG = {
    "NQ":   dict(lt=BASE / "liquidity/nq/NQ_liquidity_levels.csv",
                 ohlcv=BASE / "ohlcv/nq/NQ_ohlcv_1m.csv",
                 sample_every=4,   # 15m rows -> hourly samples
                 horizon_bars=4200),   # ~3 trading days
    "ES15": dict(lt=BASE / "liquidity/es/ES_liquidity_levels_15m.csv",
                 ohlcv=BASE / "ohlcv/es/ES_ohlcv_1m.csv",
                 sample_every=4, horizon_bars=4200),
    "ES1H": dict(lt=BASE / "liquidity/es/ES_liquidity_levels_1h.csv",
                 ohlcv=BASE / "ohlcv/es/ES_ohlcv_1m.csv",
                 sample_every=1, horizon_bars=14000),  # ~10 trading days
    "ES1D": dict(lt=BASE / "liquidity/es/ES_liquidity_levels_1D.csv",
                 ohlcv=BASE / "ohlcv/es/ES_ohlcv_1m.csv",
                 sample_every=1, horizon_bars=56000),  # ~40 trading days
}

MIN_DIST_PCT = 0.05   # ignore levels within 0.05% of spot
MAX_DIST_PCT = 8.0    # ignore absurdly far levels (bad data guard)


def load_bars(path):
    """1m raw bars, per-hour volume-primary contract, spreads dropped.
    Returns (ts_ns int64 array, high, low, close float arrays, sym list,
    roll_bound: for each i the first index >= i where symbol changes)."""
    from collections import defaultdict
    hourly = defaultdict(lambda: defaultdict(float))
    with open(path) as f:
        r = csv.reader(f)
        header = next(r)
        ci = {c: i for i, c in enumerate(header)}
        nc = len(header)
        for row in r:
            if len(row) < nc:
                continue
            sym = row[ci["symbol"]]
            if "-" in sym:
                continue
            hourly[row[ci["ts_event"]][:13]][sym] += float(row[ci["volume"]])
    primary = {h: max(v, key=v.get) for h, v in hourly.items()}

    ts, hi, lo, cl, syms = [], [], [], [], []
    with open(path) as f:
        r = csv.reader(f)
        header = next(r)
        ci = {c: i for i, c in enumerate(header)}
        nc = len(header)
        for row in r:
            if len(row) < nc:
                continue
            sym = row[ci["symbol"]]
            t = row[ci["ts_event"]]
            if "-" in sym or primary.get(t[:13]) != sym:
                continue
            ts.append(np.datetime64(t[:19]).astype("datetime64[s]").astype(np.int64))
            hi.append(float(row[ci["high"]]))
            lo.append(float(row[ci["low"]]))
            cl.append(float(row[ci["close"]]))
            syms.append(sym)
    ts = np.array(ts, dtype=np.int64)
    order = np.argsort(ts, kind="stable")
    ts, hi, lo, cl = ts[order], np.array(hi)[order], np.array(lo)[order], np.array(cl)[order]
    syms = [syms[i] for i in order]
    n = len(ts)
    roll_bound = np.empty(n, dtype=np.int64)
    nxt = n
    for i in range(n - 1, -1, -1):
        if i < n - 1 and syms[i] != syms[i + 1]:
            nxt = i + 1
        roll_bound[i] = nxt
    return ts, hi, lo, cl, syms, roll_bound


def et_to_utc_epoch(dt_str):
    d = datetime.strptime(dt_str, "%Y-%m-%d %H:%M:%S").replace(tzinfo=ET)
    return int(d.timestamp())


def run(name):
    cfg = CFG[name]
    ts, hi, lo, cl, syms, roll_bound = load_bars(cfg["ohlcv"])
    print(f"{name}: {len(ts)} primary 1m bars "
          f"({np.datetime64(int(ts[0]),'s')} .. {np.datetime64(int(ts[-1]),'s')})")

    races = []
    with open(cfg["lt"]) as f:
        rows = list(csv.DictReader(f))
    for k, row in enumerate(rows):
        if k % cfg["sample_every"]:
            continue
        try:
            t_utc = et_to_utc_epoch(row["datetime"])
        except ValueError:
            continue
        levels = []
        for j in range(1, 6):
            v = row.get(f"level_{j}", "")
            try:
                levels.append((float(v), j))
            except ValueError:
                pass
        if len(levels) < 2:
            continue
        i = int(np.searchsorted(ts, t_utc, side="right")) - 1
        if i < 0 or i + 1 >= len(ts) or t_utc - ts[i] > 1200:  # market closed / no data
            continue
        spot = cl[i]
        ups = [(v, j) for v, j in levels if MIN_DIST_PCT / 100 * spot < v - spot < MAX_DIST_PCT / 100 * spot]
        dns = [(v, j) for v, j in levels if MIN_DIST_PCT / 100 * spot < spot - v < MAX_DIST_PCT / 100 * spot]
        if not ups or not dns:
            continue
        up, up_rank = min(ups)
        dn, dn_rank = max(dns)

        start = i + 1
        end = int(min(start + cfg["horizon_bars"], roll_bound[start], len(ts)))
        winner, tt = "censored", None
        censor = "roll" if roll_bound[start] < start + cfg["horizon_bars"] else "horizon"
        step = 512
        for s in range(start, end, step):
            e = min(s + step, end)
            uh = hi[s:e] >= up
            dl = lo[s:e] <= dn
            any_u, any_d = uh.any(), dl.any()
            if not (any_u or any_d):
                continue
            iu = int(np.argmax(uh)) if any_u else 10**9
            idn = int(np.argmax(dl)) if any_d else 10**9
            if iu == idn:
                winner, tt = "ambiguous", (s + iu - start)
            elif iu < idn:
                winner, tt = "up", (s + iu - start)
            else:
                winner, tt = "down", (s + idn - start)
            break
        if winner == "censored" and end == len(ts):
            censor = "data_end"

        races.append({
            "t_et": row["datetime"], "spot": round(spot, 2),
            "up": up, "dn": dn,
            "d_up_pct": round((up - spot) / spot * 100, 3),
            "d_dn_pct": round((spot - dn) / spot * 100, 3),
            "p_up_fair": round((spot - dn) / (up - dn), 4),
            "up_rank": up_rank, "dn_rank": dn_rank,
            "sentiment": row.get("sentiment", ""),
            "hour_et": row["datetime"][11:13],
            "winner": winner, "bars_to_touch": tt,
            "censor": censor if winner == "censored" else "",
            "symbol": syms[i],
        })
    out = OUT / f"races_{name}.csv"
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(races[0].keys()))
        w.writeheader()
        w.writerows(races)
    res = [r for r in races if r["winner"] in ("up", "down")]
    print(f"  {len(races)} races -> {len(res)} resolved "
          f"({sum(1 for r in races if r['winner']=='ambiguous')} ambiguous, "
          f"{sum(1 for r in races if r['winner']=='censored')} censored) -> {out.name}")


if __name__ == "__main__":
    for name in (sys.argv[1:] or ["NQ"]):
        run(name)
