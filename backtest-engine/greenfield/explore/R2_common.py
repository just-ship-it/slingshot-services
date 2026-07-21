"""R2 dealer/hedging-flow footprint census - shared loaders.

Conventions (KNOWABILITY.md):
- 1m bars are stamped at bar OPEN (ts_utc / et_hhmm = open minute), knowable at
  close (+60s). A window return "to 15:00" uses the close of the 14:59 bar.
- Sessions cache (NQ_daily_sessions.csv) is pre-filtered: full RTH days only,
  no roll-in-day, same symbol across RTH. It is the clean day universe.
- OI statistics file dated D holds prior-day (D-1 close) OI, received ~05:30-
  06:30 ET on D -> knowable for the whole trading day D.
- Vol regime proxy = atr14_prior (prior-14d ATR, points) from sessions cache;
  normalized atr_rel = atr14_prior / prior_rth_close. (No VIX index series in
  the clean inventory; data/ohlcv/vix/ is VIX *options*, not the index.)
"""
import os
import numpy as np
import pandas as pd

ROOT = "/home/drew/projects/slingshot-services/backtest-engine"
EXP = os.path.join(ROOT, "greenfield", "explore")
CACHE = os.path.join(EXP, "cache")


def load_1m(sym="NQ", usecols=None):
    """Primary-contract 1m bars with ET annotations. dow: 0=Mon..6=Sun."""
    f = os.path.join(CACHE, f"{sym}_1m_primary.csv")
    df = pd.read_csv(f, usecols=usecols)
    return df


def add_ret(df):
    """Same-symbol log return per 1m bar (close-to-close). NaN across symbol
    changes and day gaps > 90 minutes."""
    c = df["c"].to_numpy()
    ret = np.full(len(df), np.nan)
    ret[1:] = np.log(c[1:] / c[:-1])
    same = (df["symbol"].to_numpy()[1:] == df["symbol"].to_numpy()[:-1])
    ts = pd.to_datetime(df["ts_utc"], utc=True).dt.tz_localize(None).to_numpy()
    dt_min = (ts[1:] - ts[:-1]) / np.timedelta64(1, "m")
    ok = same & (dt_min <= 90)
    ret[1:][~ok] = np.nan
    df["ret"] = ret
    return df


def load_sessions():
    s = pd.read_csv(os.path.join(CACHE, "NQ_daily_sessions.csv"))
    s["year"] = s["year"].astype(int)
    s["atr_rel"] = s["atr14_prior"] / s["prior_rth_close"]
    return s


def trading_days():
    return load_sessions()["trade_date"].tolist()


def load_calendar():
    return pd.read_csv(os.path.join(EXP, "R2-calendar.csv"))


def load_oi():
    f = os.path.join(EXP, "R2-oi-daily.csv")
    return pd.read_csv(f) if os.path.exists(f) else None


def assign_trade_date(df, tds=None):
    """CME trade date: ET >= 18:00 belongs to next calendar day's trade date
    (Sunday evening -> Monday). EXACT match against the clean-day universe:
    bars whose trade date is not a clean full-RTH session (holidays, half
    days, roll days) get trade_date=None and should be dropped by callers."""
    if tds is None:
        tds = trading_days()
    d = pd.to_datetime(df["et_date"])
    nxt = df["et_hhmm"] >= 1800
    d = d + pd.to_timedelta(nxt.astype(int), unit="D")
    ds = d.dt.strftime("%Y-%m-%d")
    ok = set(tds)
    df["trade_date"] = ds.where(ds.isin(ok), None)
    return df


def yearly_table(df, group, val, atr=None):
    """Mean/t/n of `val` by `group` x year. Returns pivot of means with n."""
    g = df.groupby([group, "year"])[val]
    out = g.agg(["mean", "count", "std"])
    out["t"] = out["mean"] / (out["std"] / np.sqrt(out["count"].clip(lower=1)))
    return out


def tstat(x):
    x = np.asarray(x, dtype=float)
    x = x[~np.isnan(x)]
    if len(x) < 3:
        return np.nan, len(x)
    return x.mean() / (x.std(ddof=1) / np.sqrt(len(x))), len(x)


def fmt_t(x):
    t, n = tstat(x)
    m = np.nanmean(x)
    return f"{m:+.4f} (t={t:+.1f}, n={n})"
