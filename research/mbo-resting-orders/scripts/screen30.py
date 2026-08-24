#!/usr/bin/env python3
"""Screen 30s MBO features for forward predictiveness. Candidates ranked on ONE month;
survivors get locked and tested on the other two. All features are causal (window-closed)."""
import glob, os, sys, numpy as np
def load(tag):
    Xs=[]; cols=None; days=[]
    for p in sorted(glob.glob(f'/tmp/claude-1000/f30/{tag}/*.npz')):
        z=np.load(p,allow_pickle=True); X=z['X']
        if cols is None: cols=[str(c) for c in z['cols']]
        if len(X)<50: continue
        Xs.append(X); days.append(np.full(len(X),int(os.path.basename(p)[:8])))
    return np.vstack(Xs), np.concatenate(days), cols
def build(X, cols):
    c={n:i for i,n in enumerate(cols)}
    g=lambda n: X[:,c[n]]
    def imb(a,b):
        s=a+b
        return np.where(s>0,(a-b)/np.maximum(s,1),np.nan)
    F={}
    for b in range(3):
        nm={0:'churn',1:'small',2:'work'}[b]
        F[f'add_imb_{nm}']  = imb(g(f'add{b}b'),  g(f'add{b}a'))
        F[f'can_imb_{nm}']  = imb(g(f'can{b}b'),  g(f'can{b}a'))
        F[f'fil_imb_{nm}']  = imb(g(f'fil{b}b'),  g(f'fil{b}a'))
        F[f'canv_imb_{nm}'] = imb(g(f'can{b}bv'), g(f'can{b}av'))
        F[f'filv_imb_{nm}'] = imb(g(f'fil{b}bv'), g(f'fil{b}av'))
        # pull rate = cancels per add, per side; asymmetry of "giving up"
        pb=g(f'can{b}b')/np.maximum(g(f'add{b}b'),1); pa=g(f'can{b}a')/np.maximum(g(f'add{b}a'),1)
        F[f'pull_asym_{nm}']=np.where((pb+pa)>0,(pb-pa)/np.maximum(pb+pa,1e-9),np.nan)
    F['can_near_imb']=imb(g('can_near_b'),g('can_near_a'))   # adverse-selection avoidance
    F['fil_near_imb']=imb(g('fil_near_b'),g('fil_near_a'))
    F['age_div']=g('age_f')-g('age_c')                        # queue age divergence
    F['age_f']=g('age_f'); F['age_c']=g('age_c')
    return F
def screen(tag, H=10, stride=None):
    X,days,cols=load(tag); c={n:i for i,n in enumerate(cols)}
    px=X[:,c['px']]; hi=X[:,c['hi']]; lo=X[:,c['lo']]; t=X[:,c['t']]
    tr=np.maximum(hi-lo, np.abs(np.diff(px,prepend=px[0])))
    atr=np.convolve(tr,np.ones(40)/40,mode='same'); atr[atr<=0]=np.nan
    same=(days==np.roll(days,-H))
    fwd=np.where(same,(np.roll(px,-H)-px)/atr,np.nan)
    prior=np.where(days==np.roll(days,H),(px-np.roll(px,H))/atr,np.nan)
    F=build(X,cols)
    st=stride or H
    res=[]
    for k,v in F.items():
        m=np.isfinite(v)&np.isfinite(fwd)&np.isfinite(prior)
        idx=np.flatnonzero(m)[::st]
        if len(idx)<400: continue
        a=v[idx]; f=fwd[idx]; pr=prior[idx]
        if np.std(a)==0: continue
        r=np.corrcoef(a,f)[0,1]
        # residualise BOTH on prior return -> kills the mechanical coupling
        ca=np.polyfit(pr,a,1); cf=np.polyfit(pr,f,1)
        pa=a-np.poly1d(ca)(pr); pf=f-np.poly1d(cf)(pr)
        rp=np.corrcoef(pa,pf)[0,1]
        tstat=rp*np.sqrt(len(idx)-2)/np.sqrt(max(1-rp**2,1e-12))
        res.append((k,len(idx),r,rp,tstat))
    res.sort(key=lambda x:-abs(x[4]))
    return res
if __name__=='__main__':
    tag=sys.argv[1] if len(sys.argv)>1 else 'DECJAN'
    H=int(sys.argv[2]) if len(sys.argv)>2 else 10
    print(f"=== SCREEN on {tag}, horizon {H} windows ({H*30}s), prior-return controlled ===")
    print(f"{'feature':>20}{'n':>7}{'raw r':>9}{'partial r':>11}{'t':>8}")
    for k,n,r,rp,ts in screen(tag,H):
        flag='  <<<' if abs(ts)>3.5 else ''
        print(f"{k:>20}{n:>7}{r:>+9.4f}{rp:>+11.4f}{ts:>+8.2f}{flag}")
