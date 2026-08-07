"""M3 shared helpers — commodity flow research.
Data: date,ts,open,high,low,close,volume ; ts = epoch SECONDS UTC.
ET conversion via zoneinfo America/New_York (DST-correct).
Knowability: a 15m/1h bar stamped at ts covers [ts, ts+bar); consumable only at CLOSE.
"""
import csv, math
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")

# point values ($ per 1.00 point)
PV = {"cl": 1000.0, "gc": 100.0}
MICRO_PV = {"cl": 100.0, "gc": 10.0}      # MCL, MGC
TICK = {"cl": 0.01, "gc": 0.1}
TICK_USD = {"cl": 10.0, "gc": 10.0}       # full contract $ per tick
# 1 tick/side slippage + commission ~ per full contract, points:
# use 1 tick slippage per side (round trip 2 ticks) + ~$4 commission RT.

def load(path):
    """Return list of dict bars with parsed fields + ET datetime."""
    out = []
    with open(path) as f:
        r = csv.reader(f)
        next(r)  # header
        for row in r:
            ts = int(row[1])
            dt = datetime.fromtimestamp(ts, ET)
            out.append({
                "ts": ts, "dt": dt,
                "o": float(row[2]), "h": float(row[3]),
                "l": float(row[4]), "c": float(row[5]),
                "v": float(row[6]),
                "et_min": dt.hour * 60 + dt.minute,   # minutes since ET midnight
                "dow": dt.weekday(),                   # Mon=0 .. Sun=6
                "date": dt.date(),
            })
    return out

def index_by_ts(bars):
    return {b["ts"]: i for i, b in enumerate(bars)}

def pct(vals, p):
    if not vals: return float("nan")
    s = sorted(vals); k = (len(s)-1)*p
    f = math.floor(k); c = math.ceil(k)
    if f == c: return s[int(k)]
    return s[f]*(c-k) + s[c]*(k-f)

def summ(vals):
    if not vals: return dict(n=0)
    n=len(vals); m=sum(vals)/n
    sd=(sum((x-m)**2 for x in vals)/n)**0.5 if n>1 else 0.0
    wins=sum(1 for x in vals if x>0)
    return dict(n=n, mean=m, med=pct(vals,.5), sd=sd,
                p25=pct(vals,.25), p75=pct(vals,.75),
                p10=pct(vals,.10), p90=pct(vals,.90),
                wr=wins/n, tstat=(m/(sd/n**0.5)) if sd>0 and n>1 else 0.0,
                minv=min(vals), maxv=max(vals))

def fmt(s):
    if s.get("n",0)==0: return "n=0"
    return (f"n={s['n']:4d} mean={s['mean']:+.4f} med={s['med']:+.4f} "
            f"sd={s['sd']:.4f} wr={s['wr']:.2%} t={s['tstat']:+.2f} "
            f"p10={s['p10']:+.3f} p90={s['p90']:+.3f}")
