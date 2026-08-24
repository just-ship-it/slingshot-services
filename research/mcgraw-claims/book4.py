"""4-strategy NQ book, FCFS-honest, annualised over the window where ALL FOUR exist."""
import sys; sys.path.insert(0,'.')
import lib, numpy as np, pandas as pd, json, collections
OH='/home/drew/projects/slingshot-services/backtest-engine/data/ohlcv/'
B='/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore/'
# --- rebuild LETF daily PnL 1s-honest, 1 tick/side ---
cfg=dict(f=OH+'nq/NQ_ohlcv_1s_continuous.csv',ix=OH+'nq/NQ_ohlcv_1s_continuous.index.json')
ix={int(k):v for k,v in json.load(open(cfg['ix']))['minutes'].items()}
d=lib.bars('nq'); g=lib.gex('nq')
S=lib.sessions(d,{'o':570,'m1530':930}); G=lib.daily_gex_sign(g,929)
M=S.merge(G,on='day',how='inner').dropna(subset=['tot']).sort_values('day')
M['r_day']=100*(M.m1530/M.o-1); M['gpos']=M.tot>0
big=M[M.r_day.abs()>=M.r_day.abs().quantile(.5)].copy()
big['dirn']=np.where(big.gpos,-np.sign(big.r_day),np.sign(big.r_day))
fh=open(cfg['f'],'rb'); rows=[]
for _,r in big.iterrows():
    base=pd.Timestamp(r.day).tz_localize('America/New_York'); bars=[]
    for mm in range(929,948):
        t=(base+pd.Timedelta(minutes=mm)).tz_convert('UTC'); e=ix.get(int(t.timestamp()*1000))
        if not e: continue
        fh.seek(e['offset'])
        for line in fh.read(e['length']).decode('utf-8','ignore').split('\n'):
            p=line.split(',')
            if len(p)<8: continue
            try: bars.append((p[0].replace(' ','T'),float(p[1])))
            except: pass
    ti=(base+pd.Timedelta(minutes=930)).tz_convert('UTC').strftime('%Y-%m-%dT%H:%M:%S')
    to=(base+pd.Timedelta(minutes=945)).tz_convert('UTC').strftime('%Y-%m-%dT%H:%M:%S')
    a=next((px for ts,px in bars if ts>=ti),None); b=next((px for ts,px in bars if ts>=to),None)
    if a is None or b is None: continue
    rows.append((r.day, r.dirn*((b-r.dirn*0.25)-(a+r.dirn*0.25))*20.0-4.0))
fh.close()
pd.DataFrame(rows,columns=['date','pnl']).to_csv(B+'book-letf-daily.csv',index=False)
print(f"LETF 1s-honest daily written: n={len(rows)} net=${sum(p for _,p in rows):+,.0f}")
# --- FCFS over the 4 NQ sleeves ---
SL={'gapfade':(570,660),'monday':(570,945),'pcc':(900,930),'letf':(930,945)}
dd={}
for k in SL:
    x=pd.read_csv(B+f'book-{k}-daily.csv'); x['date']=pd.to_datetime(x.date).dt.date
    dd[k]=dict(zip(x.date,x.pnl))
START=min(dd['letf']); END=max(dd['letf'])
print(f"\ncommon window (all 4 live): {START} .. {END}")
def run(pri, lo, hi, slots):
    kept=collections.defaultdict(list)
    days=sorted({d for k in slots for d in dd[k] if lo<=d<=hi})
    for day in days:
        free=0
        for st,_,k in sorted([(slots[k][0],pri.index(k),k) for k in slots if day in dd[k]]):
            if st>=free: kept[k].append((day,dd[k][day])); free=slots[k][1]
    return kept
def met(kept,yrs):
    tot=collections.defaultdict(float)
    for k,v in kept.items():
        for day,p in v: tot[day]+=p
    s=pd.Series(tot).sort_index(); a=s.values
    w=a[a>0]; l=a[a<=0]; pf=w.sum()/abs(l.sum())
    eq=np.cumsum(a); mdd=(np.maximum.accumulate(eq)-eq).max()
    return pf,a.sum(),mdd,a.mean()/a.std()*np.sqrt(252),len(a),a.sum()/yrs
yrs=(pd.Timestamp(END)-pd.Timestamp(START)).days/365.25
pri=['gapfade','monday','pcc','letf']
print(f"span {yrs:.2f} yr\n")
print(f"{'book':<26}{'PF':>6}{'net':>12}{'$/yr':>11}{'maxDD':>10}{'Sharpe':>8}{'days':>7}")
for lbl,slots in (('3 sleeves (no letf)',{k:v for k,v in SL.items() if k!='letf'}),
                  ('4 sleeves (with letf)',SL)):
    kept=run(pri,START,END,slots); pf,net,mdd,sh,n,py=met(kept,yrs)
    print(f"{lbl:<26}{pf:>6.2f}{net:>+12,.0f}{py:>+11,.0f}{mdd:>10,.0f}{sh:>8.2f}{n:>7}")
    for k in slots:
        v=kept[k]; print(f"    {k:<10} fired {len(v):>4}  net ${sum(p for _,p in v):>+9,.0f}  ${sum(p for _,p in v)/yrs:>+8,.0f}/yr")
