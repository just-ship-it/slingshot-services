#!/usr/bin/env python3
"""
Fetch daily OHLCV for every basket constituent in baskets.json.

Primary: TradingView via fetch-macro-daily.js --tv-symbols (house pipeline,
split-adjusted). Fallback for TV failures (delisted names): Yahoo chart API
('close' = split-adjusted; matches TV convention; divs unadjusted — acceptable
for shorted-name research).

Output: backtest-engine/data/shortinterest/prices/<sym>_1d.csv
        (date,ts,open,high,low,close,volume — same schema as macro dailies)
Re-runnable: skips symbols already on disk. survivorship.json logs source per
symbol + names missing from BOTH sources.
"""
import csv, datetime as dt, glob, json, os, subprocess, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BT = os.path.join(HERE, '..', '..', 'backtest-engine')
PRICES = os.path.join(BT, 'data', 'shortinterest', 'prices')
BASKETS = os.path.join(HERE, 'baskets.json')
SURV = os.path.join(HERE, 'survivorship.json')
EXCH = {'NYSE': 'NYSE', 'NNM': 'NASDAQ', 'SC': 'NASDAQ', 'AMEX': 'AMEX'}
BATCH = 12

def yahoo(sym):
    url = (f'https://query1.finance.yahoo.com/v8/finance/chart/{sym}'
           f'?period1=1546300800&period2={int(time.time())}&interval=1d')
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            d = json.load(r)
        res = d['chart']['result'][0]
        ts = res.get('timestamp', [])
        q = res['indicators']['quote'][0]
        rows = []
        for i, t in enumerate(ts):
            c = q['close'][i]
            if c is None:
                continue
            rows.append((dt.date.fromtimestamp(t).isoformat(), t,
                         q['open'][i] or c, q['high'][i] or c,
                         q['low'][i] or c, c, q['volume'][i] or 0))
        return rows
    except Exception:
        return None

def main():
    os.makedirs(PRICES, exist_ok=True)
    baskets = json.load(open(BASKETS))
    syms = {}  # sym -> mktClass
    for b in baskets.values():
        for m in b['members'] + b.get('members_dtc', []):
            syms.setdefault(m['sym'], m['mktClass'])
    todo = [s for s in sorted(syms) if not os.path.exists(os.path.join(PRICES, f'{s.lower()}_1d.csv'))]
    print(f'{len(syms)} constituents, {len(todo)} to fetch', flush=True)
    surv = json.load(open(SURV)) if os.path.exists(SURV) else {}

    # --- TV in batches ---
    for i in range(0, len(todo), BATCH):
        batch = todo[i:i+BATCH]
        tvs = ','.join(f"{EXCH[syms[s]]}:{s}" for s in batch)
        subprocess.run(['node', os.path.join(BT, 'scripts', 'fetch-macro-daily.js'),
                        '--tv-symbols', tvs, '--out', PRICES, '--bars', '2500'],
                       cwd=BT, capture_output=True, timeout=1200)
        got = [s for s in batch if os.path.exists(os.path.join(PRICES, f'{s.lower()}_1d.csv'))]
        for s in got:
            surv[s] = 'tv'
        print(f'TV batch {i//BATCH+1}: {len(got)}/{len(batch)} ok', flush=True)

    # --- Yahoo fallback ---
    missing = [s for s in sorted(syms) if not os.path.exists(os.path.join(PRICES, f'{s.lower()}_1d.csv'))]
    print(f'Yahoo fallback for {len(missing)} symbols', flush=True)
    dead = []
    for s in missing:
        rows = yahoo(s)
        time.sleep(0.6)
        if not rows or len(rows) < 20:
            dead.append(s)
            surv[s] = 'MISSING'
            print(f'  {s}: MISSING from both sources', flush=True)
            continue
        with open(os.path.join(PRICES, f'{s.lower()}_1d.csv'), 'w', newline='') as f:
            w = csv.writer(f)
            w.writerow(['date', 'ts', 'open', 'high', 'low', 'close', 'volume'])
            w.writerows(rows)
        surv[s] = 'yahoo'
        print(f'  {s}: yahoo {len(rows)} bars', flush=True)
    json.dump(surv, open(SURV, 'w'), indent=1)
    n_tv = sum(1 for v in surv.values() if v == 'tv')
    n_y = sum(1 for v in surv.values() if v == 'yahoo')
    print(f'\ndone: tv={n_tv} yahoo={n_y} missing={len(dead)} {dead}', flush=True)

if __name__ == '__main__':
    main()
