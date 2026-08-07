#!/usr/bin/env python3
"""
RG2 — Gap-continuation "open = day's extreme" (roguetrader SPX_PATTERN_RECOGNITION_FOR_INTRADAY_BOTTOMS_AT_OPEN).

Hypothesis (source PDF): on certain gap days the RTH open tick IS the day's extreme (bottom on up-gaps),
and IF the open holds as the extreme for ~15-20 min, price "never looks back" -> ride the gap direction to close.
Up-day biased (5 of 6 flagged occurrences were up days).

Test instrument: NQ continuous 1m (pure price action, no external levels -> continuous is appropriate;
roll gaps removed so overnight gap = true move). Window ~2021-01 .. 2026-01.

CRITICAL controls (first-hour program lesson: a "continuation" edge is often just unconditional long drift,
direction not load-bearing). We compare, on the SAME days:
    (0) UNCOND     : long 9:50->close every day (baseline intraday drift)
    (1) GAPDIR     : trade gap direction at 9:50 on every |gap|>thr day (NO confirmation gate)
    (2) CONFIRMED  : trade gap direction only when open held as extreme through 9:50 (the strategy)
    (3) FADE       : opposite of GAPDIR on confirmed days (placebo / anti)
Split up-gaps vs down-gaps; sweep gap-size threshold and confirmation tolerance.

Fills: entry = open of 9:50 ET bar, exit = close of last bar <= cutoff. No intrabar stop -> 1m is honest
(no lookahead, no same-bar stop/target ambiguity). Points P&L. (Adding a stop would require 1s; noted.)
"""
import sys
import numpy as np
import pandas as pd
from zoneinfo import ZoneInfo

F = "/home/drew/projects/slingshot-services/backtest-engine/data/ohlcv/nq/NQ_ohlcv_1m_continuous.csv"
ET = ZoneInfo("America/New_York")
OPEN_HM = 9 * 60 + 30       # 9:30
CONF_END_HM = 9 * 60 + 50   # 9:50 (entry time, after 20-min confirmation window)
CUTOFF_HM = 15 * 60 + 45    # 15:45 production EOD cutoff
CLOSE_HM = 16 * 60          # 16:00


def load():
    df = pd.read_csv(F, usecols=["ts_event", "open", "high", "low", "close", "volume"])
    ts = pd.to_datetime(df["ts_event"], utc=True).dt.tz_convert(ET)
    df["etdate"] = ts.dt.strftime("%Y-%m-%d")
    df["hm"] = ts.dt.hour * 60 + ts.dt.minute
    df["year"] = ts.dt.year
    return df


def build_days(df, cutoff_hm=CUTOFF_HM):
    """Per RTH day: prev_rth_close, day_open(9:30), conf-window low/high(9:30..9:49), entry(9:50 open),
    exit(last bar <= cutoff), plus 9:50->close for the unconditional baseline."""
    rows = []
    prev_close = None
    for d, g in df.groupby("etdate", sort=True):
        rth = g[(g["hm"] >= OPEN_HM) & (g["hm"] < CLOSE_HM)]
        if len(rth) < 60:  # need a reasonably full RTH session
            # still update prev_close if we have a late bar
            if len(rth):
                prev_close = rth.iloc[-1]["close"]
            continue
        openbar = rth[rth["hm"] == OPEN_HM]
        if openbar.empty:
            prev_close = rth.iloc[-1]["close"]
            continue
        day_open = openbar.iloc[0]["open"]
        conf = rth[(rth["hm"] >= OPEN_HM) & (rth["hm"] < CONF_END_HM)]
        entrybar = rth[rth["hm"] == CONF_END_HM]
        exitbar = rth[rth["hm"] <= cutoff_hm]
        if conf.empty or entrybar.empty or exitbar.empty:
            prev_close = rth.iloc[-1]["close"]
            continue
        conf_low = conf["low"].min()
        conf_high = conf["high"].max()
        entry = entrybar.iloc[0]["open"]
        exitp = exitbar.iloc[-1]["close"]
        year = int(g.iloc[0]["year"])
        if prev_close is not None:
            rows.append(dict(date=d, year=year, prev_close=prev_close, day_open=day_open,
                             conf_low=conf_low, conf_high=conf_high, entry=entry, exitp=exitp))
        prev_close = rth.iloc[-1]["close"]
    return pd.DataFrame(rows)


def stats_pts(pnl):
    p = pnl[np.isfinite(pnl)]
    if len(p) == 0:
        return dict(n=0, mean=np.nan, wr=np.nan, pf=np.nan, sh=np.nan, tot=np.nan)
    wins = p[p > 0].sum()
    losses = -p[p < 0].sum()
    pf = wins / losses if losses > 0 else np.inf
    sh = p.mean() / p.std(ddof=1) * np.sqrt(len(p)) if len(p) > 1 and p.std() > 0 else np.nan
    return dict(n=len(p), mean=p.mean(), wr=(p > 0).mean(), pf=pf, sh=sh, tot=p.sum())


def line(tag, pnl):
    s = stats_pts(pnl)
    print(f"    {tag:26s} n={s['n']:4d} mean={s['mean']:+6.2f}pt wr={s['wr']*100:4.1f}% "
          f"pf={s['pf']:.2f} sharpe={s['sh']:+.2f} totpts={s['tot']:+8.1f}")


def per_year(tag, D, pnl_col):
    print(f"    per-year [{tag}]:")
    for y in sorted(D["year"].unique()):
        sub = D[D["year"] == y]
        p = sub[pnl_col].values
        p = p[np.isfinite(p)]
        if len(p) == 0:
            continue
        wr = (p > 0).mean()
        print(f"      {y}: n={len(p):3d} mean={p.mean():+6.2f}pt wr={wr*100:4.1f}% tot={p.sum():+7.1f}pt")


def analyze(D, tol, gap_thr_pts):
    """Compute pnl columns and run the control comparison for a given tolerance + gap threshold."""
    gap = D["day_open"] - D["prev_close"]
    updir = gap > 0
    dndir = gap < 0
    big = gap.abs() >= gap_thr_pts

    long_pnl = D["exitp"] - D["entry"]            # long 9:50->close
    short_pnl = D["entry"] - D["exitp"]           # short 9:50->close
    gapdir_pnl = np.where(updir, long_pnl, np.where(dndir, short_pnl, np.nan))

    # confirmation: open held as extreme through 9:50
    conf_long = updir & (D["conf_low"] >= D["day_open"] - tol)   # never traded below open (bottom tick held)
    conf_short = dndir & (D["conf_high"] <= D["day_open"] + tol)  # never traded above open (top tick held)
    confirmed = (conf_long | conf_short)

    print(f"\n  --- tol={tol}pt  gap_thr={gap_thr_pts}pt  ({int(big.sum())} big-gap days of {len(D)}) ---")
    # baselines on big-gap days
    m = big.values
    line("UNCOND long", long_pnl.values[m])
    line("GAPDIR (no confirm)", gapdir_pnl[m])
    cm = (confirmed & big).values
    line("CONFIRMED (strategy)", gapdir_pnl[cm])
    line("FADE confirmed (placebo)", -gapdir_pnl[cm])
    # split up vs down among confirmed big-gap
    culm = (conf_long & big).values
    cshm = (conf_short & big).values
    line("  CONFIRMED up-gap long", long_pnl.values[culm])
    line("  CONFIRMED dn-gap short", short_pnl.values[cshm])
    # control: up-gap long WITHOUT confirmation (does the gate add anything?)
    line("  up-gap long (no confirm)", long_pnl.values[(updir & big).values])
    line("  dn-gap short (no confirm)", short_pnl.values[(dndir & big).values])
    return dict(confirmed=confirmed.values, updir=updir.values, dndir=dndir.values,
                big=big.values, long_pnl=long_pnl.values, short_pnl=short_pnl.values,
                gapdir_pnl=gapdir_pnl, conf_long=conf_long.values, conf_short=conf_short.values)


def main():
    print("Loading NQ continuous 1m ...", flush=True)
    df = load()
    print(f"  {len(df)} 1m bars, {df.etdate.min()}..{df.etdate.max()}", flush=True)
    D = build_days(df)
    D.to_csv("/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore/RG2-days-cache.csv", index=False)
    print(f"Built {len(D)} RTH days, {D.date.min()}..{D.date.max()} (cached)")
    gap = D["day_open"] - D["prev_close"]
    print(f"gap distribution (pts): mean={gap.mean():+.1f} std={gap.std():.1f} "
          f"|gap| median={gap.abs().median():.1f} p90={gap.abs().quantile(.9):.1f}")

    print(f"\n{'='*90}\nCONTROL COMPARISON (cutoff 15:45 ET) — is 'confirmed continuation' better than unconditional drift?\n{'='*90}")
    for gap_thr in [0, 30, 60, 100]:
        for tol in [0.0, 5.0]:
            res = analyze(D, tol, gap_thr)

    # per-year for the headline confirmed variant (tol=5, gap_thr=30)
    print(f"\n{'='*90}\nPER-YEAR DETAIL: CONFIRMED strategy (tol=5, gap_thr=30) vs UNCOND long, same big-gap days\n{'='*90}")
    res = analyze(D, 5.0, 30)
    D2 = D.copy()
    D2["conf_pnl"] = np.where(res["confirmed"], res["gapdir_pnl"], np.nan)
    D2["conf_pnl"] = np.where(res["big"], D2["conf_pnl"], np.nan)
    D2["uncond_pnl"] = np.where(res["big"], res["long_pnl"], np.nan)
    per_year("CONFIRMED", D2, "conf_pnl")
    per_year("UNCOND long (same days)", D2, "uncond_pnl")

    # up-gap-only long, confirmed, per-year (piece: works best up days)
    print(f"\n  up-gap-only CONFIRMED long, per-year:")
    D2["upconf_pnl"] = np.where(res["conf_long"] & res["big"], res["long_pnl"], np.nan)
    per_year("UPGAP CONFIRMED long", D2, "upconf_pnl")


if __name__ == "__main__":
    main()
