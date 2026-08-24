#!/usr/bin/env python3
"""
Short-basket construction from FINRA SI + SEC shares outstanding.

Per settlement date:
  1. Universe: FINRA non-OTC file, marketClassCode in {NYSE, NNM, SC, AMEX}
     (ARCA/BZX = ETF-land, excluded), issueName regex drops ETF/ETN/warrant/
     unit/pfd/notes/depositary instruments.
  2. Liquidity: ADV >= 300k shares; shares short >= 1M; DTC != 999.99 sentinel.
  3. Candidate pool: top-150 by shares short  UNION  top-150 by days-to-cover.
  4. SI%% = currentShortPositionQuantity / SEC shares outstanding, using the
     latest SEC filing FILED strictly before the basket effective date
     (point-in-time). Candidates without SEC data are dropped (logged).
  5. Keep top-40 by SI%% (post-price screens later trim to top-20).

Effective date = settlement + 9 business days (FINRA dissemination lag,
approximate) — the basket may only be used from that date forward.

Outputs:
  baskets.json   {settlementDate: {effectiveDate, members:[{sym, si, adv, dtc,
                  sharesOut, siPct, mktClass}]}}
  sec cache      backtest-engine/data/shortinterest/sec/<TICKER>.json
"""
import csv, datetime as dt, glob, json, os, re, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
FINRA_DIR = os.path.join(HERE, '..', '..', 'backtest-engine', 'data', 'shortinterest', 'finra')
SEC_DIR = os.path.join(HERE, '..', '..', 'backtest-engine', 'data', 'shortinterest', 'sec')
TICKMAP = os.path.join(SEC_DIR, 'company_tickers.json')
OUT = os.path.join(HERE, 'baskets.json')
UA = {'User-Agent': 'drew slingshot research drewlharmon@gmail.com'}
KEEP_CLASSES = {'NYSE', 'NNM', 'SC', 'AMEX'}
BAD_NAME = re.compile(
    r'\b(ETF|ETN|iShares|ProShares|Direxion|VanEck|Invesco|SPDR|Trust Units|'
    r'Warrant|Wt|Right|Rights|Units?|Pfd|Preferred|Depositary|Notes? due|ADS|ADR)\b|%',
    re.IGNORECASE)
MIN_ADV = 300_000
MIN_SI = 1_000_000
POOL_N = 150
KEEP_N = 40
LAG_BDAYS = 9

def bday_add(d, n):
    while n > 0:
        d += dt.timedelta(days=1)
        if d.weekday() < 5:
            n -= 1
    return d

def load_tickmap():
    m = json.load(open(TICKMAP))
    return {v['ticker'].upper(): int(v['cik_str']) for v in m.values()}

def sec_shares(ticker, cik):
    """cached shares-outstanding series [(filed_date, value)] sorted by filed"""
    os.makedirs(SEC_DIR, exist_ok=True)
    cache = os.path.join(SEC_DIR, f'{ticker}.json')
    if os.path.exists(cache):
        return json.load(open(cache))
    url = (f'https://data.sec.gov/api/xbrl/companyconcept/CIK{cik:010d}/dei/'
           'EntityCommonStockSharesOutstanding.json')
    series = []
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=30) as r:
            d = json.load(r)
        pts = d.get('units', {}).get('shares', [])
        series = sorted({(p['filed'], p['val']) for p in pts if p.get('val')})
    except Exception:
        series = []
    json.dump(series, open(cache, 'w'))
    time.sleep(0.13)
    return series

def shares_asof(series, date_iso):
    v = None
    for filed, val in series:
        if filed < date_iso:
            v = val
        else:
            break
    return v

def main():
    tickmap = load_tickmap()
    files = sorted(glob.glob(os.path.join(FINRA_DIR, 'si_*.csv')))
    print(f'{len(files)} FINRA settlement files', flush=True)
    baskets, no_sec = {}, set()
    for path in files:
        sdate = os.path.basename(path)[3:13]
        eff = bday_add(dt.date.fromisoformat(sdate), LAG_BDAYS).isoformat()
        rows = []
        for r in csv.DictReader(open(path)):
            if r['marketClassCode'] not in KEEP_CLASSES:
                continue
            if BAD_NAME.search(r['issueName'] or ''):
                continue
            try:
                si = float(r['currentShortPositionQuantity'] or 0)
                adv = float(r['averageDailyVolumeQuantity'] or 0)
                dtc = float(r['daysToCoverQuantity'] or 0)
            except ValueError:
                continue
            if adv < MIN_ADV or si < MIN_SI or dtc >= 999:
                continue
            rows.append((r['symbolCode'], si, adv, dtc, r['marketClassCode']))
        pool = {t[0]: t for t in
                sorted(rows, key=lambda t: -t[1])[:POOL_N] +
                sorted(rows, key=lambda t: -t[3])[:POOL_N]}
        members = []
        for sym, si, adv, dtc, mc in pool.values():
            cik = tickmap.get(sym.upper())
            if cik is None:
                no_sec.add(sym)
                continue
            so = shares_asof(sec_shares(sym.upper(), cik), eff)
            if not so or so < 5_000_000:
                if not so:
                    no_sec.add(sym)
                continue
            # wrong-entity guards (ticker reuse maps to today's owner — e.g.
            # GOLD -> Gold.com not Barrick): ADV can't plausibly exceed 30% of
            # shares outstanding daily, and SI > 250% of shares = bad join
            if adv > 0.30 * so:
                continue
            si_pct = si / so * 100
            if si_pct > 250:
                continue
            members.append({'sym': sym, 'si': si, 'adv': adv, 'dtc': dtc,
                            'sharesOut': so, 'siPct': round(si_pct, 2),
                            'mktClass': mc})
        members.sort(key=lambda m: -m['siPct'])
        # DTC-ranked variant: pure FINRA, no SEC join, no ticker-reuse risk
        dtc_members = [{'sym': s, 'si': si, 'adv': adv, 'dtc': dtc, 'mktClass': mc,
                        'siPct': None, 'sharesOut': None}
                       for s, si, adv, dtc, mc in
                       sorted(pool.values(), key=lambda t: -t[3])][:KEEP_N]
        baskets[sdate] = {'effectiveDate': eff, 'members': members[:KEEP_N],
                          'members_dtc': dtc_members}
        top5 = ', '.join(f"{m['sym']}({m['siPct']:.0f}%)" for m in members[:5])
        print(f'{sdate} eff {eff}: pool={len(pool)} ranked={len(members)} top5: {top5}', flush=True)
    json.dump(baskets, open(OUT, 'w'), indent=1)
    print(f'\nno-SEC-data tickers: {len(no_sec)}', flush=True)
    uniq = {m['sym'] for b in baskets.values() for m in b['members']}
    print(f'baskets: {len(baskets)} | unique top-{KEEP_N} constituents: {len(uniq)}', flush=True)

if __name__ == '__main__':
    main()
