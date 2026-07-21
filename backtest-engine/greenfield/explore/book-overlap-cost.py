#!/usr/bin/env python3
"""
Single-slot (one-position-one-trade) overlap cost analysis (2026-07-18).

Question: if we keep the existing "one broker position at a time per account"
rule and simply SKIP a strategy's trade whenever it would collide with an
already-open trade (FCFS by entry time), how much does the composite book
degrade vs the independent-slot composite?

No system code changes — pure backtest arithmetic on the confirmed book members.

Strategies trade at FIXED clock windows (ET), so occupancy is deterministic:
  gapfade  09:30 -> 11:00   (entry 570, exit 660  minutes-of-day)
  monday   09:30 -> 15:45   (entry 570, exit 945)
  pcc      15:00 -> 15:30   (entry 900, exit 930)
Single slot, FCFS: process a day's trades in entry-time order; accept a trade
only if the slot is free at its entry (prior accepted trade already exited);
else DROP it. 09:30 ties (gap-up Mondays: monday vs gapfade) broken by priority.
"""
import glob, os
import numpy as np
import pandas as pd

BASE = os.path.dirname(os.path.abspath(__file__))
ANN = np.sqrt(252)
WIN = {  # strat -> (entry_min, exit_min)
    "gapfade": (570, 660),
    "monday":  (570, 945),
    "pcc":     (900, 930),
}


def load():
    m = {}
    for path in glob.glob(os.path.join(BASE, "book-*-daily.csv")):
        name = os.path.basename(path)[len("book-"):-len("-daily.csv")]
        if name == "combined":
            continue
        df = pd.read_csv(path, parse_dates=["date"])
        m[name] = df.groupby("date")["pnl"].sum()
    return m


def metrics(daily):
    pnl = daily.values
    total = pnl.sum()
    eq = np.cumsum(pnl); peak = np.maximum.accumulate(eq)
    maxdd = float((eq - peak).min())
    pos, neg = pnl[pnl > 0].sum(), -pnl[pnl < 0].sum()
    pf = pos / neg if neg > 0 else float("inf")
    sd = pnl.std(ddof=1)
    sharpe = pnl.mean() / sd * ANN if sd > 0 else float("nan")
    return total, pf, sharpe, maxdd


def resolve_day(present, priority):
    """present: list of strat names trading that date. Return (accepted, dropped)."""
    trades = sorted(present, key=lambda s: (WIN[s][0], priority.index(s)))
    accepted, dropped, occupied_until = [], [], -1
    for s in trades:
        e, x = WIN[s]
        if e >= occupied_until:
            accepted.append(s); occupied_until = x
        else:
            dropped.append(s)
    return accepted, dropped


def build_book(members, priority):
    cal = sorted(set().union(*[set(s.index) for s in members.values()]))
    rows, drop_log = [], []
    for d in cal:
        present = [s for s in members if d in members[s].index]
        accepted, dropped = resolve_day(present, priority)
        rows.append((d, sum(members[s][d] for s in accepted)))
        for s in dropped:
            drop_log.append((d, s, float(members[s][d])))
    book = pd.Series(dict(rows)).sort_index()
    return book, pd.DataFrame(drop_log, columns=["date", "strategy", "pnl"])


def main():
    members = load()
    cal = sorted(set().union(*[set(s.index) for s in members.values()]))
    baseline = pd.Series({d: sum(members[s][d] for s in members if d in members[s].index)
                          for d in cal}).sort_index()

    bt, bpf, bsh, bdd = metrics(baseline)
    print("=" * 78)
    print("SINGLE-SLOT OVERLAP COST — one position / one trade at a time, one account")
    print("=" * 78)
    print(f"\nBASELINE (independent slots, the composite as reported):")
    print(f"  total ${bt:,.0f}   PF {bpf:.3f}   Sharpe {bsh:.2f}   maxDD ${bdd:,.0f}")

    for label, priority in [("Monday-priority (natural FCFS)", ["monday", "gapfade", "pcc"]),
                            ("Gapfade-priority at 09:30 ties", ["gapfade", "monday", "pcc"])]:
        book, drops = build_book(members, priority)
        t, pf, sh, dd = metrics(book)
        print(f"\nSINGLE-SLOT — {label}:")
        print(f"  total ${t:,.0f}   PF {pf:.3f}   Sharpe {sh:.2f}   maxDD ${dd:,.0f}")
        print(f"  Δ vs baseline: PnL ${t-bt:,.0f} ({100*(t-bt)/bt:+.1f}%)  "
              f"Sharpe {sh-bsh:+.2f}  maxDD ${dd-bdd:,.0f}")
        if len(drops):
            by = drops.groupby("strategy")["pnl"].agg(["count", "sum"])
            print(f"  dropped trades:")
            for strat, r in by.iterrows():
                print(f"    {strat:9s} {int(r['count']):4d} trades, "
                      f"forgone PnL ${r['sum']:,.0f}")
            # dropped-trade win/loss split — dropping LOSERS actually helps
            w = (drops.pnl > 0).sum(); l = (drops.pnl < 0).sum()
            print(f"    (of dropped: {w} were winners, {l} were losers — "
                  f"forgone net ${drops.pnl.sum():,.0f})")

    # How many days have any conflict at all?
    conflict_days = sum(
        1 for d in cal
        if len(resolve_day([s for s in members if d in members[s].index],
                           ["monday", "gapfade", "pcc"])[1]) > 0)
    print(f"\nConflict frequency: {conflict_days} of {len(cal)} trading days "
          f"({100*conflict_days/len(cal):.1f}%) drop at least one trade.")
    print("=" * 78)


if __name__ == "__main__":
    main()
