"""R7 shared library: load anchors+B12, build calendar features, segment drifts, summarizer."""
import pandas as pd, numpy as np

SEGMENTS = {  # name: (start_hhmm, end_hhmm)  -- drift = c_end - c_start (same-symbol gated)
    "rth_full": (930, 1600),
    "am1_0930_1030": (930, 1030),
    "am2_0930_1100": (930, 1100),
    "open15": (930, 945),
    "mid_1100_1400": (1100, 1400),
    "pm_1400_1600": (1400, 1600),
    "lasthr_1500_1600": (1500, 1600),
    "pre30_1500_1530": (1500, 1530),
    "close30_1530_1600": (1530, 1600),
    "pre15_1545_1600": (1545, 1600),
    "fomc30_1400_1430": (1400, 1430),
    "fomc60_1400_1500": (1400, 1500),
    "on_sess_1800_0930": (1800, 930),
    "rel830_0830_0930": (830, 930),
}

def load(anchor_file="R7-nq-anchors.csv"):
    b = pd.read_csv("B12-days.csv")
    a = pd.read_csv(anchor_file)
    df = b.merge(a, on="trade_date", how="inner")
    df["dt"] = pd.to_datetime(df["trade_date"])
    df = df.sort_values("dt").reset_index(drop=True)
    df["month"] = df["dt"].dt.month
    df["ym"] = df["dt"].dt.strftime("%Y-%m")
    if "year" not in df.columns:
        df["year"] = df["dt"].dt.year
    # trading-day-of-month forward (1..n) and reverse (-1=last)
    df["tdom"] = df.groupby("ym").cumcount() + 1
    df["tdom_rev"] = df.groupby("ym")["tdom"].transform("max") - df["tdom"] + 1
    df["tdom_rev"] = -df["tdom_rev"]  # -1 = last trading day
    # OPEX: 3rd Friday of each calendar month; OPEX week = Mon-Fri containing it
    opex_dates = _third_fridays(df)
    df["opex_friday"] = df["trade_date"].isin(opex_dates)
    df["opex_week"] = _opex_week_flag(df, opex_dates)
    df["quarter_opex"] = df["opex_friday"] & df["month"].isin([3, 6, 9, 12])
    # half day
    df["half_day"] = df["n_rth"] <= 225
    # holiday-adjacent from trade_date sequence gaps (missing weekdays)
    df["pre_holiday"], df["post_holiday"] = _holiday_adjacent(df)
    # segment drifts
    for name, (s, e) in SEGMENTS.items():
        cs, ce = f"c_{s}", f"c_{e}"
        ss, se = f"s_{s}", f"s_{e}"
        same = df[ss].notna() & df[se].notna() & (df[ss] == df[se])
        d = np.where(same, df[ce] - df[cs], np.nan)
        df[f"seg_{name}"] = d
        df[f"segatr_{name}"] = d / df["atr14_prior"]
    # gap straight from B12 (handles roll)
    df["seg_gap"] = df["gap"]
    df["segatr_gap"] = df["gap"] / df["atr14_prior"]
    return df

def _third_fridays(df):
    out = []
    for ym, g in df.groupby("ym"):
        fridays = g[g["dow"] == 4]["trade_date"].tolist()  # dow 4 = Friday (0=Mon)
        # 3rd Friday by calendar date
        allfri = sorted(fridays)
        if len(allfri) >= 3:
            out.append(allfri[2])
    return set(out)

def _opex_week_flag(df, opex_dates):
    # week (iso year-week) containing each opex friday
    wk = df["dt"].dt.isocalendar()
    key = wk["year"].astype(str) + "-" + wk["week"].astype(str)
    opex_keys = set()
    for od in opex_dates:
        r = df[df["trade_date"] == od]
        if len(r):
            w = r["dt"].dt.isocalendar().iloc[0]
            opex_keys.add(f"{int(w['year'])}-{int(w['week'])}")
    return key.isin(opex_keys)

def _holiday_adjacent(df):
    dts = df["dt"].tolist()
    pre = [False] * len(df)
    post = [False] * len(df)
    for i in range(len(df) - 1):
        gap_days = (dts[i + 1] - dts[i]).days
        # normal Mon-Fri gap =1; Fri->Mon =3. A holiday inserts an extra missing weekday.
        # count missing weekdays strictly between
        miss = 0
        d = dts[i] + pd.Timedelta(days=1)
        while d < dts[i + 1]:
            if d.weekday() < 5:
                miss += 1
            d += pd.Timedelta(days=1)
        if miss >= 1:  # at least one skipped weekday = holiday between
            pre[i] = True       # day before holiday
            post[i + 1] = True  # day after holiday
    return pre, post

def summ(df, mask, seg, label=""):
    """One-per-day drift summary: n, mean pts, sd, t, mean/atr, per-year signs."""
    s = df.loc[mask, f"seg_{seg}"].dropna()
    satr = df.loc[mask & df[f"segatr_{seg}"].notna(), f"segatr_{seg}"].dropna()
    n = len(s)
    if n < 2:
        return dict(label=label, seg=seg, n=n, mean=np.nan, t=np.nan, matr=np.nan, ysign="", ypos=0, ny=0)
    mean = s.mean(); sd = s.std(ddof=1)
    t = mean / (sd / np.sqrt(n)) if sd > 0 else np.nan
    matr = satr.mean()
    # per-year
    sub = df.loc[mask & df[f"seg_{seg}"].notna(), ["year", f"seg_{seg}"]]
    ym = sub.groupby("year")[f"seg_{seg}"].mean()
    ysign = " ".join(f"{v:+.0f}" for v in ym.values)
    ypos = int((ym > 0).sum()); ny = len(ym)
    return dict(label=label, seg=seg, n=n, mean=mean, t=t, matr=matr, ysign=ysign, ypos=ypos, ny=ny)

def fmt(r):
    return (f"{r['label']:<28} {r['seg']:<20} n={r['n']:>4} "
            f"mean={r['mean']:+7.2f}pt t={r['t']:+5.2f} atr={r['matr']:+.3f} "
            f"yr[{r['ypos']}/{r['ny']}]: {r['ysign']}")
