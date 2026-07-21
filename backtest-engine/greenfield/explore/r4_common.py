#!/usr/bin/env python3
"""Shared stats for the R4 first-hour census. Descriptive only (no WR/PF/fills)."""
import numpy as np
import pandas as pd

def tstat(x):
    x = np.asarray(x, float); x = x[np.isfinite(x)]
    n = len(x)
    if n < 2: return np.nan, np.nan, n, np.nan
    mu = x.mean(); sd = x.std(ddof=1)
    t = mu / (sd / np.sqrt(n)) if sd > 0 else np.nan
    return mu, sd, n, t

def desc(x, label=""):
    mu, sd, n, t = tstat(x)
    return dict(label=label, n=n, mean=mu, sd=sd, t=t)

def line(d, unit=""):
    return f"{d['label']:<34s} n={d['n']:<5d} mean={d['mean']:+.4f}{unit} t={d['t']:+.2f}"

def per_year(df, valcol, yearcol="year"):
    """Return per-year mean/n/t; verdict STABLE(+/-) or MIXED."""
    out = []
    for y, g in df.groupby(yearcol):
        mu, sd, n, t = tstat(g[valcol].to_numpy())
        out.append((int(y), n, mu, t))
    signs = [np.sign(mu) for _, n, mu, t in out if np.isfinite(mu) and n >= 20]
    pos = sum(1 for s in signs if s > 0); neg = sum(1 for s in signs if s < 0)
    if signs and pos == len(signs): verdict = f"STABLE(+) {pos}/{len(signs)}"
    elif signs and neg == len(signs): verdict = f"STABLE(-) {neg}/{len(signs)}"
    else: verdict = f"MIXED({pos}+/{neg}-)"
    return out, verdict

def print_year(out, verdict, unit=""):
    s = "  ".join(f"{y}:{mu:+.3f}(n{n},t{t:+.1f})" for y, n, mu, t in out)
    print(f"    per-year [{verdict}]: {s}")

def pooled_vs_dayweighted(df, valcol, daycol="trade_date"):
    """For multi-fire-per-day signals. Returns (pooled_mean, dayw_mean, n_events, n_days)."""
    x = df[valcol].to_numpy(float); x = x[np.isfinite(x)]
    pooled = x.mean() if len(x) else np.nan
    dw = df.groupby(daycol)[valcol].mean()
    dayw = dw.mean()
    return pooled, dayw, len(x), df[daycol].nunique()
