#!/usr/bin/env python3
"""
RG1 — Squeeze-Precursor swing signal (roguetrader "Flagging Potential Short Squeezes").

Hypothesis (source: C:\\Users\\Drew\\OneDrive\\Documents\\Trading\\Flagging_Potential_Short_Squeezes.pdf):
  A bull gamma-squeeze in SPX is FORESHADOWED 1-2 days ahead by two conditions together:
    (A) ATM CALL implied vol trading at a PREMIUM to ATM PUT implied vol  (unusual; normally puts richer)
    (B) VIX put/call ratio elevated (> ~0.67 in the piece)
  -> go long, hold 1-2 days.

Data available:
  (A) SPY dte0 call_iv / put_iv  -> data/iv/spy/spy_short_dte_iv_daily.csv  (2023-03 .. 2026-01, BINDING window)
  (B) CBOE put/call ratios (equity/index/total) -> data/macro/pc*_1d.csv    (2006/07 .. 2026, proxy for VIX P/C)
  Targets: SPY (data/macro/spy_1d.csv), NQ (data/macro/nq_1d.csv). VIX context: data/macro/vix_1d.csv

Method:
  - Signal known at CLOSE of day T (all inputs EOD).  Trade enters at OPEN of T+1, exits at CLOSE of T+H.
  - Long-only (up-day bias per piece).  H in {1,2,3}.
  - Report signal group vs all-days baseline vs signal-FALSE placebo, pooled AND per-year.
  - Side-matched placebo: bootstrap random same-size samples -> empirical p-value on mean fwd return.
  - Test A alone / B alone / A&B combined, threshold sweep on B, both SPY and NQ targets.

NOTE: this is a screen, not a deployable number. No transaction cost model beyond a sensitivity note.
"""
import sys
import numpy as np
import pandas as pd

DATA = "/home/drew/projects/slingshot-services/backtest-engine/data"
RNG = np.random.default_rng(20260722)


def load():
    iv = pd.read_csv(f"{DATA}/iv/spy/spy_short_dte_iv_daily.csv")
    iv["date"] = iv["timestamp"].astype(str)
    iv = iv[["date", "dte0_call_iv", "dte0_put_iv", "dte0_skew", "dte0_avg_iv", "quality"]]

    def pc(name, col):
        d = pd.read_csv(f"{DATA}/macro/{name}_1d.csv")[["date", "close"]].rename(columns={"close": col})
        return d
    pce = pc("pcequity", "pc_eq")
    pci = pc("pcindex", "pc_idx")
    pct = pc("pctotal", "pc_tot")
    vix = pd.read_csv(f"{DATA}/macro/vix_1d.csv")[["date", "close"]].rename(columns={"close": "vix"})

    def tgt(name):
        d = pd.read_csv(f"{DATA}/macro/{name}_1d.csv")[["date", "open", "high", "low", "close"]]
        return d.rename(columns={c: f"{name}_{c}" for c in ["open", "high", "low", "close"]})
    spy = tgt("spy")
    nq = tgt("nq")

    # base calendar = SPY daily (tradable, longest)
    df = spy.merge(nq, on="date", how="left").merge(vix, on="date", how="left")
    df = df.merge(pce, on="date", how="left").merge(pci, on="date", how="left").merge(pct, on="date", how="left")
    df = df.merge(iv, on="date", how="left")
    df = df.sort_values("date").reset_index(drop=True)
    df["year"] = df["date"].str.slice(0, 4).astype(int)
    return df


def fwd_returns(df, tgt, H):
    """Enter at open[T+1], exit at close[T+H]. Return known/realized, indexed at signal day T."""
    o = df[f"{tgt}_open"].values
    c = df[f"{tgt}_close"].values
    n = len(df)
    ret = np.full(n, np.nan)
    for t in range(n - H):
        entry = o[t + 1]
        exitp = c[t + H]
        if entry > 0 and np.isfinite(entry) and np.isfinite(exitp):
            ret[t] = exitp / entry - 1.0
    return ret


def stats(rets):
    r = rets[np.isfinite(rets)]
    if len(r) == 0:
        return dict(n=0, mean=np.nan, med=np.nan, wr=np.nan, pf=np.nan, sharpe=np.nan)
    wins = r[r > 0].sum()
    losses = -r[r < 0].sum()
    pf = wins / losses if losses > 0 else np.inf
    sharpe = r.mean() / r.std(ddof=1) * np.sqrt(len(r)) if len(r) > 1 and r.std() > 0 else np.nan
    return dict(n=len(r), mean=r.mean(), med=np.median(r), wr=(r > 0).mean(), pf=pf, sharpe=sharpe)


def bootstrap_p(all_ret, sig_ret, iters=20000):
    """Empirical p-value: prob a random same-size draw from all_ret has mean >= sig mean."""
    base = all_ret[np.isfinite(all_ret)]
    sig = sig_ret[np.isfinite(sig_ret)]
    k = len(sig)
    if k == 0 or len(base) < k:
        return np.nan
    obs = sig.mean()
    idx = RNG.integers(0, len(base), size=(iters, k))
    means = base[idx].mean(axis=1)
    return (means >= obs).mean()


def report_signal(df, label, mask, targets=("spy", "nq"), holds=(1, 2, 3)):
    print(f"\n{'='*90}\nSIGNAL: {label}   (fires on {int(mask.sum())} of {len(df)} days, "
          f"{100*mask.mean():.1f}%)")
    win = df.loc[mask, "date"]
    if len(win):
        print(f"   active window: {win.min()} .. {win.max()}")
    for tgt in targets:
        for H in holds:
            ret = fwd_returns(df, tgt, H)
            sig = ret[mask.values]
            allr = ret
            plac = ret[(~mask).values]
            s = stats(sig)
            b = stats(allr)
            p = stats(plac)
            pv = bootstrap_p(allr, sig)
            edge = (s["mean"] - b["mean"]) * 10000  # bps vs baseline
            print(f"  {tgt.upper()} H={H}d | SIG n={s['n']:4d} mean={s['mean']*100:+.3f}% wr={s['wr']*100:4.1f}% "
                  f"pf={s['pf']:.2f} sh={s['sharpe']:+.2f} | base mean={b['mean']*100:+.3f}% | "
                  f"placebo mean={p['mean']*100:+.3f}% | edge={edge:+.1f}bps p={pv:.3f}")


def per_year(df, label, mask, tgt="spy", H=2):
    ret = fwd_returns(df, tgt, H)
    print(f"\n  per-year [{label}] {tgt.upper()} H={H}d:")
    for y in sorted(df["year"].unique()):
        ym = mask.values & (df["year"].values == y)
        r = ret[ym]
        r = r[np.isfinite(r)]
        if len(r) == 0:
            continue
        wr = (r > 0).mean()
        print(f"    {y}: n={len(r):3d}  mean={r.mean()*100:+.3f}%  wr={wr*100:4.1f}%  sum={r.sum()*100:+.2f}%")


def main():
    df = load()
    print(f"Loaded {len(df)} SPY-calendar days, {df.date.min()}..{df.date.max()}")
    ivmask = df["dte0_call_iv"].notna()
    print(f"IV (signal A) available on {int(ivmask.sum())} days ({df.loc[ivmask,'date'].min()}..{df.loc[ivmask,'date'].max()})")
    pcmask = df["pc_eq"].notna()
    print(f"P/C (signal B) available on {int(pcmask.sum())} days ({df.loc[pcmask,'date'].min()}..{df.loc[pcmask,'date'].max()})")

    # ---- Signal A: call IV > put IV (skew<0), quality>=2 ----
    A = (df["dte0_call_iv"] > df["dte0_put_iv"]) & (df["quality"] >= 2)
    A = A.fillna(False)
    report_signal(df, "A: call_iv > put_iv (SPY dte0)", A)
    per_year(df, "A", A)

    # ---- Signal B: put/call ratio elevated (equity P/C), threshold sweep ----
    print(f"\n{'#'*90}\n# SIGNAL B threshold sweep (equity P/C > thr)  -- 2007..2026 window\n{'#'*90}")
    for thr in [0.60, 0.67, 0.75, 0.85, 1.00, 1.15]:
        B = (df["pc_eq"] > thr).fillna(False)
        report_signal(df, f"B: pc_eq > {thr}", B, holds=(1, 2))
    # percentile-based (top decile of trailing 1y)
    pc = df["pc_eq"]
    roll_q = pc.rolling(252, min_periods=60).quantile(0.90)
    Bp = (pc > roll_q).fillna(False)
    report_signal(df, "B: pc_eq > trailing-1y 90th pctile", Bp, holds=(1, 2, 3))
    per_year(df, "B_pctile", Bp)

    # index & total P/C variants at the piece's spirit-threshold (top-quartile trailing)
    for name, col in [("index", "pc_idx"), ("total", "pc_tot")]:
        s = df[col]
        rq = s.rolling(252, min_periods=60).quantile(0.90)
        m = (s > rq).fillna(False)
        report_signal(df, f"B: pc_{name} > trailing-1y 90th pctile", m, holds=(1, 2))

    # ---- Combined A & B (overlap window 2023-03..2026-01) ----
    print(f"\n{'#'*90}\n# COMBINED A & B (IV-window overlap)\n{'#'*90}")
    for thr in [0.67, 0.85, 1.00]:
        AB = (A & (df["pc_eq"] > thr)).fillna(False)
        report_signal(df, f"A & (pc_eq>{thr})", AB, holds=(1, 2, 3))
    ABp = (A & Bp).fillna(False)
    report_signal(df, "A & (pc_eq>90pctile)", ABp, holds=(1, 2, 3))
    per_year(df, "A&Bpctile", ABp)

    # ---- context: does signal coincide with LOW vix / falling vix (complacency)? ----
    print(f"\n{'#'*90}\n# VIX-context conditioning on Signal B(pctile)\n{'#'*90}")
    vix_falling = (df["vix"] < df["vix"].shift(1)).fillna(False)
    vix_low = (df["vix"] < df["vix"].rolling(60, min_periods=20).median()).fillna(False)
    report_signal(df, "Bpctile & vix_falling", (Bp & vix_falling), holds=(1, 2))
    report_signal(df, "Bpctile & vix_below_60d_median", (Bp & vix_low), holds=(1, 2))


if __name__ == "__main__":
    main()
