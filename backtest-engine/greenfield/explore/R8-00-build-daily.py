#!/usr/bin/env python3
"""
R8-00: Build a daily + intraday-marks panel from the primary-contract 1m cache,
for the DOWNSIDE/short-edge census (R8).

Reads:  greenfield/explore/cache/{PROD}_1m_primary.csv  (shared, read-only)
Writes: greenfield/explore/R8_{PROD}_daily.csv

Per ET trade_date we record:
  - year, dow
  - rth symbol + prior-rth symbol -> roll_day flag (gap/day-over-day invalid across roll)
  - prior_rth_close, rth_open(0930), rth_close(1600), rth_high, rth_low, rth_high_min, rth_low_min
  - overnight (prior 16:00 -> today 09:30) via prior_rth_close and rth_open
  - atr14_prior : 14-day SMA of RTH daily true range, using ONLY prior days (causal)
  - intraday marks: close price at a set of ET minutes (at-or-before within the day)
  - convenience returns (points): gap, on_ret is folded into gap here (prior close->open)

Snapshot minutes captured (ET HHMM): 0930 1000 1030 1100 1130 1200 1230 1300
  1330 1400 1430 1500 1515 1530 1545 1600

All prices are RAW primary-contract (points). Returns are in points.
Rollovers: roll_day=1 when today's RTH symbol != prior RTH day's symbol; those
days are excluded from gap / day-over-day tests by consumers.
"""
import csv, os, sys

PROD = (sys.argv[1] if len(sys.argv) > 1 else "NQ").upper()
BASE = "/home/drew/projects/slingshot-services/backtest-engine"
SRC = f"{BASE}/greenfield/explore/cache/{PROD}_1m_primary.csv"
OUT = f"{BASE}/greenfield/explore/R8_{PROD}_daily.csv"

MARKS = ["0930","1000","1030","1100","1130","1200","1230","1300",
         "1330","1400","1430","1500","1515","1530","1545","1600"]

def hhmm_int(s): return int(s)

# RTH window: 0930 <= hhmm <= 1600
def is_rth(hhmm):
    h = int(hhmm)
    return 930 <= h <= 1600

def main():
    # group rows by et_date
    # we stream; rows are chronological. Accumulate per-day RTH info.
    days = {}   # et_date -> dict
    order = []
    with open(SRC, newline="") as f:
        rdr = csv.reader(f)
        header = next(rdr)
        idx = {k:i for i,k in enumerate(header)}
        iD,iM,iDow,iO,iH,iL,iC,iV,iS = (idx[k] for k in
            ("et_date","et_hhmm","dow","o","h","l","c","v","symbol"))
        for row in rdr:
            et_date = row[iD]; hhmm = row[iM]
            if not is_rth(hhmm):
                continue
            o=float(row[iO]); h=float(row[iH]); l=float(row[iL]); c=float(row[iC])
            v=int(row[iV]); sym=row[iS]
            d = days.get(et_date)
            if d is None:
                d = {"dow":int(row[iDow]),"year":int(et_date[:4]),
                     "sym_first":sym,"sym_last":sym,
                     "rth_high":h,"rth_low":l,"rth_high_min":hhmm,"rth_low_min":hhmm,
                     "rth_vol":0,"marks":{},"first_c":c,"last_c":c}
                days[et_date]=d; order.append(et_date)
            if h>d["rth_high"]:
                d["rth_high"]=h; d["rth_high_min"]=hhmm
            if l<d["rth_low"]:
                d["rth_low"]=l; d["rth_low_min"]=hhmm
            d["rth_vol"]+=v
            d["sym_last"]=sym
            d["last_c"]=c
            # store mark = close at this minute (last write wins -> at exact minute)
            if hhmm in MARKS:
                d["marks"][hhmm]=c
    # forward-fill marks (at-or-before) within each day and compute derived
    prev_date=None; prev_close=None; prev_sym=None
    tr_hist=[]  # list of prior true ranges (RTH daily)
    rows_out=[]
    for et_date in order:
        d=days[et_date]
        # forward-fill marks at-or-before across the ordered MARKS list
        marks=d["marks"]; last=None; ff={}
        for m in MARKS:
            if m in marks: last=marks[m]
            ff[m]=last
        rth_open = ff.get("0930")
        rth_close = ff.get("1600")
        if rth_open is None or rth_close is None:
            # incomplete session; skip but keep chain via prev
            continue
        roll_day = 1 if (prev_sym is not None and d["sym_first"]!=prev_sym) else 0
        # ATR14 prior (causal): SMA of last 14 prior TRs
        atr14 = (sum(tr_hist[-14:])/14.0) if len(tr_hist)>=14 else ""
        # gap / day-over-day only valid if not roll and have prev_close
        if prev_close is not None and roll_day==0:
            gap = rth_open - prev_close
        else:
            gap = ""
        rth_ret = rth_close - rth_open
        rec={"trade_date":et_date,"year":d["year"],"dow":d["dow"],
             "roll_day":roll_day,"atr14_prior":atr14,
             "prior_rth_close":(prev_close if prev_close is not None else ""),
             "gap":gap,"rth_open":rth_open,"rth_close":rth_close,
             "rth_high":d["rth_high"],"rth_low":d["rth_low"],
             "rth_high_min":d["rth_high_min"],"rth_low_min":d["rth_low_min"],
             "rth_vol":d["rth_vol"],"rth_ret":rth_ret,
             "prior_sym":(prev_sym if prev_sym else ""),"sym":d["sym_last"]}
        for m in MARKS:
            rec[f"p{m}"]=ff[m]
        rows_out.append(rec)
        # update chain + TR history (RTH daily true range)
        if prev_close is not None and roll_day==0:
            tr = max(d["rth_high"]-d["rth_low"],
                     abs(d["rth_high"]-prev_close),
                     abs(d["rth_low"]-prev_close))
        else:
            tr = d["rth_high"]-d["rth_low"]
        tr_hist.append(tr)
        prev_close=rth_close; prev_sym=d["sym_last"]; prev_date=et_date
    # write
    cols=["trade_date","year","dow","roll_day","atr14_prior","prior_rth_close","gap",
          "rth_open","rth_close","rth_high","rth_low","rth_high_min","rth_low_min",
          "rth_vol","rth_ret","prior_sym","sym"]+[f"p{m}" for m in MARKS]
    with open(OUT,"w",newline="") as fo:
        w=csv.DictWriter(fo,fieldnames=cols); w.writeheader()
        for r in rows_out: w.writerow(r)
    print(f"{PROD}: {len(rows_out)} RTH days -> {OUT}")

if __name__=="__main__":
    main()
