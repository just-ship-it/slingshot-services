#!/usr/bin/env python3
"""ODTE-flow P1 / H1 — does pre-open 0DTE dealer-gamma SIGN govern the opening range & intraday mean-reversion?

Feature (causal, as-of prior close, knowable pre-open): net0_gamma_sign from qqq-0dte-daily.csv.
  +1 = dealers net LONG 0DTE gamma  -> hypothesis: they FADE -> tighter OR, more mean-reversion (pinning)
  -1 = dealers net SHORT 0DTE gamma -> hypothesis: they CHASE -> wider OR, more trend/expansion

NQ opening-range features (continuous 1m, 2025 window; pure price-action so continuous is fine):
  prev_rth_range (vol scale), OR = 9:30-10:00 ET (high/low/width), day open/close(15:45), day high/low.

Metrics (all vol-normalized by prev_rth_range):
  OR_width_n   = OR width / prev_range            -> pinning => smaller on +gamma
  day_range_n  = (dayHigh-dayLow) / prev_range    -> expansion; smaller on +gamma if pinned
  net_move_n   = |close-open| / prev_range         -> directional travel; smaller on +gamma
  close_in_OR  = close within [OR_low,OR_high]?     -> mean-reversion; higher on +gamma
  or_break_ext = how far beyond OR the day extended / prev_range

Controls: compare 0DTE sign vs ALL-DTE sign (netAll_sign) — does 0DTE-specific beat all-OI? (Drew's thesis)
and a shuffled-sign placebo (bootstrap difference-in-means p-value). Report POOLED and PER-QUARTER.
"""
import csv
import numpy as np
import pandas as pd
from zoneinfo import ZoneInfo

BASE = "/home/drew/projects/slingshot-services/backtest-engine"
ET = ZoneInfo("America/New_York")
OPEN_HM, OR_END_HM, C1545, CLOSE_HM = 9*60+30, 10*60, 15*60+45, 16*60
RNG = np.random.default_rng(20260723)


def build_nq_or():
    df = pd.read_csv(f"{BASE}/data/ohlcv/nq/NQ_ohlcv_1m_continuous.csv",
                     usecols=["ts_event", "open", "high", "low", "close"])
    ts = pd.to_datetime(df["ts_event"], utc=True).dt.tz_convert(ET)
    df["etdate"] = ts.dt.strftime("%Y-%m-%d")
    df["hm"] = (ts.dt.hour*60 + ts.dt.minute).astype(int)
    df = df[df["etdate"] >= "2025-01-15"]
    rows = []
    prev_close = prev_range = None
    for d, g in df.groupby("etdate", sort=True):
        rth = g[(g["hm"] >= OPEN_HM) & (g["hm"] < CLOSE_HM)]
        if len(rth) < 60:
            if len(rth):
                prev_close = rth.iloc[-1]["close"]
            continue
        ob = rth[rth["hm"] == OPEN_HM]
        orw = rth[(rth["hm"] >= OPEN_HM) & (rth["hm"] < OR_END_HM)]
        ex = rth[rth["hm"] <= C1545]
        if ob.empty or orw.empty or ex.empty:
            prev_close = rth.iloc[-1]["close"]
            continue
        day_open = ob.iloc[0]["open"]
        or_hi, or_lo = orw["high"].max(), orw["low"].min()
        close = ex.iloc[-1]["close"]
        day_hi, day_lo = rth["high"].max(), rth["low"].min()
        this_range = day_hi - day_lo
        nq_open_930 = day_open
        if prev_close is not None and prev_range is not None and prev_range > 0:
            rows.append(dict(date=d, prev_close=prev_close, prev_range=prev_range,
                             day_open=day_open, or_hi=or_hi, or_lo=or_lo, close=close,
                             day_hi=day_hi, day_lo=day_lo, nq_open=nq_open_930))
        prev_close = rth.iloc[-1]["close"]
        prev_range = this_range
    return pd.DataFrame(rows)


def stats_grp(v):
    v = v[np.isfinite(v)]
    return (len(v), v.mean() if len(v) else np.nan)


def boot_p(vpos, vneg):
    """two-sided bootstrap p on mean(vpos)-mean(vneg) via label shuffle."""
    vpos, vneg = vpos[np.isfinite(vpos)], vneg[np.isfinite(vneg)]
    if len(vpos) < 5 or len(vneg) < 5:
        return np.nan
    obs = vpos.mean() - vneg.mean()
    pool = np.concatenate([vpos, vneg])
    n1 = len(vpos)
    diffs = np.empty(10000)
    for i in range(10000):
        RNG.shuffle(pool)
        diffs[i] = pool[:n1].mean() - pool[n1:].mean()
    return (np.abs(diffs) >= abs(obs)).mean()


def report(df, signcol, metric, higher_is_pin=False):
    pos = df[df[signcol] == 1][metric].values
    neg = df[df[signcol] == -1][metric].values
    npos, mpos = stats_grp(pos)
    nneg, mneg = stats_grp(neg)
    p = boot_p(pos, neg)
    print(f"    {metric:12s} | +gamma n={npos:3d} mean={mpos:+.4f} | -gamma n={nneg:3d} mean={mneg:+.4f} "
          f"| Δ(+ − −)={mpos-mneg:+.4f} p={p:.3f}")


def main():
    q = pd.read_csv(f"{BASE}/research/odte-flow/qqq-0dte-daily.csv")
    nq = build_nq_or()
    df = nq.merge(q, on="date", how="inner")
    df["quarter"] = pd.PeriodIndex(pd.to_datetime(df["date"]), freq="Q").astype(str)
    print(f"joined {len(df)} days, {df.date.min()}..{df.date.max()}")

    df["OR_width_n"] = (df["or_hi"] - df["or_lo"]) / df["prev_range"]
    df["day_range_n"] = (df["day_hi"] - df["day_lo"]) / df["prev_range"]
    df["net_move_n"] = (df["close"] - df["day_open"]).abs() / df["prev_range"]
    df["close_in_OR"] = ((df["close"] <= df["or_hi"]) & (df["close"] >= df["or_lo"])).astype(float)
    df["or_break_ext"] = (np.maximum(df["day_hi"] - df["or_hi"], 0) +
                          np.maximum(df["or_lo"] - df["day_lo"], 0)) / df["prev_range"]

    metrics = ["OR_width_n", "day_range_n", "net_move_n", "close_in_OR", "or_break_ext"]

    print(f"\n{'='*90}\nH1a — 0DTE gamma SIGN vs opening-range / mean-reversion metrics (POOLED)")
    print("  hypothesis: +gamma(dealers long,fade) => SMALLER width/range/move, MORE close_in_OR, LESS break")
    print(f"{'='*90}")
    for m in metrics:
        report(df, "net0_gamma_sign", m)

    print(f"\n{'-'*90}\nCONTROL: same test on ALL-DTE gamma sign (does 0DTE-specific beat all-OI? Drew's thesis)\n{'-'*90}")
    for m in metrics:
        report(df, "netAll_sign", m)

    print(f"\n{'='*90}\nPER-QUARTER (0DTE sign) — stability check on the strongest metrics\n{'='*90}")
    for m in ["OR_width_n", "net_move_n", "close_in_OR"]:
        print(f"  [{m}]")
        for qtr in sorted(df["quarter"].unique()):
            sub = df[df["quarter"] == qtr]
            pos = sub[sub["net0_gamma_sign"] == 1][m].values
            neg = sub[sub["net0_gamma_sign"] == -1][m].values
            _, mp = stats_grp(pos); _, mn = stats_grp(neg)
            print(f"    {qtr}: +g n={np.isfinite(pos).sum():2d} {mp:+.4f} | -g n={np.isfinite(neg).sum():2d} {mn:+.4f} | Δ={mp-mn:+.4f}")

    # magnitude version: use continuous net0 gamma / absg0 as a strength, terciles
    print(f"\n{'='*90}\nH1b — gamma STRENGTH (signed net0 normalized by absg0), terciles vs metrics (pooled)\n{'='*90}")
    df["net0_norm"] = df["net0_gamma"].astype(float) / df["absg0"].astype(float)
    df["terc"] = pd.qcut(df["net0_norm"], 3, labels=["short", "mid", "long"])
    for m in ["OR_width_n", "net_move_n", "close_in_OR", "day_range_n"]:
        means = df.groupby("terc", observed=True)[m].mean()
        print(f"    {m:12s} short={means.get('short', float('nan')):+.4f} "
              f"mid={means.get('mid', float('nan')):+.4f} long={means.get('long', float('nan')):+.4f}")


if __name__ == "__main__":
    main()
