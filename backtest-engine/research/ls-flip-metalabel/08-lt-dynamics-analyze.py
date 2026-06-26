#!/usr/bin/env python3
"""Phase 1b — do LT level DYNAMICS (crossing/migration vs spot) predict outcome,
standalone and on top of ltAlign?"""
import numpy as np, pandas as pd, os
HERE=os.path.dirname(os.path.abspath(__file__))
df=pd.read_csv(os.path.join(HERE,'output','lt-dynamics-features.csv'))
out=[]
def p(*a):
    s=' '.join(str(x) for x in a);print(s);out.append(s)
def pf(s):
    w=s[s>0].sum();l=-s[s<0].sum();return (w/l) if l>0 else float('inf')
N=len(df);p(f"N={N}  baseWR={df.label.mean()*100:.1f}%  PF={pf(df.netPnL):.2f}  totPnL=${df.netPnL.sum():,.0f}")
p("="*96)

NUM=['naNow','dNA5','dNA15','nearAbove','nearBelow','barsSinceCross','crossCount15','spotSlope','lvlSlope']
p("\n### Numeric dynamics — corr + quintile WR/PF\n")
res=[]
for c in NUM:
    s=df[[c,'label','netPnL']].dropna()
    if len(s)<200 or s[c].nunique()<5: continue
    corr=np.corrcoef(s[c],s.label)[0,1]
    s=s.copy();s['q']=pd.qcut(s[c].rank(method='first'),5,labels=False)
    wr=s.groupby('q').label.mean();pfq=s.groupby('q').netPnL.apply(pf)
    res.append((c,corr,wr,pfq))
res.sort(key=lambda r:-abs(r[1]))
for c,corr,wr,pfq in res:
    p(f"{c:<14} corr={corr:+.3f}  WR%[{' '.join(f'{x*100:4.0f}' for x in wr)}]  PF[{' '.join(f'{x:4.2f}' for x in pfq)}]")

p("\n### Binary/categorical dynamics (WR / PF / avg$ / n)\n")
for c in ['lastCrossDir','crossAlign','migAlign','insideBand']:
    p(f"\n{c}:")
    for k,sub in df.groupby(c):
        if len(sub)<40: continue
        p(f"  {c}={k:<5} n={len(sub):4d}  WR={sub.label.mean()*100:4.1f}%  PF={pf(sub.netPnL):.2f}  avg=${sub.netPnL.mean():5.1f}")

p("\n"+"="*96)
p("### Interaction with ltAlign — does a dynamics filter add edge on top?\n")
def rule(name,m):
    s=df.netPnL[m];p(f"  {name:<44} n={m.sum():5d}  WR={df.label[m].mean()*100:4.1f}%  PF={pf(s):.2f}  avg=${s.mean():5.1f}  totPnL=${s.sum():>9,.0f}")
A=df.ltAlign==1
rule("ALL", pd.Series(True,index=df.index))
rule("ltAlign==1", A)
rule("  + crossAlign==1 (recent cross w/ flip)", A&(df.crossAlign==1))
rule("  + crossAlign==0 (recent cross vs flip)", A&(df.crossAlign==0))
rule("  + migAlign==1 (spot migrating w/ flip)", A&(df.migAlign==1))
rule("  + migAlign==0 (migrating against)", A&(df.migAlign==0))
rule("  + barsSinceCross<=3 (fresh cross)", A&(df.barsSinceCross<=3))
rule("  + insideBand==1", A&(df.insideBand==1))
rule("  + insideBand==0 (spot outside levels)", A&(df.insideBand==0))
rule("  + crossCount15==0 (quiet, no crosses)", A&(df.crossCount15==0))
rule("  + crossCount15>=3 (churny)", A&(df.crossCount15>=3))

p("\n### Standalone dynamics (ignoring ltAlign) — own edge?\n")
rule("crossAlign==1", df.crossAlign==1)
rule("crossAlign==0", df.crossAlign==0)
rule("migAlign==1", df.migAlign==1)
rule("migAlign==0", df.migAlign==0)
rule("insideBand==0", df.insideBand==0)

with open(os.path.join(HERE,'output','08-lt-dynamics-analyze.txt'),'w') as f: f.write('\n'.join(out))
print("\n[wrote output/08-lt-dynamics-analyze.txt]")
