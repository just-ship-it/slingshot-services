#!/usr/bin/env python3
"""Plan an exact Databento MBO purchase: which raw symbols, which date slices, what it costs.

Requesting the `NQ` PARENT pulls every contract + calendar spreads (~39% waste — the
strategy uses front month only). Requesting BOTH front symbols across the WHOLE window is
just as wasteful, because each is the deferred month for half the window. The fix is
DATE-SLICED per-symbol requests, which this script generates.

Anchored on the real portal quote 2026-08-22:
    NQ parent, 2026-05-22..2026-08-21 = 105.1 GB over 82 sessions = $176.12 @ $1.80/GB
"""
import csv, sys, datetime as dt
RATE      = 1.80          # $/GB, confirmed from portal
GB_SESS   = 105.1/82      # all-contract GB per session, 2026 density
FRONT_FR  = 0.61          # front month share of records (measured on 27 days)
# activity index by year (NQ contracts/min from 1m OHLCV) -> message-rate proxy
ACT = {2021:13000, 2022:11313, 2023:12926, 2024:17355, 2025:19979, 2026:26428}
BASE = ACT[2026]
ROLLS=[]
with open('backtest-engine/data/ohlcv/nq/NQ_rollover_log.csv') as f:
    for r in csv.DictReader(f):
        ROLLS.append((dt.date.fromisoformat(r['date']), r['from_symbol'], r['to_symbol']))
ROLLS.sort()
def front_at(d):
    cur=None
    for rd,frm,to in ROLLS:
        if d < rd: return frm if cur is None else cur
        cur=to
    return cur
def segments(start,end):
    """(symbol, start, end) slices so each symbol is requested ONLY while it is front month."""
    segs=[]; cur=start; sym=front_at(start)
    for rd,frm,to in ROLLS:
        if start < rd < end:
            segs.append((sym,cur,rd)); cur=rd; sym=to
    segs.append((sym,cur,end))
    return segs
def sessions(a,b):
    n=0; d=a
    while d<b:
        if d.weekday()<5: n+=1
        d+=dt.timedelta(days=1)
    return n
def cost(start,end,front_only=True):
    tot=0.0; rows=[]
    for sym,a,b in segments(start,end):
        s=sessions(a,b)
        scale=ACT.get(a.year,BASE)/BASE
        gb=s*GB_SESS*scale*(FRONT_FR if front_only else 1.0)
        rows.append((sym,a,b,s,gb,gb*RATE)); tot+=gb*RATE
    return rows,tot
def show(title,start,end):
    rows,tot=cost(start,end,True)
    _,full=cost(start,end,False)
    print(f"\n{title}   {start} -> {end}")
    for sym,a,b,s,gb,c in rows:
        print(f"    {sym:<6} {a} .. {b}  {s:>3} sessions  {gb:>6.1f} GB  ${c:>7.2f}")
    print(f"    {'TOTAL front-month-only':<32} ${tot:>7.2f}   (vs ${full:>7.2f} for the NQ parent — saves ${full-tot:.2f})")
    return tot
if __name__=='__main__':
    D=dt.date.fromisoformat
    print("="*74); print("VALIDATION against the real portal quote"); print("="*74)
    r,t=cost(D('2026-05-22'),D('2026-08-21'),False)
    print(f"  parent, 2026-05-22..08-21 estimate ${t:,.2f}  vs portal ACTUAL $176.12")
    print("="*74); print("OPTION A — the 3 consecutive recent months you priced, front-month-only"); print("="*74)
    a=show("recent 3mo",D('2026-05-22'),D('2026-08-21'))
    print("\n"+"="*74); print("OPTION B — 3 months SCATTERED across 5 years (better regime coverage)"); print("="*74)
    tot=0
    for lbl,s,e in (("2021 sample",'2021-09-01','2021-10-01'),
                    ("2023 sample",'2023-04-01','2023-05-01'),
                    ("2025 sample",'2025-10-01','2025-11-01')):
        tot+=show(lbl,D(s),D(e))
    print(f"\n  OPTION B TOTAL: ${tot:,.2f}")
    print("\n"+"="*74); print("OPTION C — cheapest single month (one OOS baseline)"); print("="*74)
    c=show("2022 sample",D('2022-09-01'),D('2022-10-01'))
    print(f"\n  Notes: GB scaled by NQ activity index (2021 ~49% of 2026 message density).")
    print(f"  Message rate is a PROXY via contract volume — treat +/-30% as the error band.")
    print(f"  Verify any plan with a free get_cost call before buying (scripts/quote-oos-cost.py).")
