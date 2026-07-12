#!/usr/bin/env python3
"""Feature/target table for the causal-GEX/IV predictive screen (R1).

One row per 15-min GEX snapshot (causal data/gex/nq, 2025-01+ intraday-cbbo-IV
segment). Features are all point-in-time knowable at the snapshot's as-of
timestamp. Targets are forward NQ log-returns and MFE/MAE from the snapshot
timestamp on primary-contract 1m closes, censored across contract rolls.

Output: features.csv (one row per snapshot).
"""
import bisect
import csv
import glob
import json
import math
from datetime import datetime, timezone, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).parent
BASE = Path('/home/drew/projects/slingshot-services/backtest-engine')
GEX_DIR = BASE / 'data/gex/nq'          # causal regeneration (post-broom)
GEX_DIR_FALLBACK = BASE / 'data/gex/nq-causal'  # pre-rename location
IV_CSV = BASE / 'data/iv/qqq/qqq_atm_iv_1m.csv'
PRICE_CSV = HERE / 'nq_1m_primary_2023plus.csv'
ET = ZoneInfo('America/New_York')

HORIZONS = {'r15m': 15, 'r1h': 60, 'r4h': 240}
MFE_WINDOW = 240  # minutes


def load_prices():
    ts_list, close_list, sym_list = [], [], []
    with open(PRICE_CSV) as f:
        next(f)
        for line in f:
            ts, close, sym = line.rstrip('\n').split(',')
            ts_list.append(ts)
            close_list.append(float(close))
            sym_list.append(sym)
    return ts_list, close_list, sym_list


def load_iv():
    """minute-key -> (iv, call_iv, put_iv). Keys are 'YYYY-MM-DDTHH:MM'."""
    out = {}
    with open(IV_CSV) as f:
        for r in csv.DictReader(f):
            k = r['timestamp'][:16]
            try:
                out[k] = (float(r['iv']), float(r['call_iv']), float(r['put_iv']))
            except (ValueError, KeyError):
                continue
    return out


def iv_at(iv_map, iv_keys, minute_key, max_back=30):
    """Latest IV at or before minute_key, walking back <= max_back minutes."""
    i = bisect.bisect_right(iv_keys, minute_key) - 1
    if i < 0:
        return None, None
    k = iv_keys[i]
    # minutes between k and minute_key (same-day fast path is fine lexically)
    t0 = datetime.fromisoformat(k + ':00+00:00')
    t1 = datetime.fromisoformat(minute_key + ':00+00:00')
    if (t1 - t0) > timedelta(minutes=max_back):
        return None, None
    return iv_map[k], k


def main():
    gex_dir = GEX_DIR if list(GEX_DIR.glob('nq_gex_*.json')) else GEX_DIR_FALLBACK
    print('GEX dir:', gex_dir)

    ts_list, close_list, sym_list = load_prices()
    print(f'{len(ts_list)} price minutes')
    iv_map = load_iv()
    iv_keys = sorted(iv_map)
    print(f'{len(iv_map)} IV minutes')

    rows = []
    files = sorted(glob.glob(str(gex_dir / 'nq_gex_*.json')))
    for fp in files:
        d = json.load(open(fp))
        meta = d.get('metadata', {})
        if meta.get('close_source') != 'prevday' and meta.get('iv_source') != 'cbbo':
            continue  # causal files only (defensive; post-broom all should pass)
        segment = meta.get('iv_source', 'stats')  # 'cbbo' or 'stats' (prevday)
        for s in d['data']:
            ts_raw = s['timestamp'].replace('Z', '+00:00')
            try:
                t = datetime.fromisoformat(ts_raw)
            except ValueError:
                continue
            minute_key = ts_raw[:16]
            spot = s.get('nq_spot')
            if not spot:
                continue

            # --- price index at snapshot ---
            i0 = bisect.bisect_right(ts_list, minute_key) - 1
            if i0 < 0 or ts_list[i0][:10] != minute_key[:10]:
                continue
            p0, sym0 = close_list[i0], sym_list[i0]

            # --- features (all as-of snapshot) ---
            flip = s.get('gamma_flip')
            res = [x for x in (s.get('resistance') or []) if x]
            sup = [x for x in (s.get('support') or []) if x]
            res_gex = s.get('resistance_gex') or []
            sup_gex = s.get('support_gex') or []
            near_res = min((x for x in res if x > spot), default=None)
            near_sup = max((x for x in sup if x < spot), default=None)
            et_hour = t.astimezone(ET).hour

            feat = {
                'ts': minute_key,
                'date': minute_key[:10],
                'segment': segment,
                'et_hour': et_hour,
                'spot': spot,
                'symbol': sym0,
                'regime': s.get('regime') or '',
                'flip_present': int(flip is not None),
                'flip_dist_pct': (flip - spot) / spot * 100 if flip else '',
                'abs_flip_dist_pct': abs(flip - spot) / spot * 100 if flip else '',
                'call_wall_dist_pct': (s['call_wall'] - spot) / spot * 100
                    if s.get('call_wall') else '',
                'put_wall_dist_pct': (spot - s['put_wall']) / spot * 100
                    if s.get('put_wall') else '',
                'near_res_dist_pct': (near_res - spot) / spot * 100 if near_res else '',
                'near_sup_dist_pct': (spot - near_sup) / spot * 100 if near_sup else '',
                'gamma_imbalance': s.get('gamma_imbalance', ''),
                'total_gex_sign': (0 if not s.get('total_gex')
                                   else math.copysign(1, s['total_gex'])),
                'log_total_gex_abs': (math.log10(abs(s['total_gex']))
                                      if s.get('total_gex') else ''),
                'wall_gex_ratio': (abs(s['call_wall_gex']) /
                                   (abs(s['call_wall_gex']) + abs(s['put_wall_gex']))
                                   if s.get('call_wall_gex') and s.get('put_wall_gex')
                                   else ''),
                'top_sup_share': (abs(sup_gex[0]) / sum(abs(x) for x in sup_gex)
                                  if sup_gex and sum(abs(x) for x in sup_gex) else ''),
                'top_res_share': (abs(res_gex[0]) / sum(abs(x) for x in res_gex)
                                  if res_gex and sum(abs(x) for x in res_gex) else ''),
            }

            # IV features: level + 15m/60m deltas + skew
            ivn, _ = iv_at(iv_map, iv_keys, minute_key)
            if ivn:
                iv, civ, piv = ivn
                feat['iv'] = iv
                feat['iv_skew'] = piv - civ
                for lbl, mins in (('iv_chg_15m', 15), ('iv_chg_1h', 60)):
                    prev_key = (t - timedelta(minutes=mins)).strftime('%Y-%m-%dT%H:%M')
                    ivp, _ = iv_at(iv_map, iv_keys, prev_key)
                    feat[lbl] = (iv - ivp[0]) if ivp else ''
            else:
                feat['iv'] = feat['iv_skew'] = ''
                feat['iv_chg_15m'] = feat['iv_chg_1h'] = ''

            # --- targets: forward log-returns, roll-censored ---
            ok_row = False
            for lbl, mins in HORIZONS.items():
                tgt_key = (t + timedelta(minutes=mins)).strftime('%Y-%m-%dT%H:%M')
                j = bisect.bisect_right(ts_list, tgt_key) - 1
                if j <= i0 or sym_list[j] != sym0:
                    feat[lbl] = ''
                    continue
                # require target minute within 3x horizon (halt/overnight guard)
                t_j = datetime.fromisoformat(ts_list[j] + ':00+00:00')
                if (t_j - t) > timedelta(minutes=mins * 3):
                    feat[lbl] = ''
                    continue
                feat[lbl] = math.log(close_list[j] / p0) * 100
                ok_row = True

            # MFE/MAE over MFE_WINDOW minutes (same contract only)
            end_key = (t + timedelta(minutes=MFE_WINDOW)).strftime('%Y-%m-%dT%H:%M')
            j_end = bisect.bisect_right(ts_list, end_key) - 1
            mfe = mae = 0.0
            for j in range(i0 + 1, j_end + 1):
                if sym_list[j] != sym0:
                    break
                r = math.log(close_list[j] / p0) * 100
                mfe = max(mfe, r)
                mae = min(mae, r)
            feat['mfe4h'] = mfe
            feat['mae4h'] = mae

            if ok_row:
                rows.append(feat)

    cols = list(rows[0].keys())
    out = HERE / 'features.csv'
    with open(out, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)
    print(f'{len(rows)} snapshot rows -> {out}')


if __name__ == '__main__':
    main()
