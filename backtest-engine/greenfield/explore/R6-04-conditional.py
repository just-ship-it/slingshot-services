#!/usr/bin/env python3
"""R6-04: conditional overnight structure.
H2 handoffs: does Asia move predict Europe move; Europe predict pre-NY?
H4 08:30 macro: is 08:30->09:00 move a continuation/fade of 08:15->08:30?
H5 Sunday: Monday-session (Sun 18:00 reopen) overnight vs weekdays.
H6 mean-reversion vs momentum: autocorr of 30m overnight returns (bounce caveat).
All conditioners knowable strictly before the outcome window.
"""
import numpy as np, pandas as pd
from R6lib import load_panel, clock_to_sm, window_return
from scipy import stats

NQ = load_panel('cache_nq_et_panel.csv.gz')
ES = load_panel('cache_es_et_panel.csv.gz')
b12=pd.read_csv('B12-days.csv'); atr=dict(zip(b12['trade_date'],b12['atr14_prior']))
YEARS=list(range(2021,2027))

def wr(s,sh,sm_,eh,em):
    x=window_return(s,clock_to_sm(sh,sm_),clock_to_sm(eh,em),max_gap=6)
    return x[0] if x else None

def build(panel):
    rows=[]
    for sd,s in panel.items():
        d=dict(sd=sd, year=s['year'], dow=s['dow'])
        d['asia']  = wr(s,19,0,2,0)     # 19:00->02:00
        d['eur']   = wr(s,2,0,5,0)      # 02:00->05:00
        d['preny'] = wr(s,5,0,9,29)     # 05:00->09:29
        d['pre0830']= wr(s,8,15,8,30)   # 08:15->08:30
        d['post0830']=wr(s,8,30,9,0)    # 08:30->09:00
        d['v0830'] = wr(s,8,29,8,31)    # tiny window around release for vol proxy
        # 08:30 release-minute abs range proxy
        rows.append(d)
    return pd.DataFrame(rows)

def cond(df, cond_col, out_col, label):
    d=df.dropna(subset=[cond_col,out_col])
    up=d[d[cond_col]>0][out_col]; dn=d[d[cond_col]<0][out_col]
    r,p=stats.pearsonr(d[cond_col],d[out_col])
    # per-year sign of correlation
    ys=[]
    for y in YEARS:
        dy=d[d['year']==y]
        if len(dy)>20:
            ry,_=stats.pearsonr(dy[cond_col],dy[out_col]); ys.append('+' if ry>0 else '-')
        else: ys.append('?')
    print(f"{label}: n={len(d)} corr={r:+.3f}(p={p:.3f}) yr[{''.join(ys)}]  "
          f"E[out|up]={up.mean():+.2f}(n{len(up)}) E[out|dn]={dn.mean():+.2f}(n{len(dn)}) "
          f"spread={up.mean()-dn.mean():+.2f}")

for src,panel in (('NQ',NQ),('ES',ES)):
    df=build(panel)
    print(f"\n========== {src} ==========")
    print("--- H2 handoffs (does earlier move predict later) ---")
    cond(df,'asia','eur',   ' asia->eur  ')
    cond(df,'eur','preny',  ' eur->preny ')
    cond(df,'asia','preny', ' asia->preny')
    print("--- H4 08:30 macro reaction (pre 08:15->08:30 vs post 08:30->09:00) ---")
    cond(df,'pre0830','post0830',' 0830 pre->post')
    # conditional on HIGH 08:30 vol (release proxy: top-quartile |pre0830|)
    d=df.dropna(subset=['pre0830','post0830'])
    thr=d['pre0830'].abs().quantile(0.75)
    hi=d[d['pre0830'].abs()>=thr]
    r,p=stats.pearsonr(hi['pre0830'],hi['post0830'])
    print(f"   [hi-vol proxy |pre|>={thr:.1f}] n={len(hi)} corr={r:+.3f}(p={p:.3f}) "
          f"E[post|preUp]={hi[hi.pre0830>0].post0830.mean():+.2f} E[post|preDn]={hi[hi.pre0830<0].post0830.mean():+.2f}")

    print("--- H5 Sunday(Mon-session dow=0) reopen vs other weekdays ---")
    df['reopen']=[wr(NQ.get(sd) if src=='NQ' else ES.get(sd),18,0,19,0) for sd in df['sd']]
    for name,mask in [('Mon(Sun-open)',df.dow==0),('Tue-Fri',df.dow.isin([1,2,3,4]))]:
        x=df[mask]['reopen'].dropna()
        print(f"   {name}: n={len(x)} mean_reopen={x.mean():+.2f} t={x.mean()/(x.std(ddof=1)/len(x)**0.5):+.2f}")

# H6 autocorrelation of 30m overnight returns (NQ)
print("\n--- H6 overnight 30m-return autocorrelation (NQ) ---")
allret=[]
for sd,s in NQ.items():
    seg=[]
    for a in range(0,900,30):
        x=window_return(s,a,a+30,max_gap=6)
        seg.append(x[0] if x else np.nan)
    allret.append(seg)
A=np.array(allret)
# lag-1 autocorr pooled across consecutive 30m overnight blocks
x=A[:,:-1].ravel(); y=A[:,1:].ravel()
m=~np.isnan(x)&~np.isnan(y)
r,p=stats.pearsonr(x[m],y[m])
print(f"   lag-1 autocorr of 30m overnight returns: r={r:+.3f} (p={p:.3g}, n={m.sum()})")
print("   (near 0 => efficient/no momentum; negative => mean-revert, possibly bounce artifact)")
