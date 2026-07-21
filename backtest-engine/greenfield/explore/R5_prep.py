#!/usr/bin/env python3
"""R5 first-hour regime classifier: data prep.
Builds R5-days.csv: one row per clean RTH day with causal first-hour regime label
(computed ONLY from <=10:30 ET data) + rest-of-day and afternoon outcome textures.

Regime definitions are PRE-REGISTERED (see R5-firsthour-regime.md). No threshold sweep.
"""
import csv, sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
NQ_CACHE = "cache_nq_primary_1m.csv"
B12 = "B12-days.csv"
OUT = "R5-days.csv"

# ---- pre-registered thresholds (single set, declared up front) ----
PROG_ONEWAY = 0.60      # net-progress efficiency >= this = one-way drive
PROG_CHOP   = 0.25      # efficiency < this = two-sided chop
LOC_UP      = 0.70      # one-way up must close in top 30% of first-hour range
LOC_DN      = 0.30      # one-way down must close in bottom 30%

def load_b12():
    d = {}
    with open(B12) as f:
        for r in csv.DictReader(f):
            d[r["trade_date"]] = r
    return d

def first_hour_label(fh_open, fh_close, fh_high, fh_low, on_high, on_low):
    rng = fh_high - fh_low
    if rng <= 0:
        return "CHOP", 0.0, 0.5
    net = fh_close - fh_open
    prog = abs(net) / rng
    loc = (fh_close - fh_low) / rng
    # 1. sweep-revert: took out an ON extreme then closed back inside on opposite side
    if on_high is not None and on_low is not None:
        swept_high = fh_high > on_high
        swept_low  = fh_low  < on_low
        if swept_high and (fh_close < on_high) and net < 0:
            return "SWEEP_REVERT_BEAR", prog, loc
        if swept_low and (fh_close > on_low) and net > 0:
            return "SWEEP_REVERT_BULL", prog, loc
    # 2. one-way trend
    if prog >= PROG_ONEWAY:
        if net > 0 and loc >= LOC_UP:
            return "ONEWAY_UP", prog, loc
        if net < 0 and loc <= LOC_DN:
            return "ONEWAY_DOWN", prog, loc
    # 3. chop
    if prog < PROG_CHOP:
        return "CHOP", prog, loc
    # 4. moderate advance/decline = dip-buy / rip-sell
    if net > 0:
        return "BTD", prog, loc
    if net < 0:
        return "STR", prog, loc
    return "CHOP", prog, loc

def texture_label(o, c, hi, lo):
    """Same efficiency scheme used to describe a later window (for persistence)."""
    rng = hi - lo
    if rng <= 0:
        return "CHOP"
    net = c - o
    prog = abs(net) / rng
    loc = (c - lo) / rng
    if prog >= PROG_ONEWAY:
        if net > 0 and loc >= LOC_UP: return "TREND_UP"
        if net < 0 and loc <= LOC_DN: return "TREND_DOWN"
    if prog < PROG_CHOP:
        return "CHOP"
    return "DRIFT_UP" if net > 0 else "DRIFT_DOWN"

def main():
    b12 = load_b12()
    # accumulate per ET-date RTH bars
    # windows (ET minutes from midnight): fh 570-629 (09:30-10:29), rod 630-959 (10:30-15:59),
    # pm 780-959 (13:00-15:59)
    cur_date = None
    fh = []; rod = []; pm = []
    fh_open = None
    rows_out = []

    def flush(dstr):
        if dstr not in b12:
            return
        b = b12[dstr]
        if b["full_rth"] != "True" or b["rth_same_sym"] != "True":
            return
        if not fh or not rod:
            return
        # need full-ish first hour and rest of day
        if len(fh) < 55 or len(rod) < 300:
            return
        fho = fh[0][0]
        fhc = fh[-1][1]
        fhh = max(x[2] for x in fh)
        fhl = min(x[3] for x in fh)
        try:
            on_high = float(b["on_high"]) if b["on_high"] else None
            on_low  = float(b["on_low"])  if b["on_low"]  else None
        except ValueError:
            on_high = on_low = None
        atr = None
        try:
            atr = float(b["atr14_prior"]) if b["atr14_prior"] else None
        except ValueError:
            atr = None
        label, prog, loc = first_hour_label(fho, fhc, fhh, fhl, on_high, on_low)
        # rest of day
        rod_close = rod[-1][1]
        rod_high = max(x[2] for x in rod)
        rod_low  = min(x[3] for x in rod)
        rod_drift = rod_close - fhc          # 10:30 -> close directional move
        rod_mfe_up = rod_high - fhc
        rod_mfe_dn = fhc - rod_low
        # afternoon texture 13:00-16:00
        pm_lab = ""
        if len(pm) >= 120:
            pmo = pm[0][0]; pmc = pm[-1][1]
            pmh = max(x[2] for x in pm); pml = min(x[3] for x in pm)
            pm_lab = texture_label(pmo, pmc, pmh, pml)
            pm_drift = pmc - pmo
        else:
            pm_drift = ""
        fh_net = fhc - fho
        fh_rng = fhh - fhl
        rows_out.append({
            "trade_date": dstr, "year": b["year"], "dow": b["dow"],
            "regime": label, "fh_prog": round(prog,4), "fh_loc": round(loc,4),
            "fh_net": round(fh_net,2), "fh_rng": round(fh_rng,2),
            "fh_open": fho, "fh_close": fhc, "fh_high": fhh, "fh_low": fhl,
            "atr14_prior": atr if atr else "",
            "gap": b["gap"], "on_range": b["on_range"],
            "rod_drift": round(rod_drift,2), "rod_mfe_up": round(rod_mfe_up,2),
            "rod_mfe_dn": round(rod_mfe_dn,2),
            "rod_close": rod_close,
            "pm_texture": pm_lab,
            "pm_drift": round(pm_drift,2) if pm_drift!="" else "",
            "fh_dir": 1 if fh_net>0 else (-1 if fh_net<0 else 0),
        })

    with open(NQ_CACHE) as f:
        rd = csv.reader(f)
        next(rd)
        for row in rd:
            ts = row[0]
            # parse as UTC
            dt = datetime.fromisoformat(ts).replace(tzinfo=timezone.utc).astimezone(ET)
            m = dt.hour*60 + dt.minute
            if m < 570 or m >= 960:
                continue
            dstr = dt.strftime("%Y-%m-%d")
            if dstr != cur_date:
                if cur_date is not None:
                    flush(cur_date)
                cur_date = dstr
                fh=[]; rod=[]; pm=[]
            o=float(row[1]); hi=float(row[2]); lo=float(row[3]); c=float(row[4])
            tup=(o,c,hi,lo)
            if 570 <= m < 630:
                fh.append(tup)
            if 630 <= m < 960:
                rod.append(tup)
            if 780 <= m < 960:
                pm.append(tup)
        if cur_date is not None:
            flush(cur_date)

    cols = ["trade_date","year","dow","regime","fh_prog","fh_loc","fh_net","fh_rng",
            "fh_open","fh_close","fh_high","fh_low","atr14_prior","gap","on_range",
            "rod_drift","rod_mfe_up","rod_mfe_dn","rod_close","pm_texture","pm_drift","fh_dir"]
    with open(OUT,"w",newline="") as f:
        w=csv.DictWriter(f,fieldnames=cols)
        w.writeheader()
        for r in rows_out:
            w.writerow(r)
    print(f"wrote {len(rows_out)} days -> {OUT}")

if __name__=="__main__":
    main()
