#!/usr/bin/env python3
"""
V1_lib.py — shared loading/metrics for the independent B4 verification.

Everything here is built ONLY from v1_slim_1s.pkl (V1-01, raw 1s CSV) and
v1_daily.csv (V1-02, raw 1m CSV). Nothing under greenfield/explore/ is read.

Sim contract implemented (as specified in B4-preclose-expiry.md):
- market order placed at wall time T fills at the open of the first 1s bar
  stamped >= T, +slip adverse (buy: open+slip, sell: open-slip), slip=0.25 (1x)
- time exit at wall time T: open of first 1s bar stamped >= T, -slip adverse
- $5 round-trip commission, $20/pt, 1 contract
- decision at wall time T uses only bars CLOSED by T (bar stamp < T)
"""
import pickle, csv, math
from datetime import date, timedelta

VDIR = "/home/drew/projects/slingshot-services/backtest-engine/greenfield/verify"
S_0930 = 9*3600+30*60
S_1030 = 10*3600+30*60
S_1500 = 15*3600
S_1530 = 15*3600+30*60
S_1545 = 15*3600+45*60


def load_slim():
    with open(f"{VDIR}/v1_slim_1s.pkl", "rb") as f:
        return pickle.load(f)


def load_daily():
    out = {}
    with open(f"{VDIR}/v1_daily.csv") as f:
        for row in csv.DictReader(f):
            out[row["date"]] = row
    return out


def day_context(rec):
    """Per-hour primary contract (ET hours 9..15, RTH volume), roll flag, day primary."""
    prim = {}
    for h in range(9, 16):
        best, bv = None, -1
        for sym, hv in rec["vol"].items():
            v = hv.get(h, 0)
            if v > bv:
                best, bv = sym, v
        if bv > 0:
            prim[h] = best
    roll = len(set(prim.values())) > 1
    tot = {s: sum(hv.values()) for s, hv in rec["vol"].items()}
    day_sym = max(tot, key=tot.get) if tot else None
    return prim, roll, day_sym


def first_bar_at_or_after(bars, sym, t):
    for b in bars:
        if b[0] >= t and b[1] == sym:
            return b
    return None


def last_bar_before(bars, sym, t):
    out = None
    for b in bars:
        if b[0] >= t:
            break
        if b[1] == sym:
            out = b
    return out


def sim_market_trade(rec, sym, entry_t, exit_t, direction, slip, entry_win, exit_win):
    """direction +1 long / -1 short. Returns (net$, gross_pts, entry_bar, exit_bar) or None."""
    eb = first_bar_at_or_after(rec["bars"][entry_win], sym, entry_t)
    xb = first_bar_at_or_after(rec["bars"][exit_win], sym, exit_t)
    if eb is None or xb is None:
        return None
    entry = eb[2] + direction * slip
    exit_ = xb[2] - direction * slip
    gross_pts = direction * (xb[2] - eb[2])
    net = direction * (exit_ - entry) * 20.0 - 5.0
    return net, gross_pts, eb, xb


def metrics(trades, label=""):
    """trades: list of (date_str, net$, gross_pts). Returns dict."""
    if not trades:
        return {"label": label, "n": 0}
    n = len(trades)
    nets = [t[1] for t in trades]
    wins = sum(1 for x in nets if x > 0)
    gp = sum(x for x in nets if x > 0)
    gl = -sum(x for x in nets if x < 0)
    pf = gp / gl if gl > 0 else float("inf")
    pnl = sum(nets)
    mean = pnl / n
    var = sum((x - mean) ** 2 for x in nets) / (n - 1) if n > 1 else 0.0
    sd = math.sqrt(var)
    sharpe = (mean / sd) * math.sqrt(252) if sd > 0 else float("inf")
    eq, peak, maxdd = 0.0, 0.0, 0.0
    for x in nets:
        eq += x
        peak = max(peak, eq)
        maxdd = min(maxdd, eq - peak)
    years = {}
    for d, x, g in trades:
        y = d[:4]
        c, s = years.get(y, (0, 0.0))
        years[y] = (c + 1, s + x)
    gmean = sum(t[2] for t in trades) / n
    gmed = sorted(t[2] for t in trades)[n // 2] if n % 2 else sum(sorted(t[2] for t in trades)[n//2-1:n//2+1])/2
    return {"label": label, "n": n, "wr": 100.0 * wins / n, "pf": pf, "pnl": pnl,
            "sharpe": sharpe, "maxdd": maxdd, "years": years,
            "gross_mean": gmean, "gross_med": gmed}


def fmt(m):
    if m.get("n", 0) == 0:
        return f"{m.get('label','')}: no trades"
    ys = " ".join(f"{y}:{s:+.0f}/{c}" for y, (c, s) in sorted(m["years"].items()))
    return (f"{m['label']:<34} n={m['n']:<4} WR={m['wr']:.1f} PF={m['pf']:.3f} "
            f"PnL=${m['pnl']:+,.0f} Sh={m['sharpe']:.2f} DD=${m['maxdd']:,.0f} "
            f"grossPts mean={m['gross_mean']:.2f} med={m['gross_med']:.2f} [{ys}]")


# ---------- expiry calendar (pure date arithmetic) ----------

def easter(year):
    """Anonymous Gregorian computus."""
    a = year % 19; b = year // 100; c = year % 100
    d = b // 4; e = b % 4; f = (b + 8) // 25; g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4; k = c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = ((h + l - 7 * m + 114) % 31) + 1
    return date(year, month, day)


def third_friday(year, month):
    d = date(year, month, 1)
    fridays = [d + timedelta(days=x) for x in range(31)
               if (d + timedelta(days=x)).month == month and (d + timedelta(days=x)).weekday() == 4]
    return fridays[2]


def expiry_calendar(y0, y1):
    """[(date, 'quarterly'|'monthly')] — 3rd Friday, holiday-shifted to Thursday
    when it collides with Good Friday (the only US full-closure holiday that can
    land on a 3rd Friday)."""
    out = []
    for y in range(y0, y1 + 1):
        gf = easter(y) - timedelta(days=2)
        for mth in range(1, 13):
            d = third_friday(y, mth)
            if d == gf:
                d = d - timedelta(days=1)
            out.append((d, "quarterly" if mth in (3, 6, 9, 12) else "monthly"))
    return out
