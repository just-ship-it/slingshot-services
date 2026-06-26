#!/usr/bin/env python3
"""
LS-Flip Meta-Labeling — purged walk-forward meta-labeler.

The trustworthy test: can features known at the flip instant predict win/loss
OUT-OF-SAMPLE? We use time-ordered expanding-window walk-forward (train on past,
predict future) so there is zero look-ahead. We report:
  - OOS AUC per fold + pooled
  - in-sample vs OOS gap (overfit check)
  - permutation importance (which features the model actually uses)
  - the money table: if we keep only the top-K% by predicted P(win), what is the
    OOS WR / PF / total PnL / avg$ on the kept subset, vs the full baseline?
  - comparison vs simple hand-rules (range-only, ltAlign, hour-RTH)

Caveat printed in output: per-trade filtered metrics are an UPPER bound on live
benefit because the FCFS 1-slot rule re-fills dropped slots (see 04-replay.js).
"""
import numpy as np, pandas as pd, os
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score
from sklearn.inspection import permutation_importance

HERE = os.path.dirname(os.path.abspath(__file__))
df = pd.read_csv(os.path.join(HERE,'output','features.csv')).sort_values('flipTs').reset_index(drop=True)
out=[]
def p(*a):
    s=' '.join(str(x) for x in a); print(s); out.append(s)

FEATURES = ['isLong','hourEt','dowEt','range','cbAtr','rangeRatio','closePos','retraceDepth','bodyFrac',
            'upperWick','lowerWick','secsSinceLast','flips1h','flips2h','distHi20','distLo20','distHi60',
            'distLo60','posInRange60','ret20','ret60','emaSlope20','entryVsEma20','volRatio','volZ',
            'ltDist','ltAlign','gexDistFlip','gexAboveFlip','gexDistWall','gexRegimePos','barsToFill','fillDelay']
FEATURES=[f for f in FEATURES if f in df.columns]
X = df[FEATURES].astype(float).values
y = df['label'].values
pnl = df['netPnL'].values
N=len(df)
base_wr=y.mean(); base_pnl=pnl.sum()
p(f"N={N}  features={len(FEATURES)}  baseWR={base_wr*100:.1f}%  totalPnL=${base_pnl:,.0f}  avg=${base_pnl/N:.1f}")
p("="*100)

def pf_of(mask):
    s=pnl[mask]; w=s[s>0].sum(); l=-s[s<0].sum(); return (w/l) if l>0 else float('inf')

# ---------- purged walk-forward (expanding window) ----------
NFOLD=6
EMBARGO=500   # trades (~ a few days) gap between train end and test start
oof_proba=np.full(N,np.nan)
fold_bounds=np.linspace(int(N*0.4), N, NFOLD+1).astype(int)  # first 40% = initial train
p("\n### Purged walk-forward folds (expanding train, embargo=%d trades)\n"%EMBARGO)
is_aucs=[]; oos_aucs=[]
for k in range(NFOLD):
    te0,te1=fold_bounds[k],fold_bounds[k+1]
    tr_end=max(0,te0-EMBARGO)
    if tr_end<300:
        continue
    Xtr,ytr=X[:tr_end],y[:tr_end]
    Xte,yte=X[te0:te1],y[te0:te1]
    m=HistGradientBoostingClassifier(max_depth=3,learning_rate=0.05,max_iter=300,
                                     l2_regularization=1.0,min_samples_leaf=80,
                                     early_stopping=True,validation_fraction=0.15,random_state=0)
    m.fit(Xtr,ytr)
    pr=m.predict_proba(Xte)[:,1]
    oof_proba[te0:te1]=pr
    is_auc=roc_auc_score(ytr,m.predict_proba(Xtr)[:,1])
    oos_auc=roc_auc_score(yte,pr) if len(np.unique(yte))>1 else float('nan')
    is_aucs.append(is_auc); oos_aucs.append(oos_auc)
    p(f"  fold{k}: train[0:{tr_end}] test[{te0}:{te1}] (n={te1-te0})  IS_AUC={is_auc:.3f}  OOS_AUC={oos_auc:.3f}")
p(f"\n  mean IS_AUC={np.nanmean(is_aucs):.3f}   mean OOS_AUC={np.nanmean(oos_aucs):.3f}   (0.50=no signal)")
mask_oof=~np.isnan(oof_proba)
pooled_auc=roc_auc_score(y[mask_oof],oof_proba[mask_oof])
p(f"  pooled OOS AUC (all walk-forward test trades)={pooled_auc:.3f}")

# ---------- money table on OOS predictions ----------
p("\n### OOS filter table — keep top-K% by predicted P(win) (walk-forward test trades only)\n")
idx=np.where(mask_oof)[0]
po=oof_proba[idx]; yo=y[idx]; pno=pnl[idx]
order=np.argsort(-po)  # high proba first
M=len(idx)
p(f"  OOS universe: {M} trades  baseWR={yo.mean()*100:.1f}%  PF={pf_of(np.ones(N,bool)&mask_oof):.2f}  totPnL=${pno.sum():,.0f}  avg=${pno.mean():.1f}")
p(f"\n  {'keep':>6}{'n':>6}{'WR%':>7}{'PF':>6}{'avg$':>7}{'totPnL':>11}{'thresh':>8}")
for keep in [1.0,0.9,0.8,0.7,0.6,0.5,0.4,0.3]:
    k=int(M*keep); sel=order[:k]
    s=pno[sel]; w=s[s>0].sum(); l=-s[s<0].sum(); pf=(w/l) if l>0 else float('inf')
    thr=po[order[k-1]]
    p(f"  {keep*100:5.0f}%{k:6d}{yo[sel].mean()*100:7.1f}{pf:6.2f}{s.mean():7.1f}{s.sum():11,.0f}{thr:8.3f}")

# ---------- hand-rule baselines (OOS universe, for fair comparison) ----------
p("\n### Hand-rule baselines on same OOS universe (no ML)\n")
sub=df.iloc[idx]
def rule(name,mask):
    m=mask.values if hasattr(mask,'values') else mask
    s=pno[m]; w=s[s>0].sum(); l=-s[s<0].sum(); pf=(w/l) if l>0 else float('inf')
    p(f"  {name:<34} n={m.sum():5d} ({m.mean()*100:4.0f}%)  WR={yo[m].mean()*100:4.1f}%  PF={pf:.2f}  avg=${s.mean():5.1f}  totPnL=${s.sum():>9,.0f}")
rule("ALL (baseline)", np.ones(M,bool))
rule("ltAlign==1", sub['ltAlign']==1)
rule("range>=8", sub['range']>=8)
rule("hour in 9-14 ET", sub['hourEt'].between(9,14))
rule("ltAlign==1 & range>=8", (sub['ltAlign']==1)&(sub['range']>=8))
rule("ltAlign==1 & hour 9-14", (sub['ltAlign']==1)&(sub['hourEt'].between(9,14)))
rule("ltAlign & range>=8 & hr9-14", (sub['ltAlign']==1)&(sub['range']>=8)&(sub['hourEt'].between(9,14)))
rule("gexRegime==neg", sub['gexRegimePos']==0)
rule("ltAlign & gexNeg", (sub['ltAlign']==1)&(sub['gexRegimePos']==0))
rule("drop hour 0-4 ET", ~sub['hourEt'].between(0,4))
rule("ltAlign & drop 0-4 & range>=5", (sub['ltAlign']==1)&(~sub['hourEt'].between(0,4))&(sub['range']>=5))

# ---------- permutation importance (final model on last fold split) ----------
p("\n### Permutation importance (model trained on first 70%, scored on last 30% OOS)\n")
cut=int(N*0.7)
m=HistGradientBoostingClassifier(max_depth=3,learning_rate=0.05,max_iter=300,l2_regularization=1.0,
                                 min_samples_leaf=80,early_stopping=True,validation_fraction=0.15,random_state=0)
m.fit(X[:cut],y[:cut])
r=permutation_importance(m,X[cut:],y[cut:],n_repeats=10,random_state=0,scoring='roc_auc')
imp=sorted(zip(FEATURES,r.importances_mean,r.importances_std),key=lambda t:-t[1])
for f,mu,sd in imp:
    bar='#'*int(max(0,mu)*500)
    p(f"  {f:<16}{mu:+.4f} ± {sd:.4f}  {bar}")

with open(os.path.join(HERE,'output','03-metalabel-cv.txt'),'w') as fh:
    fh.write('\n'.join(out))
print("\n[wrote output/03-metalabel-cv.txt]")
