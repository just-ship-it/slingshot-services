#!/usr/bin/env python3
"""Phase 1 analysis — do direction-aware LT-level geometry features predict outcome,
and do they add edge ON TOP of the proven ltAlign gate?"""
import numpy as np, pandas as pd, os
HERE = os.path.dirname(os.path.abspath(__file__))
df = pd.read_csv(os.path.join(HERE,'output','lt-geom-features.csv'))
out=[]
def p(*a):
    s=' '.join(str(x) for x in a); print(s); out.append(s)
def pf(s):
    w=s[s>0].sum(); l=-s[s<0].sum(); return (w/l) if l>0 else float('inf')

N=len(df); p(f"N={N}  baseWR={df.label.mean()*100:.1f}%  PF={pf(df.netPnL):.2f}  totPnL=${df.netPnL.sum():,.0f}  avg=${df.netPnL.mean():.1f}")
p("="*96)

NUM=['stackPos','stopBackstopAtr','targetHeadroomAtr','nearestLevelAtr','l1DistAtr','nAbove','nBelow']
p("\n### Numeric geometry features — corr + quintile WR/PF\n")
res=[]
for c in NUM:
    s=df[[c,'label','netPnL']].dropna()
    if len(s)<200 or s[c].nunique()<5: continue
    corr=np.corrcoef(s[c],s.label)[0,1]
    s=s.copy(); s['q']=pd.qcut(s[c].rank(method='first'),5,labels=False)
    wr=s.groupby('q').label.mean(); pfq=s.groupby('q').netPnL.apply(pf)
    res.append((c,corr,wr,pfq,s))
res.sort(key=lambda r:-abs(r[1]))
for c,corr,wr,pfq,s in res:
    p(f"{c:<18} corr={corr:+.3f}  WR%[{' '.join(f'{x*100:4.0f}' for x in wr)}]  PF[{' '.join(f'{x:4.2f}' for x in pfq)}]")

p("\n### Binary geometry features (WR / PF / avg$ / n)\n")
for c in ['targetBlocked','flipAtLevel_05','flipAtLevel_10','flipAtLevel_3pt','l1OnTargetSide']:
    if c not in df: continue
    p(f"\n{c}:")
    for k,sub in df.groupby(c):
        p(f"  {c}={k}  n={len(sub):4d}  WR={sub.label.mean()*100:4.1f}%  PF={pf(sub.netPnL):.2f}  avg=${sub.netPnL.mean():5.1f}")

# ---- the key test: does geometry add edge ON TOP of ltAlign? ----
p("\n"+"="*96)
p("### Does geometry add edge on top of ltAlign?  (split by ltAlign, then by each geom feature)\n")
def rule(name,mask):
    s=df.netPnL[mask]
    p(f"  {name:<46} n={mask.sum():5d}  WR={df.label[mask].mean()*100:4.1f}%  PF={pf(s):.2f}  avg=${s.mean():5.1f}  totPnL=${s.sum():>9,.0f}")
rule("ALL", pd.Series(True,index=df.index))
rule("ltAlign==1 (proven gate)", df.ltAlign==1)
p("  --- within ltAlign==1, add a geometry filter: ---")
A=df.ltAlign==1
rule("  + targetBlocked==0 (clear path to TP)", A&(df.targetBlocked==0))
rule("  + targetBlocked==1 (level blocks TP)", A&(df.targetBlocked==1))
rule("  + flipAtLevel_10==1 (flip at a level)", A&(df.flipAtLevel_10==1))
rule("  + flipAtLevel_10==0 (open space)", A&(df.flipAtLevel_10==0))
rule("  + stopBackstop<1 ATR (close support)", A&(df.stopBackstopAtr<1))
rule("  + targetHeadroom>=targetDist/atr", A&(df.targetHeadroomAtr>=df.targetDist/df.atr))
rule("  + l1OnTargetSide==1", A&(df.l1OnTargetSide==1))
rule("  + stackPos mid (0.2-0.8)", A&(df.stackPos.between(0.2,0.8)))
p("  --- best stack candidates: ---")
rule("ltAlign & targetBlocked==0", A&(df.targetBlocked==0))
rule("ltAlign & targetBlocked==0 & flipAtLevel_10", A&(df.targetBlocked==0)&(df.flipAtLevel_10==1))
rule("ltAlign & flipAtLevel_10 & stopBackstop<1", A&(df.flipAtLevel_10==1)&(df.stopBackstopAtr<1))

# also: geometry WITHOUT ltAlign (standalone value?)
p("\n### Geometry standalone (ignoring ltAlign) — is flip-at-level its own edge?\n")
rule("flipAtLevel_10==1", df.flipAtLevel_10==1)
rule("flipAtLevel_10==0", df.flipAtLevel_10==0)
rule("targetBlocked==0", df.targetBlocked==0)

with open(os.path.join(HERE,'output','06-lt-geom-analyze.txt'),'w') as f: f.write('\n'.join(out))
print("\n[wrote output/06-lt-geom-analyze.txt]")
