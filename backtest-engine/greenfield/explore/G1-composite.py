#!/usr/bin/env python3
"""G1 STEP 5 — 3-sleeve vs 4-sleeve composite over the BOOK ERA (2021+), where all
sleeves coexist. Decides whether gold lowers book DD / raises Sharpe or just adds return."""
import glob, os, numpy as np, pandas as pd
BASE=os.path.dirname(os.path.abspath(__file__)); ANN=np.sqrt(252); START="2021-01-01"

def load():
    m={}
    for p in sorted(glob.glob(os.path.join(BASE,"book-*-daily.csv"))):
        if p.endswith("book-combined-equity.csv"): continue
        name=os.path.basename(p)[5:-10]
        df=pd.read_csv(p,parse_dates=["date"])
        m[name]=df.groupby("date")["pnl"].sum().sort_index()
    return m

def metrics(s):
    p=s.values; total=p.sum(); eq=np.cumsum(p); dd=float((eq-np.maximum.accumulate(eq)).min())
    pos=p[p>0].sum(); neg=-p[p<0].sum(); pf=pos/neg if neg>0 else float("inf")
    sd=p.std(ddof=1); sh=p.mean()/sd*ANN if sd>0 else float("nan")
    act=int((p!=0).sum()); wr=100*(p[p!=0]>0).mean() if act else float("nan")
    return dict(total=total,maxdd=dd,pf=pf,sharpe=sh,active=act,wr=wr,rdd=total/abs(dd) if dd<0 else float("inf"))

def show(M,label):
    cal=M.index
    print(f"\n{'='*70}\n{label}: {cal[0].date()} -> {cal[-1].date()} ({len(cal)} cal days)\n{'='*70}")
    print(f"{'sleeve':12s}{'days':>6s}{'WR':>6s}{'PF':>6s}{'Sharpe':>8s}{'maxDD':>11s}{'total':>11s}{'ret/DD':>8s}")
    for col in M.columns:
        m=metrics(M[col])
        print(f"{col:12s}{m['active']:6d}{m['wr']:5.0f}%{m['pf']:6.2f}{m['sharpe']:8.2f}${m['maxdd']:>9,.0f}${m['total']:>10,.0f}{m['rdd']:7.2f}x")
    book=M.sum(axis=1); bm=metrics(book)
    print("-"*70)
    print(f"{'BOOK':12s}{bm['active']:6d}{bm['wr']:5.0f}%{bm['pf']:6.2f}{bm['sharpe']:8.2f}${bm['maxdd']:>9,.0f}${bm['total']:>10,.0f}{bm['rdd']:7.2f}x")
    return bm

if __name__=="__main__":
    m=load()
    # restrict every sleeve to book era, build union calendar over book-era equity sleeves
    equity=["pcc","monday","gapfade"]
    all4=["pcc","monday","gapfade","gold"]
    def frame(names):
        series={n:m[n][m[n].index>=START] for n in names}
        cal=sorted(set().union(*[set(s.index) for s in series.values()]))
        cal=pd.DatetimeIndex(cal)
        return pd.DataFrame({n:series[n].reindex(cal).fillna(0.0) for n in names})

    M3=frame(equity); b3=show(M3,"3-SLEEVE BOOK (equity only, 2021+)")
    M4=frame(all4);   b4=show(M4,"4-SLEEVE BOOK (+ gold, 2021+)")

    print(f"\n{'='*70}\nDIVERSIFICATION VERDICT (book era 2021+)\n{'='*70}")
    print(f"  3-sleeve: Sharpe {b3['sharpe']:.2f}  maxDD ${b3['maxdd']:,.0f}  total ${b3['total']:,.0f}  ret/DD {b3['rdd']:.2f}x")
    print(f"  4-sleeve: Sharpe {b4['sharpe']:.2f}  maxDD ${b4['maxdd']:,.0f}  total ${b4['total']:,.0f}  ret/DD {b4['rdd']:.2f}x")
    print(f"  ΔSharpe = {b4['sharpe']-b3['sharpe']:+.2f}   ΔmaxDD = ${b4['maxdd']-b3['maxdd']:+,.0f} "
          f"({'better' if b4['maxdd']>b3['maxdd'] else 'worse'})   Δtotal = ${b4['total']-b3['total']:+,.0f}")

    # correlation of gold vs each equity sleeve + vs 3-sleeve book (book-era union of all 4)
    print(f"\nCorrelation (book era, union calendar, 0-filled):")
    book3=M4[equity].sum(axis=1)
    cm=M4.corr()
    print(cm.round(3).to_string())
    print(f"  gold vs 3-sleeve book combined = {np.corrcoef(M4['gold'], book3)[0,1]:.3f}")

    # contract-balance note
    print(f"\nScale: gold=MGC $10/pt, equity sleeves=NQ 1-lot ($20/pt). "
          f"Gold daily $ std=${M4['gold'].std():.0f} vs 3-sleeve book std=${book3.std():.0f}.")
    print(f"  To match gold risk to book, MGC contracts ~= {book3.std()/M4['gold'].std():.1f}x "
          f"(but that also scales gold DD).")
