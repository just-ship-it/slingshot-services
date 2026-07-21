#!/usr/bin/env python3
"""
Composite BOOK harness (greenfield book program, 2026-07-18).

Goal: run N confirmed strategies together and MEASURE whether the book is smoother
than its parts — combined PF / daily-Sharpe / max-drawdown, the pairwise daily-PnL
correlation matrix, and the diversification benefit (book DD vs sum of individual
DDs). "Smoother equity curve" becomes a measured fact, not a hope.

Input contract: one CSV per strategy named  book-<name>-daily.csv  with columns
  date,pnl        (date = YYYY-MM-DD trade date; pnl = net $ that day, 1 contract;
                   aggregate if a strategy trades more than once/day)
Add a strategy to the book by dropping its book-<name>-daily.csv here and re-running.

Convention: returns are indexed on the UNION trading calendar (every date on which
ANY book member traded). A member contributes 0 on days it does not trade (it sat in
cash). Individual and book metrics use this same index so they are directly
comparable. Daily Sharpe annualized by sqrt(252).

Bootstrap: (re)builds book-pcc-daily.csv from B4a-fullrun-equity.csv if present, so
PCC (confirmed edge #1) is always in the book at whatever slippage that file holds.
"""
import glob
import os
import numpy as np
import pandas as pd

BASE = os.path.dirname(os.path.abspath(__file__))
ANN = np.sqrt(252)


def bootstrap_pcc():
    src = os.path.join(BASE, "B4a-fullrun-equity.csv")
    if not os.path.exists(src):
        return
    e = pd.read_csv(src)
    daily = e.groupby("date")["pnl"].sum().reset_index()
    daily.to_csv(os.path.join(BASE, "book-pcc-daily.csv"), index=False)


def load_members():
    members = {}
    for path in sorted(glob.glob(os.path.join(BASE, "book-*-daily.csv"))):
        name = os.path.basename(path)[len("book-"):-len("-daily.csv")]
        df = pd.read_csv(path, parse_dates=["date"])
        s = df.groupby("date")["pnl"].sum().sort_index()
        members[name] = s
    return members


def metrics(series):
    """series: daily pnl indexed on the union calendar (0-filled). Returns dict."""
    pnl = series.values
    total = pnl.sum()
    eq = np.cumsum(pnl)
    peak = np.maximum.accumulate(eq)
    maxdd = float((eq - peak).min())  # <= 0
    pos, neg = pnl[pnl > 0].sum(), -pnl[pnl < 0].sum()
    pf = (pos / neg) if neg > 0 else float("inf")
    sd = pnl.std(ddof=1)
    sharpe = (pnl.mean() / sd * ANN) if sd > 0 else float("nan")
    active = int((pnl != 0).sum())
    wr = 100.0 * (pnl[pnl != 0] > 0).mean() if active else float("nan")
    return dict(total=total, maxdd=maxdd, pf=pf, sharpe=sharpe,
                active_days=active, day_wr=wr, ret_over_dd=(total / abs(maxdd)) if maxdd < 0 else float("inf"))


def main():
    bootstrap_pcc()
    members = load_members()
    if not members:
        print("No book-*-daily.csv members found."); return

    # Union trading calendar; 0-fill each member on days it didn't trade.
    cal = sorted(set().union(*[set(s.index) for s in members.values()]))
    cal = pd.DatetimeIndex(cal)
    M = pd.DataFrame({name: s.reindex(cal).fillna(0.0) for name, s in members.items()})

    print("=" * 74)
    print(f"COMPOSITE BOOK — {len(members)} strateg{'y' if len(members)==1 else 'ies'} | "
          f"union calendar {cal[0].date()} → {cal[-1].date()} ({len(cal)} trading days)")
    print("=" * 74)

    # Per-strategy
    print(f"\n{'strategy':16s} {'days':>5s} {'dayWR':>6s} {'PF':>6s} {'Sharpe':>7s} "
          f"{'maxDD':>10s} {'totalPnL':>11s} {'ret/DD':>7s}")
    indiv = {}
    for name in M.columns:
        m = metrics(M[name]); indiv[name] = m
        print(f"{name:16s} {m['active_days']:5d} {m['day_wr']:5.1f}% {m['pf']:6.2f} "
              f"{m['sharpe']:7.2f} ${m['maxdd']:>9,.0f} ${m['total']:>10,.0f} {m['ret_over_dd']:6.2f}x")

    # Book (sum across strategies per day)
    book = M.sum(axis=1)
    bm = metrics(book)
    print("-" * 74)
    print(f"{'BOOK (combined)':16s} {bm['active_days']:5d} {bm['day_wr']:5.1f}% {bm['pf']:6.2f} "
          f"{bm['sharpe']:7.2f} ${bm['maxdd']:>9,.0f} ${bm['total']:>10,.0f} {bm['ret_over_dd']:6.2f}x")

    # Diversification benefit
    sum_dd = sum(abs(indiv[n]['maxdd']) for n in M.columns)
    best_sharpe = max(indiv[n]['sharpe'] for n in M.columns)
    print(f"\nDiversification:")
    print(f"  Σ individual maxDD = ${sum_dd:,.0f}   book maxDD = ${abs(bm['maxdd']):,.0f}   "
          f"→ DD reduction {100*(1 - abs(bm['maxdd'])/sum_dd):.1f}%" if sum_dd else "")
    print(f"  best individual Sharpe = {best_sharpe:.2f}   book Sharpe = {bm['sharpe']:.2f}   "
          f"→ {'+' if bm['sharpe']>best_sharpe else ''}{bm['sharpe']-best_sharpe:.2f}")

    # Pairwise correlation of daily PnL (lower = better diversification)
    if len(M.columns) > 1:
        print(f"\nDaily-PnL correlation (union calendar, 0-filled — lower is better):")
        corr = M.corr()
        print(corr.round(3).to_string())
        iu = np.triu_indices(len(M.columns), 1)
        print(f"  mean pairwise corr = {corr.values[iu].mean():.3f}")
    else:
        print(f"\n(Only one strategy in the book — add more book-*-daily.csv to measure "
              f"correlation & the diversification benefit.)")

    # Combined equity curve out
    out = pd.DataFrame({"date": cal, "book_pnl": book.values,
                        "book_cum": np.cumsum(book.values)})
    out.to_csv(os.path.join(BASE, "book-combined-equity.csv"), index=False)
    print(f"\nwrote book-combined-equity.csv")


if __name__ == "__main__":
    main()
