#!/usr/bin/env python3
"""
V1-02-daily-atr.py — independent daily RTH bars + ATR14 from raw NQ 1m CSV.

Streams data/ohlcv/nq/NQ_ohlcv_1m.csv (starts 2020-12-27, ends 2026-06-15).
Own primary-contract selection: drop calendar-spread symbols ('-'), per ET
clock-hour keep the highest-volume symbol, RTH only (09:30-16:00 ET).

Daily RTH bar: open = first minute bar of the 09:xx primary at/after 09:30;
high/low = extremes over each hour's primary bars; close = last primary bar
before 16:00. roll_rth = 1 if the per-hour primary changes across ET hours
9..15 within the day.

ATR14 variants (all SMA of the last 14 TRs; value stored on day D is the ATR
KNOWABLE at D's 09:30, i.e. computed from TRs of days <= D-1):
  atr_hl    : TR = high - low
  atr_tr    : TR = max(h-l, |h-pc|, |l-pc|), naive prev close across rolls
  atr_trr   : same, but TR falls back to h-l when the day's primary symbol
              differs from the previous day's (roll-safe)
Also atr_tr_wilder (Wilder RMA) as a sensitivity.

Output CSV: v1_daily.csv
  date,sym,open,high,low,close,roll_rth,n_hours,atr_hl,atr_tr,atr_trr,atr_tr_wilder,n_atr_obs_prior
n_atr_obs_prior counts strictly-prior days with atr_tr defined (for the
"trailing tercile knowable, min 60 obs" eligibility test).
"""
import time
from zoneinfo import ZoneInfo
from datetime import datetime, timezone

SRC = "/home/drew/projects/slingshot-services/backtest-engine/data/ohlcv/nq/NQ_ohlcv_1m.csv"
OUT = "/home/drew/projects/slingshot-services/backtest-engine/greenfield/verify/v1_daily.csv"
ET = ZoneInfo("America/New_York")
RTH_START = 9*3600+30*60
RTH_END = 16*3600

def et_offset_seconds(date_utc_str):
    y, m, d = int(date_utc_str[:4]), int(date_utc_str[5:7]), int(date_utc_str[8:10])
    return int(datetime(y, m, d, 17, 0, tzinfo=timezone.utc).astimezone(ET).utcoffset().total_seconds())

def main():
    t0 = time.time()
    hour_ok = {"13","14","15","16","17","18","19","20","21"}
    # day -> sym -> hour -> [vol, first_sec, first_open, last_sec, last_close, high, low]
    days = {}
    cur_date, off = None, None
    with open(SRC, "r", buffering=1024*1024*8) as f:
        f.readline()
        for line in f:
            if line[11:13] not in hour_ok:
                continue
            dstr = line[:10]
            if dstr != cur_date:
                cur_date, off = dstr, et_offset_seconds(dstr)
            et_sec = int(line[11:13])*3600 + int(line[14:16])*60 + int(line[17:19]) + off
            if et_sec < RTH_START or et_sec >= RTH_END:
                continue
            p = line.split(",")
            sym = p[9].strip()
            if "-" in sym or not sym:
                continue
            try:
                o, h, l, c, v = float(p[4]), float(p[5]), float(p[6]), float(p[7]), int(p[8])
            except ValueError:
                continue
            hr = et_sec // 3600
            rec = days.setdefault(dstr, {}).setdefault(sym, {})
            cell = rec.get(hr)
            if cell is None:
                rec[hr] = [v, et_sec, o, et_sec, c, h, l]
            else:
                cell[0] += v
                if et_sec < cell[1]:
                    cell[1], cell[2] = et_sec, o
                if et_sec > cell[3]:
                    cell[3], cell[4] = et_sec, c
                if h > cell[5]: cell[5] = h
                if l < cell[6]: cell[6] = l
    print(f"parsed {len(days)} days in {time.time()-t0:.0f}s")

    rows = []
    for dstr in sorted(days):
        syms = days[dstr]
        # per-hour primary by volume
        hours = sorted({hr for s in syms.values() for hr in s})
        prim = {}
        for hr in hours:
            best, bv = None, -1
            for sym, rec in syms.items():
                if hr in rec and rec[hr][0] > bv:
                    best, bv = sym, rec[hr][0]
            prim[hr] = best
        rth_hours = [h for h in hours if 9 <= h <= 15]
        if not rth_hours:
            continue
        prims = [prim[h] for h in rth_hours]
        roll = int(len(set(prims)) > 1)
        first_h, last_h = rth_hours[0], rth_hours[-1]
        o = syms[prim[first_h]][first_h][2]
        c = syms[prim[last_h]][last_h][4]
        hi = max(syms[prim[h]][h][5] for h in rth_hours)
        lo = min(syms[prim[h]][h][6] for h in rth_hours)
        # day primary = highest total RTH volume symbol (for roll-vs-prev detection)
        day_sym = max(syms, key=lambda s: sum(v[0] for v in syms[s].values()))
        rows.append([dstr, day_sym, o, hi, lo, c, roll, len(rth_hours)])

    # ATR variants: knowable-at-09:30 = SMA/RMA over TRs of days <= D-1
    tr_hl, tr_tr, tr_trr = [], [], []
    out = []
    prev_close, prev_sym = None, None
    wilder = None
    for i, (dstr, sym, o, hi, lo, c, roll, nh) in enumerate(rows):
        # knowable ATRs BEFORE ingesting today's TR
        def sma(lst):
            return sum(lst[-14:]) / 14 if len(lst) >= 14 else ""
        a_hl, a_tr, a_trr = sma(tr_hl), sma(tr_tr), sma(tr_trr)
        a_w = wilder if wilder is not None else ""
        n_obs = max(0, len(tr_tr) - 13)  # strictly-prior days with ATR14(tr) defined
        out.append([dstr, sym, o, hi, lo, c, roll, nh, a_hl, a_tr, a_trr, a_w, n_obs])
        # ingest today's TR
        t_hl = hi - lo
        if prev_close is None:
            t_tr = t_hl
            t_trr = t_hl
        else:
            t_tr = max(t_hl, abs(hi - prev_close), abs(lo - prev_close))
            t_trr = t_tr if sym == prev_sym else t_hl
        tr_hl.append(t_hl); tr_tr.append(t_tr); tr_trr.append(t_trr)
        if wilder is None:
            if len(tr_tr) == 14:
                wilder = sum(tr_tr) / 14
        else:
            wilder = (wilder * 13 + t_tr) / 14
        prev_close, prev_sym = c, sym

    with open(OUT, "w") as f:
        f.write("date,sym,open,high,low,close,roll_rth,n_hours,atr_hl,atr_tr,atr_trr,atr_tr_wilder,n_atr_obs_prior\n")
        for r in out:
            f.write(",".join(str(x) for x in r) + "\n")
    print(f"wrote {len(out)} daily rows -> {OUT} ({time.time()-t0:.0f}s)")

if __name__ == "__main__":
    main()
