#!/usr/bin/env python3
"""
M1-01: Broad cross-market divergence screen.
All features knowable at day-D close; entry D+1 open. Screens families 1-7.
Emits M1-candidates.csv (every signal x horizon) + prints per-family tables.
"""
import pandas as pd, numpy as np, sys
from m1_common import (load_panel, measure, baseline_moves, dist_stats, fmt_stats,
                       regime_of, STRESS_WINDOWS)

P = load_panel()

# ---------- feature engineering (all as-of day D close) ----------
def ret(col, n=1): return P[col].pct_change(n)
def logret(col, n=1): return np.log(P[col]).diff(n)
def zscore(s, w):
    m = s.rolling(w).mean(); sd = s.rolling(w).std()
    return (s - m) / sd
def chg(col, n=1): return P[col].diff(n)   # level change (for VIX)

F = pd.DataFrame(index=P.index)
# equity
F['nq_r1']=ret('nq_close'); F['nq_r3']=ret('nq_close',3); F['nq_r5']=ret('nq_close',5)
F['spy_r5']=ret('spy_close',5)
# credit
F['hyg_r5']=ret('hyg_close',5); F['hyg_r3']=ret('hyg_close',3); F['hyg_r10']=ret('hyg_close',10)
F['hyglqd']=P['hyg_close']/P['lqd_close']
F['hyglqd_r5']=F['hyglqd'].pct_change(5); F['hyglqd_r10']=F['hyglqd'].pct_change(10)
F['hyglqd_z']=zscore(F['hyglqd'],60)
F['hyg_vs_spy_5']=ret('hyg_close',5)-ret('spy_close',5)      # credit rel strength
F['hyg_vs_spy_10']=ret('hyg_close',10)-ret('spy_close',10)
F['hyg_z']=zscore(P['hyg_close'],60)
# rates
F['tlt_r3']=ret('tlt_close',3); F['tlt_r5']=ret('tlt_close',5)
F['ief_r5']=ret('ief_close',5)
F['corr_nq_tlt_20']=P['nq_close'].pct_change().rolling(20).corr(P['tlt_close'].pct_change())
F['corr_nq_tlt_40']=P['nq_close'].pct_change().rolling(40).corr(P['tlt_close'].pct_change())
F['corr_nq_tlt_60']=P['nq_close'].pct_change().rolling(60).corr(P['tlt_close'].pct_change())
F['tlt_z']=zscore(P['tlt_close'],60)
# dollar
F['dxy_r5']=ret('dxy_close',5); F['dxy_r3']=ret('dxy_close',3); F['dxy_r10']=ret('dxy_close',10)
F['dxy_z']=zscore(P['dxy_close'],60)
F['uup_r5']=ret('uup_close',5)
# vol
F['vix']=P['vix_close']; F['vix_c5']=chg('vix_close',5); F['vix_c3']=chg('vix_close',3)
F['vix_c1']=chg('vix_close',1)
F['vix_z']=zscore(P['vix_close'],60)
F['vix_pctile']=P['vix_close'].rolling(252).apply(lambda x:(x[-1]>x).mean(),raw=True)
# breadth
F['iwm_r5']=ret('iwm_close',5); F['iwm_r10']=ret('iwm_close',10)
F['iwm_vs_spy_5']=ret('iwm_close',5)-ret('spy_close',5)
F['iwm_vs_spy_10']=ret('iwm_close',10)-ret('spy_close',10)
F['iwm_vs_nq_5']=ret('iwm_close',5)-ret('nq_close',5)
# cross-asset
F['gld_r5']=ret('gld_close',5); F['gld_r10']=ret('gld_close',10)
F['gld_vs_spy_5']=ret('gld_close',5)-ret('spy_close',5)
F['btc_r5']=ret('btc_close',5); F['btc_r10']=ret('btc_close',10)
# NQ extreme vs its own trend (mean-reversion)
F['nq_z20']=zscore(P['nq_close'],20)
F['nq_r10']=ret('nq_close',10)

# ---------- risk-off composite (family 6) ----------
# each component z-scored so higher = more stress; sum
comp = pd.DataFrame(index=P.index)
comp['credit'] = -zscore(ret('hyg_close',5),120)     # credit down = stress
comp['dollar'] =  zscore(ret('dxy_close',5),120)     # dollar up = stress
comp['vix']    =  zscore(chg('vix_close',5),120)     # vix up = stress
comp['bonds']  =  zscore(ret('tlt_close',5),120)     # bonds bid = stress
comp['gold']   =  zscore(ret('gld_close',5),120)     # gold bid = stress
F['riskoff']   = comp.mean(axis=1)                    # mean of available components
F['riskoff_z'] = zscore(F['riskoff'],120)

# ---------- signal definitions: (name, family, mask_expr, direction, note) ----------
# direction +1 long / -1 short. Masks reference F columns.
def pct(col, q): return F[col].rolling(252,min_periods=120).quantile(q)

signals = []
def add(name, fam, mask, direction, note):
    signals.append((name, fam, mask, direction, note))

# --- F1 credit-leads-equity (defensive short) ---
add('C1_hyg_r5_botdecile','credit', F['hyg_r5']<=pct('hyg_r5',0.10), -1,'HYG 5d ret in bottom 10% -> credit stress -> short')
add('C2_hyglqd_r5_botdecile','credit', F['hyglqd_r5']<=pct('hyglqd_r5',0.10), -1,'HY/IG ratio 5d in bottom 10% (spread widening) -> short')
add('C3_hyg_vs_spy_neg','credit', F['hyg_vs_spy_5']<=pct('hyg_vs_spy_5',0.10), -1,'credit lagging equity (bottom 10%) -> short')
add('C4_hyglqd_z_low','credit', F['hyglqd_z']<=-1.5, -1,'HY/IG ratio z<-1.5 -> short')
add('C5_hyg_r10_botdecile','credit', F['hyg_r10']<=pct('hyg_r10',0.10), -1,'HYG 10d ret bottom 10% -> short')
# long side (credit strong -> risk-on)
add('C6_hyg_r5_topdecile_long','credit', F['hyg_r5']>=pct('hyg_r5',0.90), +1,'HYG 5d ret top 10% -> risk-on -> long')

# --- F2 rates ---
add('R1_corr_pos_bondsdown','rates', (F['corr_nq_tlt_40']>0)&(F['tlt_r5']<0), -1,'stock-bond corr>0 & bonds falling -> risk-parity unwind -> short')
add('R2_corr_pos','rates', F['corr_nq_tlt_40']>0.2, -1,'corr(NQ,TLT,40d)>0.2 -> both-fall regime risk -> short')
add('R3_tlt_spike_up','rates', F['tlt_r3']>=pct('tlt_r3',0.90), -1,'TLT 3d spike up (flight to safety) -> short')
add('R4_tlt_dump','rates', F['tlt_r3']<=pct('tlt_r3',0.10), -1,'TLT 3d dump (yield spike) -> short')
add('R5_tlt_dump_long','rates', F['tlt_r3']<=pct('tlt_r3',0.10), +1,'TLT 3d dump -> yields up growth -> long(test)')

# --- F3 dollar ---
add('D1_dxy_r5_topdecile','dollar', F['dxy_r5']>=pct('dxy_r5',0.90), -1,'DXY 5d ret top 10% (dollar spike) -> headwind -> short')
add('D2_dxy_r3_topdecile','dollar', F['dxy_r3']>=pct('dxy_r3',0.90), -1,'DXY 3d spike -> short')
add('D3_dxy_z_high','dollar', F['dxy_z']>=1.5, -1,'DXY z>1.5 -> short')
add('D4_dxy_r5_botdecile_long','dollar', F['dxy_r5']<=pct('dxy_r5',0.10), +1,'DXY falling (easing) -> long')

# --- F4 vol divergence ---
add('V1_vix_up_nq_up','vol', (F['nq_r5']>0)&(F['vix_c5']>0), -1,'VIX rising while NQ rising (no confirm) -> pullback -> short')
add('V2_vix_spike','vol', F['vix_c5']>=pct('vix_c5',0.90), -1,'VIX 5d spike top 10% -> short')
add('V3_vix_up_nq_up_strong','vol', (F['nq_r5']>0.01)&(F['vix_c5']>0)&(F['vix_z']>0.5), -1,'strong price-vol divergence -> short')
add('V4_vix_high','vol', F['vix_pctile']>=0.90, -1,'VIX in top decile of 1y -> short(test)')
add('V5_vix_low_long','vol', F['vix_pctile']<=0.10, +1,'VIX bottom decile -> calm -> long(test)')

# --- F5 breadth ---
add('B1_iwm_vs_spy_neg','breadth', F['iwm_vs_spy_5']<=pct('iwm_vs_spy_5',0.10), -1,'small caps lagging (bottom 10%) -> breadth deteriorating -> short')
add('B2_iwm_vs_nq_neg','breadth', F['iwm_vs_nq_5']<=pct('iwm_vs_nq_5',0.10), -1,'IWM lagging NQ (bottom10) -> narrow breadth -> short')
add('B3_iwm_r10_weak','breadth', F['iwm_r10']<=pct('iwm_r10',0.10), -1,'IWM 10d weak -> short')
add('B4_iwm_vs_spy_pos_long','breadth', F['iwm_vs_spy_5']>=pct('iwm_vs_spy_5',0.90), +1,'small caps leading -> broad risk-on -> long')

# --- F6 risk-off composite ---
add('X1_riskoff_top10','composite', F['riskoff']>=pct('riskoff',0.90), -1,'macro stress composite top 10% -> short')
add('X2_riskoff_top5','composite', F['riskoff']>=pct('riskoff',0.95), -1,'macro stress composite top 5% -> short')
add('X3_riskoff_z2','composite', F['riskoff_z']>=2.0, -1,'composite z>2 -> short')
add('X4_riskoff_bot10_long','composite', F['riskoff']<=pct('riskoff',0.10), +1,'risk-on composite (bottom10) -> long')

# --- F7 cross-asset mom / mean-reversion ---
add('M1_gld_up_short','xasset', F['gld_r5']>=pct('gld_r5',0.90), -1,'gold spike (fear bid) -> short')
add('M2_gld_vs_spy','xasset', F['gld_vs_spy_5']>=pct('gld_vs_spy_5',0.90), -1,'gold outperforming equity strongly -> risk-off -> short')
add('M3_btc_weak_short','xasset', F['btc_r5']<=pct('btc_r5',0.10), -1,'BTC 5d weak (risk appetite off) -> short')
add('M4_btc_strong_long','xasset', F['btc_r5']>=pct('btc_r5',0.90), +1,'BTC 5d strong (risk-on) -> long')
add('M5_nq_z20_low_meanrev','xasset', F['nq_z20']<=-2.0, +1,'NQ 2std below 20d mean -> mean-revert long')
add('M6_nq_z20_high_meanrev','xasset', F['nq_z20']>=2.0, -1,'NQ 2std above 20d mean -> mean-revert short')

# ---------- evaluate ----------
rows = []
for h in (3,5):
    base_all = baseline_moves(P, h)          # unconditional raw move (long-frame)
    b = base_all.dropna()
    b_mean = b.mean(); b_med = b.median()
    for name, fam, mask, direction, note in signals:
        m = mask.fillna(False)
        # need feature warmup: drop where mask NaN already false; also drop first 252
        sig_dates = P.index[m.values]
        r = measure(P, sig_dates, direction, h)
        if len(r) < 20:
            rows.append((name,fam,h,direction,len(r),*([np.nan]*10),note)); continue
        st = dist_stats(r['move'].values, r['mfe'].values)
        # conditional raw (long-frame) vs unconditional
        cond_raw = r['raw'].mean()
        cmb = cond_raw - b_mean                     # conditional minus unconditional (raw)
        # directional edge vs baseline: for short, directional move = -raw; baseline directional = -b_mean
        dir_move = r['move'].mean()
        base_dir = direction*b_mean
        edge = dir_move - base_dir
        rows.append((name,fam,h,direction,st['n'],st['mean'],st['median'],
                     st['q25'],st['q75'],st['wr'],st['hit100'],st['hit150'],st['hit200'],
                     cmb, edge, note))

cols=['name','family','h','dir','n','mean','median','q25','q75','wr',
      'hit100','hit150','hit200','cond_minus_uncond_raw','dir_edge_vs_base','note']
R=pd.DataFrame(rows,columns=cols)
R.to_csv(f"{__import__('os').path.dirname(__file__)}/M1-candidates.csv",index=False)

# print unconditional baselines
print("="*100)
for h in (3,5):
    b=baseline_moves(P,h).dropna()
    print(f"UNCONDITIONAL NQ {h}d move: n={len(b)} mean={b.mean():+.1f} med={b.median():+.1f} "
          f"IQR[{np.percentile(b,25):+.0f},{np.percentile(b,75):+.0f}] wr(up)={(b>0).mean():.3f} std={b.std():.0f}")
print("="*100)

for fam in ['credit','rates','dollar','vol','breadth','composite','xasset']:
    print(f"\n########## FAMILY: {fam} ##########")
    sub=R[(R.family==fam)]
    for h in (3,5):
        print(f"  --- horizon {h}d ---")
        for _,x in sub[sub.h==h].iterrows():
            if x['n']<20:
                print(f"    {x['name']:32s} dir={x['dir']:+d} n={int(x['n']):3d}  (too few)"); continue
            print(f"    {x['name']:32s} dir={x['dir']:+d} n={int(x['n']):4d} "
                  f"dirMove={x['mean']:+6.1f} med={x['median']:+6.1f} wr={x['wr']:.2f} "
                  f"hit100/150={x['hit100']:.2f}/{x['hit150']:.2f} "
                  f"EDGEvsBase={x['dir_edge_vs_base']:+6.1f}")
