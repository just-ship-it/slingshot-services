#!/usr/bin/env python3
"""
RG2c — SPY daily gap continuation base-rates over 32 years (1994-2026).

The roguetrader piece was about SPX cash gaps. NQ intraday gave only ~50 confirmed events (thin).
Here we test the CORE claim on a long sample: do up-gaps CONTINUE (close finishes further in gap
direction) or FADE?  And is the "open = day's extreme" daily analog informative?

Caveats:
  - Daily bars cannot test the intraday "held open as extreme for 15-20 min" confirmation (that's RG2/RG2b).
  - "open near day's low" as a *filter* would be lookahead for an intraday entry; here it is used only
    descriptively (base-rate of the phenomenon), NOT as a tradable rule.
  - Tradable daily proxy tested honestly: enter at OPEN, exit at CLOSE, direction = sign(gap). No lookahead.
"""
import numpy as np
import pandas as pd

BASE = "/home/drew/projects/slingshot-services/backtest-engine"


def load(name):
    d = pd.read_csv(f"{BASE}/data/macro/{name}_1d.csv")
    d = d[["date", "open", "high", "low", "close"]].dropna()
    d["prev_close"] = d["close"].shift(1)
    d = d.dropna().reset_index(drop=True)
    d["year"] = d["date"].str.slice(0, 4).astype(int)
    d["gap"] = d["open"] - d["prev_close"]
    d["gap_pct"] = d["gap"] / d["prev_close"]
    d["o2c"] = d["close"] - d["open"]          # open->close move (the tradable daily hold)
    d["o2c_pct"] = d["o2c"] / d["open"]
    d["range"] = d["high"] - d["low"]
    # daily analog of "open held as extreme": open within X% of the day's extreme in gap direction
    d["open_is_low_frac"] = (d["open"] - d["low"]) / d["range"].replace(0, np.nan)   # 0 => open==low
    d["open_is_high_frac"] = (d["high"] - d["open"]) / d["range"].replace(0, np.nan)  # 0 => open==high
    return d


def summ(tag, o2c_pct):
    r = o2c_pct[np.isfinite(o2c_pct)]
    if len(r) == 0:
        print(f"  {tag}: n=0"); return
    wins, losses = r[r > 0].sum(), -r[r < 0].sum()
    pf = wins / losses if losses > 0 else np.inf
    sh = r.mean() / r.std(ddof=1) * np.sqrt(len(r)) if r.std() > 0 else np.nan
    print(f"  {tag:44s} n={len(r):5d} mean={r.mean()*100:+.3f}% wr={(r>0).mean()*100:4.1f}% pf={pf:.2f} sh={sh:+.2f}")


def run(name):
    d = load(name)
    print(f"\n{'='*88}\n{name.upper()} daily gaps  {d.date.min()}..{d.date.max()}  ({len(d)} days)\n{'='*88}")
    up = d["gap"] > 0
    dn = d["gap"] < 0
    big = d["gap_pct"].abs() >= 0.003   # >=0.3% gap ("big open")

    print("Tradable daily hold: enter OPEN, exit CLOSE, direction = sign(gap). (no lookahead)")
    # long on up-gaps, short on down-gaps -> gap continuation
    contin = np.where(up, d["o2c_pct"], np.where(dn, -d["o2c_pct"], np.nan))
    summ("ALL up-gap long (o->c)", d["o2c_pct"].values[up.values])
    summ("ALL up-gap long, BIG(>=0.3%)", d["o2c_pct"].values[(up & big).values])
    summ("ALL dn-gap SHORT (o->c)", (-d["o2c_pct"]).values[dn.values])
    summ("ALL dn-gap SHORT, BIG(>=0.3%)", (-d["o2c_pct"]).values[(dn & big).values])
    summ("baseline: every day long o->c", d["o2c_pct"].values)

    # descriptive: how often is the open the day's extreme in gap direction?
    print("\nDescriptive base-rates (NOT tradable — uses full-day extreme):")
    upbig = (up & big).values
    dnbig = (dn & big).values
    frac_openlow = d["open_is_low_frac"].values
    # among big up-gaps, share where open was within 5% of range from the low (near bottom tick)
    near_low = frac_openlow <= 0.05
    print(f"  big up-gap days: {upbig.sum()}, of which open within 5% of day-low: "
          f"{(upbig & near_low).sum()} ({100*(upbig & near_low).sum()/max(upbig.sum(),1):.1f}%)")
    # when open IS near the low on a big up-gap, what's the o->c?
    summ("  big up-gap & open~day-low -> long o->c", d["o2c_pct"].values[upbig & near_low])
    summ("  big up-gap & open NOT near low -> long o->c", d["o2c_pct"].values[upbig & ~near_low])

    # per-year tradable up-gap-big long
    print("\nper-year: BIG up-gap long (o->c):")
    for y in sorted(d["year"].unique()):
        m = (up & big).values & (d["year"].values == y)
        r = d["o2c_pct"].values[m]
        r = r[np.isfinite(r)]
        if len(r) < 3:
            continue
        print(f"    {y}: n={len(r):3d} mean={r.mean()*100:+.3f}% wr={(r>0).mean()*100:4.1f}% sum={r.sum()*100:+.1f}%")


def main():
    for name in ("spy", "nq"):
        run(name)
    print("\nNOTE: 'gap continuation' base rate here is the UNCONDITIONAL open->close hold. The RG2/RG2b")
    print("intraday '20-min hold' confirmation is what turns the thin NQ up-gap set from ~+1pt to ~+27pt;")
    print("this daily view only establishes whether gaps continue vs fade at the day scale.")


if __name__ == "__main__":
    main()
