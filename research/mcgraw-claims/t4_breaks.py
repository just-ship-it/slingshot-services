"""T4 - 'morning breaks travel further than afternoon breaks; dealer length installs ~1:30pm'
Break = first push through the prior 60-min high/low. Measure MFE over the next 30 min."""
import sys; sys.path.insert(0,'.')
import lib, numpy as np, pandas as pd
PV={'es':50.0,'nq':20.0}
for prod in ('nq','es'):
    d=lib.bars(prod); pv=PV[prod]
    d=d[(d.m>=570)&(d.m<=960)]
    rows=[]
    for day,g in d.groupby('day'):
        g=g.sort_values('m').reset_index(drop=True)
        if len(g)<300: continue
        hi=g.high.rolling(60).max().shift(1); lo=g.low.rolling(60).min().shift(1)
        for i in range(60,len(g)-30):
            up=g.high[i]>hi[i]; dn=g.low[i]<lo[i]
            if not (up or dn): continue
            fwd=g.iloc[i+1:i+31]
            ext=(fwd.high.max()-g.close[i]) if up else (g.close[i]-fwd.low.min())
            adv=(g.close[i]-fwd.low.min()) if up else (fwd.high.max()-g.close[i])
            rows.append(dict(day=day,m=g.m[i],up=up,ext=ext,adv=adv))
            break_done=True
    R=pd.DataFrame(rows)
    R['sess']=np.where(R.m<690,'open 9:30-11:30',np.where(R.m<810,'midday 11:30-13:30',
              np.where(R.m<870,'13:30-14:30','late 14:30-16:00')))
    print(f"\n{'='*86}\nT4  {prod.upper()}  60-min range breaks, MFE/MAE over next 30min  (n={len(R):,})\n{'='*86}")
    print(f"{'session':>22}{'n':>7}{'mean ext':>10}{'mean adv':>10}{'ext-adv':>9}{'edge $':>10}")
    for s in ['open 9:30-11:30','midday 11:30-13:30','13:30-14:30','late 14:30-16:00']:
        x=R[R.sess==s]
        if len(x)<50: continue
        e,a=x.ext.mean(),x.adv.mean()
        print(f"{s:>22}{len(x):>7}{e:>10.2f}{a:>10.2f}{e-a:>+9.2f}{(e-a)*pv:>+10,.0f}")
    pre=R[R.m<810]; post=R[R.m>=810]
    se=np.sqrt((pre.ext-pre.adv).var()/len(pre)+(post.ext-post.adv).var()/len(post))
    print(f"\n  before 13:30: ext-adv {(pre.ext-pre.adv).mean():+.2f}   after 13:30: {(post.ext-post.adv).mean():+.2f}"
          f"   diff t={((pre.ext-pre.adv).mean()-(post.ext-post.adv).mean())/se:+.2f}")
