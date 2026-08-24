#!/usr/bin/env python3
"""
FINRA consolidated short interest — bulk historical fetcher.

Pulls the full bi-monthly consolidated short interest dataset (exchange-listed
+ OTC; we keep non-OTC rows) from FINRA's public Query API, one CSV per
settlement date, into backtest-engine/data/shortinterest/finra/.

API: POST https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest
     unauthenticated; record-max-limit 5000; record-total header for pagination.
     Dataset starts 2020-04-15. ~22k rows per settlement date.

Settlement calendar: mid-month (15th or preceding business day) and month-end
(last business day). Discovered empirically: candidate date, then step back
business days (holidays) until the API returns rows, up to 4 tries.

Usage: python3 fetch-finra-short-interest.py [--from 2020-04] [--to 2026-08]
Re-runnable: skips settlement dates whose CSV already exists.
"""
import argparse, csv, datetime as dt, json, os, sys, time, urllib.request

API = 'https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest'
OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'shortinterest', 'finra')
FIELDS = ['settlementDate', 'symbolCode', 'issueName', 'marketClassCode',
          'currentShortPositionQuantity', 'previousShortPositionQuantity',
          'changePercent', 'averageDailyVolumeQuantity', 'daysToCoverQuantity',
          'revisionFlag', 'stockSplitFlag']
SLEEP = 1.0

def post(body):
    # FINRA's WAF blocks Python's TLS fingerprint with empty 200 bodies while
    # identical curl requests succeed — so we shell out to curl.
    import subprocess, tempfile
    backoffs = [15, 30, 60, 120, 300, 300, 300, 300, 300]
    for attempt, wait in enumerate(backoffs + [0]):
        try:
            with tempfile.NamedTemporaryFile(suffix='.json') as tf:
                r = subprocess.run(
                    ['curl', '-s', '-m', '120', '-o', tf.name,
                     '-w', '%{http_code}\t%{header_json}',
                     '-X', 'POST',
                     '-H', 'Content-Type: application/json',
                     '-H', 'Accept: application/json',
                     API, '-d', json.dumps(body)],
                    capture_output=True, text=True, timeout=150)
                code, _, hdr = r.stdout.partition('\t')
                if code == '204':      # no records for this filter (e.g. holiday date)
                    return [], 0
                if code != '200':
                    raise RuntimeError(f'HTTP {code}')
                total = -1
                try:
                    total = int(json.loads(hdr).get('record-total', ['-1'])[0])
                except Exception:
                    pass
                return json.load(open(tf.name)), total
        except Exception as e:
            if attempt == len(backoffs):
                raise
            print(f'  retry in {wait}s ({type(e).__name__}: {e})', flush=True)
            time.sleep(wait)

def rows_for_date(d):
    iso = d.isoformat()
    flt = [{'compareType': 'EQUAL', 'fieldName': 'settlementDate', 'fieldValue': iso}]
    first, total = post({'limit': 5000, 'offset': 0, 'compareFilters': flt})
    if total <= 0 or not first:
        return None
    rows = list(first)
    off = 5000
    while off < total:
        time.sleep(SLEEP)
        page, _ = post({'limit': 5000, 'offset': off, 'compareFilters': flt})
        rows.extend(page)
        off += 5000
    return rows

def prev_bday(d):
    d -= dt.timedelta(days=1)
    while d.weekday() >= 5:
        d -= dt.timedelta(days=1)
    return d

def to_bday(d):
    while d.weekday() >= 5:
        d -= dt.timedelta(days=1)
    return d

def month_candidates(y, m):
    mid = to_bday(dt.date(y, m, 15))
    nxt = dt.date(y + (m == 12), m % 12 + 1, 1)
    eom = to_bday(nxt - dt.timedelta(days=1))
    return [mid, eom]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--from', dest='frm', default='2020-04')
    ap.add_argument('--to', dest='to', default=dt.date.today().strftime('%Y-%m'))
    a = ap.parse_args()
    y0, m0 = map(int, a.frm.split('-'))
    y1, m1 = map(int, a.to.split('-'))
    os.makedirs(OUT, exist_ok=True)
    months = []
    y, m = y0, m0
    while (y, m) <= (y1, m1):
        months.append((y, m))
        y, m = y + (m == 12), m % 12 + 1
    print(f'{len(months)} months -> up to {len(months)*2} settlement dates', flush=True)

    for y, m in months:
        for cand in month_candidates(y, m):
            # skip if any existing file within 4 bdays back of candidate
            found_existing = False
            probe = cand
            for _ in range(5):
                if os.path.exists(os.path.join(OUT, f'si_{probe.isoformat()}.csv')):
                    found_existing = True
                    break
                probe = prev_bday(probe)
            if found_existing:
                continue
            rows, tries = None, 0
            d = cand
            while rows is None and tries < 5:
                time.sleep(SLEEP)
                rows = rows_for_date(d)
                if rows is None:
                    d = prev_bday(d)
                    tries += 1
            if rows is None:
                print(f'!! no data near {cand} — skipped', flush=True)
                continue
            keep = [r for r in rows if r.get('marketClassCode') != 'OTC']
            path = os.path.join(OUT, f'si_{d.isoformat()}.csv')
            with open(path, 'w', newline='') as f:
                w = csv.DictWriter(f, fieldnames=FIELDS, extrasaction='ignore')
                w.writeheader()
                for r in sorted(keep, key=lambda r: r.get('symbolCode') or ''):
                    w.writerow(r)
            classes = {}
            for r in rows:
                classes[r.get('marketClassCode')] = classes.get(r.get('marketClassCode'), 0) + 1
            print(f'{d}  total={len(rows)}  kept(non-OTC)={len(keep)}  classes={classes}', flush=True)

if __name__ == '__main__':
    main()
