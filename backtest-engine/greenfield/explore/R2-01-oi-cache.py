"""R2-01: Daily QQQ open-interest census from OPRA statistics files.

Knowability: file dated D holds prior-day (D-1 close) OI, received ~05:30-06:30
ET on morning D -> usable for the whole trading day D. stat_type==9 = open
interest; rows are duplicated across OPRA publishers -> dedupe by symbol
(first occurrence). OSI symbol: 'QQQ   240621C00244780' -> expiry 2024-06-21,
right C, strike 244.78.

Output: greenfield/explore/R2-oi-daily.csv (one row per file date) and
R2-expiries-from-stats.txt (union of expiry dates seen, for calendar patch).

Per-day columns:
- total/call/put OI; dte0 OI + share; OI expiring within 7 calendar days
- dte0 pin strikes: top-3 OI strikes among options expiring today (+OI)
- front monthly (3rd-Friday-window) expiry: date, total OI, top-3 pin strikes
"""
import glob
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from R2_common import ROOT, EXP

STAT_DIR = os.path.join(ROOT, "data", "statistics", "qqq")
files = sorted(glob.glob(os.path.join(STAT_DIR, "opra-pillar-*.statistics.csv")))
print(f"{len(files)} statistics files")


def third_friday_window(d):
    """Is d in the 3rd-Friday monthly-expiry window (Fri 15-21, or Thu 15-20
    holiday-shifted)?"""
    if d.weekday() == 4 and 15 <= d.day <= 21:
        return True
    if d.weekday() == 3:
        f = d + timedelta(days=1)
        if 15 <= f.day <= 21:
            return True  # counts either way; monthly OI sits on the listed date
    return False


def parse_file(path):
    m = re.search(r"(\d{8})\.statistics", path)
    fdate = date(int(m.group(1)[:4]), int(m.group(1)[4:6]), int(m.group(1)[6:8]))
    out = subprocess.run(
        ["awk", "-F,", '$11==9{print $15"|"$8}', path],
        capture_output=True, text=True, check=True)
    seen = {}
    for line in out.stdout.splitlines():
        sym, qty = line.rsplit("|", 1)
        if sym not in seen:
            try:
                seen[sym] = int(qty)
            except ValueError:
                pass
    # aggregate
    tot = call = put = dte0 = dte0_c = dte0_p = w7 = 0
    dte0_strikes = {}
    by_exp = {}
    exps = set()
    for sym, oi in seen.items():
        body = sym[6:].strip() if len(sym) > 6 else ""
        mm = re.match(r"^(\d{6})([CP])(\d{8})$", body)
        if not mm:
            continue
        yy, mo, dd = int(mm.group(1)[:2]), int(mm.group(1)[2:4]), int(mm.group(1)[4:6])
        exp = date(2000 + yy, mo, dd)
        right = mm.group(2)
        strike = int(mm.group(3)) / 1000.0
        exps.add(exp.isoformat())
        tot += oi
        if right == "C":
            call += oi
        else:
            put += oi
        if exp == fdate:
            dte0 += oi
            if right == "C":
                dte0_c += oi
            else:
                dte0_p += oi
            dte0_strikes[strike] = dte0_strikes.get(strike, 0) + oi
        if fdate <= exp <= fdate + timedelta(days=7):
            w7 += oi
        by_exp.setdefault(exp, {}).setdefault(strike, 0)
        by_exp[exp][strike] += oi

    def top3(d):
        it = sorted(d.items(), key=lambda kv: -kv[1])[:3]
        it += [(float("nan"), 0)] * (3 - len(it))
        return it

    # front monthly expiry at or after fdate
    monthlies = sorted(e for e in by_exp if e >= fdate and third_friday_window(e))
    if monthlies:
        fm = monthlies[0]
        fm_oi = sum(by_exp[fm].values())
        fm_top = top3(by_exp[fm])
    else:
        fm, fm_oi, fm_top = None, 0, top3({})
    d0 = top3(dte0_strikes)
    # full near-money strike distributions for pin analysis (census-grade:
    # keep every strike with OI >= 500 to bound file size)
    strike_rows = []
    for kind, dist in (("dte0", dte0_strikes),
                       ("fm", by_exp.get(fm, {}) if monthlies else {})):
        for k, v in dist.items():
            if v >= 500:
                strike_rows.append((fdate.isoformat(), kind, k, v))
    row = {
        "date": fdate.isoformat(), "n_instr": len(seen),
        "total_oi": tot, "call_oi": call, "put_oi": put,
        "dte0_oi": dte0, "dte0_call_oi": dte0_c, "dte0_put_oi": dte0_p,
        "dte0_share": dte0 / tot if tot else 0.0,
        "w7_oi": w7, "w7_share": w7 / tot if tot else 0.0,
        "dte0_pin1": d0[0][0], "dte0_pin1_oi": d0[0][1],
        "dte0_pin2": d0[1][0], "dte0_pin2_oi": d0[1][1],
        "dte0_pin3": d0[2][0], "dte0_pin3_oi": d0[2][1],
        "fm_exp": fm.isoformat() if fm else "",
        "fm_oi": fm_oi,
        "fm_pin1": fm_top[0][0], "fm_pin1_oi": fm_top[0][1],
        "fm_pin2": fm_top[1][0], "fm_pin2_oi": fm_top[1][1],
        "fm_pin3": fm_top[2][0], "fm_pin3_oi": fm_top[2][1],
    }
    return row, exps, strike_rows


rows, all_exps, all_strikes = [], set(), []
with ThreadPoolExecutor(max_workers=6) as ex:
    for i, (row, exps, srows) in enumerate(ex.map(parse_file, files)):
        rows.append(row)
        all_exps |= exps
        all_strikes.extend(srows)
        if (i + 1) % 100 == 0:
            print(f"  {i+1}/{len(files)}")

df = pd.DataFrame(rows).sort_values("date")
out = os.path.join(EXP, "R2-oi-daily.csv")
df.to_csv(out, index=False)
pd.DataFrame(all_strikes, columns=["date", "kind", "strike", "oi"]) \
    .sort_values(["date", "kind", "strike"]) \
    .to_csv(os.path.join(EXP, "R2-oi-strikes.csv"), index=False)
with open(os.path.join(EXP, "R2-expiries-from-stats.txt"), "w") as f:
    f.write("\n".join(sorted(all_exps)))
print(f"wrote {out}  n={len(df)}  dates {df['date'].min()}..{df['date'].max()}")
print(df[["total_oi", "dte0_share", "w7_share"]].describe())
