#!/usr/bin/env python3
"""
R3 shared helpers — volume/speed signature census on RTH 1s NQ data.

Data model: dense (D days x 23580 seconds) float32 matrices covering
09:28:00-16:00:59 ET (393 minutes x 60s). Missing seconds = no trades:
volume 0, close forward-filled (so 1s "returns" are 0 there).

Knowability: every baseline is a trailing-20-eligible-day statistic for the
same minute-of-day bucket (strictly prior days). Day-level vol regime =
trailing-250d ATR14 tercile of atr14_prior (itself computed from prior days).
All features are computable live from a 1s bar stream + 20 days of history.

LIMITATION (stated in findings doc): 1s OHLCV has no aggressor side and no
book. "Signed flow" = tick-rule proxy: sign(close_t - close_{t-1}) * volume_t.
"""
import json
import numpy as np
import pandas as pd
from datetime import datetime
from zoneinfo import ZoneInfo

BASE = "/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore"
ET = ZoneInfo("America/New_York")
N_SEC = 23580          # 09:28:00 .. 16:00:59 ET
N_MIN = 393            # minute m covers seconds [m*60, m*60+60)
S_0930 = 120           # second index of 09:30:00
BASE_WIN = 20          # trailing eligible days for time-of-day baselines
BASE_MIN = 15          # min prior eligible days required


def minute_label(m):
    """Minute index -> HH:MM ET string (m=0 -> 09:28)."""
    tot = 9 * 60 + 28 + m
    return f"{tot // 60:02d}:{tot % 60:02d}"


def sec_of(hh, mm, ss=0):
    return (hh * 60 + mm - (9 * 60 + 28)) * 60 + ss


def load_dense():
    z = np.load(f"{BASE}/R3-dense.npz", allow_pickle=False)
    d = {k: z[k] for k in z.files}
    d["days"] = [s for s in d["days_str"].tolist()]
    return d


def load_days_meta(days):
    """B12-days rows for the cached days + causal ATR-tercile regime flag."""
    meta = pd.read_csv(f"{BASE}/B12-days.csv", parse_dates=["trade_date"])
    meta["date_str"] = meta["trade_date"].dt.strftime("%Y-%m-%d")
    meta = meta.set_index("date_str").reindex(days)
    atr = meta["atr14_prior"].to_numpy()
    n = len(meta)
    top = np.zeros(n, bool)
    bot = np.zeros(n, bool)
    known = np.zeros(n, bool)
    for i in range(n):
        w = atr[max(0, i - 250):i]
        w = w[~np.isnan(w)]
        if len(w) >= 60 and not np.isnan(atr[i]):
            known[i] = True
            top[i] = atr[i] >= np.quantile(w, 2 / 3)
            bot[i] = atr[i] <= np.quantile(w, 1 / 3)
    meta["atr_known"] = known
    meta["atr_top"] = top
    meta["atr_bot"] = bot
    meta["year"] = meta["trade_date"].dt.year
    return meta


def load_baselines():
    z = np.load(f"{BASE}/R3-baselines.npz", allow_pickle=False)
    return {k: z[k] for k in z.files}


def rolling_prior_median(M, elig_idx, win=BASE_WIN, min_n=BASE_MIN):
    """M: (D, K) matrix. For each day, median of M over the previous `win`
    eligible days (strictly prior). Returns (D, K) with NaN where <min_n."""
    D, K = M.shape
    out = np.full((D, K), np.nan, np.float32)
    E = M[elig_idx]                      # (Ne, K), chronological
    for j, d in enumerate(elig_idx):
        lo = max(0, j - win)
        if j - lo >= min_n:
            out[d] = np.nanmedian(E[lo:j], axis=0)
    # non-eligible days also get a baseline from prior eligible days (for
    # completeness; analyses restrict to eligible anyway)
    return out


def fwd_ret(c, d_arr, s_arr, horizon_s):
    """Forward close-to-close move in points from second s to s+horizon.
    NaN when the horizon leaves the session window."""
    s2 = s_arr + horizon_s
    ok = s2 < N_SEC
    out = np.full(len(s_arr), np.nan, np.float32)
    out[ok] = c[d_arr[ok], s2[ok]] - c[d_arr[ok], s_arr[ok]]
    return out


def day_clustered(vals, day_ids):
    """Mean, day-clustered t (average within day first), n_events, n_days."""
    ok = ~np.isnan(vals)
    vals, day_ids = vals[ok], day_ids[ok]
    if len(vals) == 0:
        return dict(mean=np.nan, mean_dayw=np.nan, t=np.nan, n=0, ndays=0)
    df = pd.DataFrame({"d": day_ids, "v": vals})
    per_day = df.groupby("d")["v"].mean()
    m = per_day.mean()
    nd = len(per_day)
    t = m / (per_day.std(ddof=1) / np.sqrt(nd)) if nd > 2 else np.nan
    return dict(mean=float(np.mean(vals)), mean_dayw=float(m), t=float(t),
                n=int(len(vals)), ndays=nd)


def yearly_table(vals, day_ids, years_of_day, label="", horizons=None):
    """Per-year mean + day-clustered t for one value column."""
    rows = []
    yrs = years_of_day[day_ids]
    for y in sorted(np.unique(yrs)):
        st = day_clustered(vals[yrs == y], day_ids[yrs == y])
        rows.append(dict(year=int(y), **st))
    rows.append(dict(year=0, **day_clustered(vals, day_ids)))  # pooled
    t = pd.DataFrame(rows)
    t["label"] = label
    return t


def fmt_yearly(vals_dict, day_ids, years_of_day, title):
    """vals_dict: {colname: values}. Print compact per-year table:
    per column 'day-weighted mean/day-clustered t' with pooled row last."""
    print(f"\n== {title} ==")
    yrs = years_of_day[day_ids]
    uy = sorted(np.unique(yrs))
    hdr = "year    n_ev  ndays " + "".join(f"{k:>18}" for k in vals_dict)
    print(hdr + "   (dayw-mean/day-t)")
    for y in uy + [0]:
        sel = (yrs == y) if y else np.ones(len(day_ids), bool)
        cells, n, nd = [], 0, 0
        for k, v in vals_dict.items():
            st = day_clustered(v[sel], day_ids[sel])
            n, nd = st["n"], st["ndays"]
            cells.append(f"{st['mean_dayw']:+8.2f}/{st['t']:+5.1f}"
                         if st["n"] else f"{'--':>14}")
        print(f"{y or 'ALL':>4} {n:7d} {nd:6d} " + "".join(f"{c:>18}" for c in cells))
