#!/usr/bin/env python3
"""
M2 shared library: honest daily swing simulation for gold/crude.

Measurement protocol (KNOWABILITY-compliant, no lookahead):
 - Signal computed from data KNOWN at day-D close (features use close[D] and earlier).
 - Enter at OPEN of D+1.
 - Exit at CLOSE of D+N (fixed N-day hold) unless signal-reversal exit specified.
 - PnL in POINTS = dir*(exit - entry); $ via micro point-value; costs subtracted.

Contracts (micro sizing for realistic 1-lot):
   GC/MGC: $10 per 1.0 pt. tick 0.1pt=$1. RT cost = 2 ticks slip + comm ~ 0.35 pt = $3.5
   CL/MCL: $100 per 1.0 pt. tick 0.01pt=$1. RT cost = 2 ticks slip + comm ~ 0.035 pt = $3.5
"""
import pandas as pd, numpy as np

MACRO = "/home/drew/projects/slingshot-services/backtest-engine/data/macro"

SPEC = {
    "gc": dict(pt_value=10.0,  cost_pts=0.35),   # MGC micro
    "cl": dict(pt_value=100.0, cost_pts=0.035),  # MCL micro
}

REGIMES = [
    ("2008 GFC",        "2007-07-01","2009-06-30"),
    ("2014-16 oilcrash","2014-07-01","2016-03-31"),
    ("2020 COVID",      "2020-02-01","2020-12-31"),
    ("2022 stress",     "2022-01-01","2022-12-31"),
]

def load(sym):
    df = pd.read_csv(f"{MACRO}/{sym}_1d.csv", parse_dates=["date"])
    df = df.sort_values("date").reset_index(drop=True)
    df["ret"] = df["close"].pct_change()
    df["logret"] = np.log(df["close"]/df["close"].shift(1))
    return df

def simulate(df, entry_mask, direction, hold, sym, min_gap=0):
    """
    df: daily OHLCV (must have open,high,low,close,date), 0..N-1 index contiguous.
    entry_mask: boolean Series aligned to df index; True on day-D means signal fired at D close.
    direction: +1 long, -1 short, or a Series of +-1 aligned to df index.
    hold: N trading days; enter open[D+1], exit close[D+hold].
    min_gap: enforce no overlapping trades (skip signals while a trade is live).
    Returns per-trade DataFrame.
    """
    o = df["open"].values; c = df["close"].values; dt = df["date"].values
    n = len(df)
    if np.isscalar(direction):
        dirs = np.full(n, direction)
    else:
        dirs = np.asarray(direction)
    spec = SPEC[sym]
    idx = np.where(entry_mask.values if hasattr(entry_mask,"values") else entry_mask)[0]
    trades = []
    last_exit = -1
    for D in idx:
        ent_i = D + 1
        ext_i = D + hold
        if ext_i >= n: continue
        if min_gap and ent_i <= last_exit: continue
        entry = o[ent_i]; exitp = c[ext_i]; d = dirs[D]
        gross = d * (exitp - entry)
        net = gross - spec["cost_pts"]
        trades.append(dict(
            sig_date=pd.Timestamp(dt[D]), entry_date=pd.Timestamp(dt[ent_i]),
            exit_date=pd.Timestamp(dt[ext_i]), dir=d, entry=entry, exit=exitp,
            gross_pts=gross, net_pts=net, net_usd=net*spec["pt_value"],
            year=pd.Timestamp(dt[D]).year))
        last_exit = ext_i
    return pd.DataFrame(trades)

def stats(tr, sym):
    if len(tr)==0: return dict(n=0)
    pv = SPEC[sym]["pt_value"]
    net = tr["net_pts"]
    usd = tr["net_usd"]
    wins = net>0
    pf_num = net[net>0].sum(); pf_den = -net[net<0].sum()
    pf = pf_num/pf_den if pf_den>0 else np.inf
    return dict(
        n=len(tr),
        wr=wins.mean(),
        med_pts=net.median(), mean_pts=net.mean(),
        med_usd=usd.median(), mean_usd=usd.mean(),
        tot_usd=usd.sum(),
        pf=pf,
        sharpe=(net.mean()/net.std()*np.sqrt(len(net))) if net.std()>0 else np.nan,  # per-sample t-stat
        p25=net.quantile(.25), p75=net.quantile(.75),
    )

def fmt_stats(s):
    if s.get("n",0)==0: return "  (no trades)"
    return (f"n={s['n']:>4} WR={s['wr']*100:>5.1f}% med=${s['med_usd']:>7.0f} "
            f"mean=${s['mean_usd']:>7.0f} tot=${s['tot_usd']:>9.0f} PF={s['pf']:>4.2f} t={s['sharpe']:>5.2f}")

def baseline_forward(df, hold, sym, direction=1):
    """Unconditional: enter EVERY day, same hold. Drift baseline."""
    mask = pd.Series(True, index=df.index)
    tr = simulate(df, mask, direction, hold, sym, min_gap=0)
    return stats(tr, sym)

def per_year(tr, sym):
    out=[]
    for y in sorted(tr["year"].unique()):
        s = stats(tr[tr.year==y], sym)
        out.append((y, s))
    return out

def per_regime(tr, sym):
    out=[]
    for name,lo,hi in REGIMES:
        sub = tr[(tr.sig_date>=lo)&(tr.sig_date<=hi)]
        out.append((name, stats(sub, sym)))
    return out

def placebo(df, n_entries, direction, hold, sym, iters=500, seed=1):
    """Random matched entries: same count, random dates, same hold/dir. Returns mean_usd dist."""
    rng = np.random.default_rng(seed)
    valid = np.arange(0, len(df)-hold-1)
    means=[]; tots=[]
    for _ in range(iters):
        pick = rng.choice(valid, size=min(n_entries,len(valid)), replace=False)
        mask = pd.Series(False, index=df.index); mask.iloc[pick]=True
        tr = simulate(df, mask, direction, hold, sym, min_gap=0)
        s = stats(tr, sym)
        means.append(s["mean_usd"]); tots.append(s["tot_usd"])
    return np.array(means), np.array(tots)

def placebo_p(observed_mean, placebo_means):
    """Two-sided-ish: fraction of placebo runs with mean >= observed (for long-edge)."""
    return (placebo_means >= observed_mean).mean()
