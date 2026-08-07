#!/usr/bin/env python3
"""M1 common: trade measurement + baseline + regimes + stats helpers.

Convention:
  Signal known at day-D close. Enter NQ at D+1 OPEN. Direction +1 long / -1 short.
  Fixed horizon h: exit at CLOSE of the h-th trading day after entry
  (h=3 => enter D+1 open, exit close of D+3).
  Forward move (points, directional) = dir * (exit_close - entry_open).
  MFE (favorable, points) = best move in `dir` reached intraday during hold.
  MAE (adverse, points)   = worst move against you (negative) during hold.
Costs: ~1-2 NQ pts round trip (1 entry + 1 exit). Negligible vs 100pt target; we
report gross point-moves and note the ~1.5pt haircut.
"""
import pandas as pd, numpy as np, os

DIR = os.path.dirname(os.path.abspath(__file__))
ROUND_TRIP_COST = 1.5  # NQ points, stated but not subtracted from distribution stats

def load_panel():
    p = pd.read_csv(f"{DIR}/M1-panel.csv", parse_dates=['date']).set_index('date')
    return p

# ---- regime labeling (stress windows vs calm) ----
STRESS_WINDOWS = [
    ("2000-2002 dotcom", "2000-03-01", "2002-10-31"),
    ("2008 GFC",        "2008-01-01", "2009-06-30"),
    ("2010 flash",      "2010-05-01", "2010-07-31"),
    ("2011 EU/debt",    "2011-07-01", "2011-12-31"),
    ("2015-16 China",   "2015-08-01", "2016-02-29"),
    ("2018Q4",          "2018-10-01", "2018-12-31"),
    ("2020 COVID",      "2020-02-15", "2020-05-31"),
    ("2022 bear",       "2022-01-01", "2022-12-31"),
    ("2025 tariff",     "2025-03-01", "2025-05-31"),
]

def regime_of(dt):
    for name, a, b in STRESS_WINDOWS:
        if pd.Timestamp(a) <= dt <= pd.Timestamp(b):
            return name
    return "calm"

def measure(panel, entry_dates, direction, h):
    """Return DataFrame of per-trade results for a list/Index of signal dates D.
    direction: +1/-1 (scalar) or a Series aligned to entry_dates."""
    o = panel['nq_open'].values; hi = panel['nq_high'].values
    lo = panel['nq_low'].values;  c = panel['nq_close'].values
    dates = panel.index
    pos = {d: i for i, d in enumerate(dates)}
    rows = []
    for D in entry_dates:
        i = pos.get(D)
        if i is None: continue
        ei = i + 1                 # entry day index (D+1)
        xi = ei + (h - 1)          # exit day index
        if xi >= len(dates): continue
        entry = o[ei]
        exit_c = c[xi]
        seg_hi = hi[ei:xi+1].max()
        seg_lo = lo[ei:xi+1].min()
        d = direction[D] if hasattr(direction, '__getitem__') and not np.isscalar(direction) else direction
        move = d * (exit_c - entry)
        if d > 0:
            mfe = seg_hi - entry
            mae = seg_lo - entry
        else:
            mfe = entry - seg_lo
            mae = entry - seg_hi   # negative
        raw = exit_c - entry   # signed price change (long-frame), for baseline compare
        rows.append((D, dates[ei].date(), d, entry, exit_c, move, raw, mfe, mae,
                     regime_of(D), D.year))
    return pd.DataFrame(rows, columns=['signal_date','entry_date','dir','entry','exit',
                                       'move','raw','mfe','mae','regime','year'])

def baseline_moves(panel, h, mask=None):
    """Unconditional directional move for EVERY day (long, dir=+1) over horizon h.
    Returns array of moves (exit_close - entry_open) for every eligible entry.
    If mask given (bool Series over panel.index), restrict to those signal dates."""
    o = panel['nq_open'].values; c = panel['nq_close'].values
    n = len(panel)
    idx = np.arange(n-1-(h-1))
    entry = o[idx+1]; exit_c = c[idx+1+(h-1)]
    mv = exit_c - entry
    d = panel.index[idx]
    s = pd.Series(mv, index=d)
    if mask is not None:
        s = s[mask.reindex(s.index, fill_value=False)]
    return s

def dist_stats(moves, mfe=None):
    """Distribution summary for an array of directional point-moves."""
    m = np.asarray(moves, float)
    m = m[~np.isnan(m)]
    if len(m) == 0:
        return dict(n=0)
    out = dict(
        n=len(m), mean=m.mean(), median=np.median(m),
        q25=np.percentile(m,25), q75=np.percentile(m,75),
        std=m.std(), wr=(m>0).mean(),
    )
    if mfe is not None:
        f = np.asarray(mfe,float); f=f[~np.isnan(f)]
        out['hit100']=(f>=100).mean(); out['hit150']=(f>=150).mean(); out['hit200']=(f>=200).mean()
    return out

def fmt_stats(s):
    if s.get('n',0)==0: return "n=0"
    base = (f"n={s['n']:4d} mean={s['mean']:+7.1f} med={s['median']:+7.1f} "
            f"IQR[{s['q25']:+6.0f},{s['q75']:+6.0f}] wr={s['wr']:.2f}")
    if 'hit100' in s:
        base += f" hit100/150/200={s['hit100']:.2f}/{s['hit150']:.2f}/{s['hit200']:.2f}"
    return base

def placebo(panel, direction, h, n_sig, n_iter=1000, seed=1, pool_mask=None):
    """Randomly pick n_sig entry dates (matched count), measure mean move. Return
    distribution of mean-move under the null. direction must be scalar for placebo."""
    rng = np.random.default_rng(seed)
    pool = panel.index[:-(h)]  # entries that have room
    if pool_mask is not None:
        pool = pool[pool_mask.reindex(pool, fill_value=False).values]
    pool = np.array(pool)
    means = np.empty(n_iter)
    for k in range(n_iter):
        picks = rng.choice(pool, size=min(n_sig,len(pool)), replace=False)
        r = measure(panel, pd.DatetimeIndex(picks), direction, h)
        means[k] = r['move'].mean() if len(r) else np.nan
    return means

# ================= feature + signal builders (shared by screens) =================
def build_features(P):
    def ret(col,n=1): return P[col].pct_change(n)
    def chg(col,n=1): return P[col].diff(n)
    def z(s,w): return (s-s.rolling(w).mean())/s.rolling(w).std()
    F=pd.DataFrame(index=P.index)
    F['nq_r5']=ret('nq_close',5); F['nq_r10']=ret('nq_close',10)
    F['hyg_r5']=ret('hyg_close',5); F['hyg_r10']=ret('hyg_close',10)
    F['hyglqd']=P['hyg_close']/P['lqd_close']
    F['hyglqd_r5']=F['hyglqd'].pct_change(5); F['hyglqd_z']=z(F['hyglqd'],60)
    F['hyg_vs_spy_5']=ret('hyg_close',5)-ret('spy_close',5)
    F['tlt_r3']=ret('tlt_close',3); F['tlt_r5']=ret('tlt_close',5)
    F['corr_nq_tlt_40']=P['nq_close'].pct_change().rolling(40).corr(P['tlt_close'].pct_change())
    F['dxy_r5']=ret('dxy_close',5); F['dxy_r3']=ret('dxy_close',3); F['dxy_z']=z(P['dxy_close'],60)
    F['vix_c5']=chg('vix_close',5); F['vix_z']=z(P['vix_close'],60)
    F['vix_pctile']=P['vix_close'].rolling(252).apply(lambda x:(x[-1]>x).mean(),raw=True)
    F['iwm_vs_spy_5']=ret('iwm_close',5)-ret('spy_close',5)
    F['iwm_vs_nq_5']=ret('iwm_close',5)-ret('nq_close',5)
    F['gld_r5']=ret('gld_close',5); F['gld_vs_spy_5']=ret('gld_close',5)-ret('spy_close',5)
    F['btc_r5']=ret('btc_close',5)
    F['nq_z20']=z(P['nq_close'],20)
    comp=pd.DataFrame(index=P.index)
    comp['credit']=-z(ret('hyg_close',5),120); comp['dollar']=z(ret('dxy_close',5),120)
    comp['vix']=z(chg('vix_close',5),120); comp['bonds']=z(ret('tlt_close',5),120)
    comp['gold']=z(ret('gld_close',5),120)
    F['riskoff']=comp.mean(axis=1); F['riskoff_z']=z(F['riskoff'],120)
    return F

def build_signals(P,F):
    def pct(col,q): return F[col].rolling(252,min_periods=120).quantile(q)
    S={}  # name -> (mask, direction, note, family)
    S['C4_hyglqd_z_low']=(F['hyglqd_z']<=-1.5,-1,'HY/IG ratio z<-1.5 (credit spread widening)','credit')
    S['C2_hyglqd_r5_bot10']=(F['hyglqd_r5']<=pct('hyglqd_r5',0.10),-1,'HY/IG ratio 5d bottom decile','credit')
    S['C6_hyg_r5_top10_LONG']=(F['hyg_r5']>=pct('hyg_r5',0.90),+1,'HYG 5d ret top decile (credit risk-on)','credit')
    S['V4_vix_top_decile']=(F['vix_pctile']>=0.90,-1,'VIX in top decile of trailing 1y','vol')
    S['V2_vix_spike']=(F['vix_c5']>=pct('vix_c5',0.90),-1,'VIX 5d change top decile','vol')
    S['X1_riskoff_top10']=(F['riskoff']>=pct('riskoff',0.90),-1,'macro stress composite top decile','composite')
    S['X3_riskoff_z2']=(F['riskoff_z']>=2.0,-1,'macro stress composite z>2','composite')
    S['X4_riskoff_bot10_LONG']=(F['riskoff']<=pct('riskoff',0.10),+1,'risk-on composite bottom decile','composite')
    S['M2_gld_vs_spy']=(F['gld_vs_spy_5']>=pct('gld_vs_spy_5',0.90),-1,'gold outperforming SPY top decile (fear bid)','xasset')
    S['M3_btc_weak']=(F['btc_r5']<=pct('btc_r5',0.10),-1,'BTC 5d bottom decile (risk appetite off)','xasset')
    S['B1_iwm_vs_spy_neg']=(F['iwm_vs_spy_5']<=pct('iwm_vs_spy_5',0.10),-1,'small caps lagging SPY bottom decile','breadth')
    S['R3_tlt_spike_up']=(F['tlt_r3']>=pct('tlt_r3',0.90),-1,'TLT 3d spike top decile (flight to safety)','rates')
    S['M5_nq_dip_LONG']=(F['nq_z20']<=-2.0,+1,'NQ 2sd below 20d mean (mean-revert)','xasset')
    return S
