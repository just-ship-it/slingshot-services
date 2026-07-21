#!/usr/bin/env python3
"""
V1-05-atr-fullsession.py — full-session (Globex) daily ATR14 variant, from raw 1m.

Session = 18:00 ET prev calendar day -> 17:00 ET trade date (bars stamped
>= 18:00 ET map to the next calendar date). Primary contract = highest
total-session-volume non-spread symbol. TR variants as in V1-02:
  fs_tr  : max(h-l, |h-pc|, |l-pc|) naive across rolls
  fs_trr : roll-safe (h-l when primary symbol changed vs prior session)
  fs_hl  : h-l
ATR14 on day D = SMA of TRs of sessions <= D-1 (knowable before 09:30 of D,
since session D-1 ended 17:00 ET the prior day).

Appends columns to v1_daily.csv -> v1_daily_fs.csv (joined on trade date).
"""
import csv, time
from zoneinfo import ZoneInfo
from datetime import datetime, timezone, date, timedelta

SRC = "/home/drew/projects/slingshot-services/backtest-engine/data/ohlcv/nq/NQ_ohlcv_1m.csv"
BASE = "/home/drew/projects/slingshot-services/backtest-engine/greenfield/verify/v1_daily.csv"
OUT = "/home/drew/projects/slingshot-services/backtest-engine/greenfield/verify/v1_daily_fs.csv"
ET = ZoneInfo("America/New_York")

def main():
    t0 = time.time()
    sess = {}  # trade_date -> sym -> [vol, first_ts, o, last_ts, c, hi, lo]
    off_cache = {}
    with open(SRC, "r", buffering=1024*1024*8) as f:
        f.readline()
        for line in f:
            if len(line) < 30 or line[4] != "-":
                continue
            dstr = line[:10]
            off = off_cache.get(dstr)
            if off is None:
                y, m, d = int(dstr[:4]), int(dstr[5:7]), int(dstr[8:10])
                off = int(datetime(y, m, d, 12, 0, tzinfo=timezone.utc)
                          .astimezone(ET).utcoffset().total_seconds())
                off_cache[dstr] = off
            utc_sec = int(line[11:13])*3600 + int(line[14:16])*60 + int(line[17:19])
            et_sec = utc_sec + off
            d0 = date(int(dstr[:4]), int(dstr[5:7]), int(dstr[8:10]))
            if et_sec < 0:
                et_d = d0 - timedelta(days=1); et_s = et_sec + 86400
            elif et_sec >= 86400:
                et_d = d0 + timedelta(days=1); et_s = et_sec - 86400
            else:
                et_d = d0; et_s = et_sec
            if et_s >= 17*3600:
                if et_s < 18*3600:
                    continue  # maintenance window edge
                trade_d = et_d + timedelta(days=1)
            else:
                trade_d = et_d
            if trade_d.weekday() >= 5:  # Sat (Fri-evening artifacts) -> skip
                continue
            p = line.split(",")
            sym = p[9].strip()
            if "-" in sym or not sym:
                continue
            try:
                o, h, l, c, v = float(p[4]), float(p[5]), float(p[6]), float(p[7]), int(p[8])
            except ValueError:
                continue
            ts = (dstr, utc_sec)
            rec = sess.setdefault(trade_d, {})
            cell = rec.get(sym)
            if cell is None:
                rec[sym] = [v, ts, o, ts, c, h, l]
            else:
                cell[0] += v
                if ts < cell[1]: cell[1], cell[2] = ts, o
                if ts > cell[3]: cell[3], cell[4] = ts, c
                if h > cell[5]: cell[5] = h
                if l < cell[6]: cell[6] = l
    print(f"parsed {len(sess)} sessions in {time.time()-t0:.0f}s")

    rows = []
    for td in sorted(sess):
        rec = sess[td]
        sym = max(rec, key=lambda s: rec[s][0])
        v, _, o, _, c, h, l = rec[sym]
        rows.append([td.isoformat(), sym, o, h, l, c])

    tr_n, tr_r, tr_h = [], [], []
    fs = {}
    prev_c, prev_sym = None, None
    for dstr, sym, o, h, l, c in rows:
        def sma(lst):
            return sum(lst[-14:]) / 14 if len(lst) >= 14 else ""
        fs[dstr] = (sma(tr_n), sma(tr_r), sma(tr_h), max(0, len(tr_n) - 13))
        t_h = h - l
        if prev_c is None:
            t_naive = t_h; t_roll = t_h
        else:
            t_naive = max(t_h, abs(h - prev_c), abs(l - prev_c))
            t_roll = t_naive if sym == prev_sym else t_h
        tr_n.append(t_naive); tr_r.append(t_roll); tr_h.append(t_h)
        prev_c, prev_sym = c, sym

    with open(BASE) as f:
        base_rows = list(csv.DictReader(f))
        fields = list(base_rows[0].keys())
    add = ["atr_fs_tr", "atr_fs_trr", "atr_fs_hl", "n_fs_obs_prior"]
    with open(OUT, "w") as f:
        f.write(",".join(fields + add) + "\n")
        for r in base_rows:
            e = fs.get(r["date"], ("", "", "", 0))
            f.write(",".join([r[k] for k in fields] + [str(e[0]), str(e[1]), str(e[2]), str(e[3])]) + "\n")
    print(f"wrote {OUT} ({time.time()-t0:.0f}s)")

if __name__ == "__main__":
    main()
