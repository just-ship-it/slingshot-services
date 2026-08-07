#!/usr/bin/env python3
"""
09-confluence-tagger.py — Causal spatial-confluence census for the jv-ict
signal universe (3,600 signals, 2021-01-18 → 2024-12-31).

For each signal, computes AT SIGNAL TIME (closed bars only, strictly causal)
which independent levels/states align with the signal's ENTRY PRICE:

  Band-independent (from engine-captured metadata / replayed state):
    fib_band     entry inside the 50-79% band (baseline — entry definition)
    imb_overlap  an imbalance zone overlaps the fib band (metadata)
    ob_overlap   the order block overlaps the fib band (metadata)
    htf_align    causal 1H structure state (jv-ict.js discipline) agrees with side
    smt          ES 15m divergence at the final sweep push (jv-ict.js smtMode logic)

  Level-proximity (|level - entry| <= band; band = max(15 pts, 0.1% of entry),
  also computed at 0.5x and 2x as robustness):
    pdh_pdl      previous-day high or low (engine metadata, verified vs replay)
    daily_open   today's 18:00-ET session open (engine metadata, verified)
    weekly_open  current trading week's open (replayed)
    monthly_open current month's first-session open (replayed)
    prev_week_hl prior completed week's high or low (replayed)

  confluence_count = imb_overlap + ob_overlap + pdh_pdl + daily_open +
                     weekly_open + monthly_open + prev_week_hl + htf_align + smt
  (fib_band excluded — it is the entry definition, not a countable confluence)

Causality:
  - NQ 1m continuous replayed chronologically from file start (2020-12-27,
    pre-dev warmup; strictly past data) through 2024-12-31; aggregated to
    closed 15m bars (epoch-floor buckets — identical to CandleAggregator
    under a whole-hour-offset TZ). All state updates use only bars whose
    close time <= the signal's decision time (signal.ts = MSS 15m close).
  - Day/week/month keying uses the 18:00 ET Globex boundary exactly as
    jv-ict.js _tradingDayInfo. Opens taken from the first bar of the period;
    partial first periods are marked untrusted (None).
  - 1H structure: exact port of jv-ict.js _processClosedHtfBar (pivotN=2
    fractals confirmed with 2-bar lag, close-confirmed breaks vs
    levels-as-of-prior-close, maxSwings 300); a 1H bucket is consumed only
    once its period end <= the current 15m close time.
  - SMT: ES 1m continuous deduped by timestamp, aggregated to UTC-aligned
    15m, run through the exact _processEsBar discipline; per-ES-bar sweep
    info keyed by period start; looked up at the signal's final sweep-push
    bar (metadata.sweep_extreme_ts). ES bar closes at/before MSS close.
  - Replayed daily_open / pdh / pdl are cross-checked against the engine's
    own captured metadata for every signal (report printed).

Output: confluence-tags.csv (one row per signal).
Never reads any data at/after 2025-01-01.
"""
import csv
import json
import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

ROOT = '/home/drew/projects/slingshot-services/backtest-engine'
RES = f'{ROOT}/research/jv-ict-2026-07'
NQ_1M = f'{ROOT}/data/ohlcv/nq/NQ_ohlcv_1m_continuous.csv'
ES_1M = f'{ROOT}/data/ohlcv/es/ES_ohlcv_1m_continuous.csv'
SIGNALS = f'{RES}/signals-universe.json'
OUT = f'{RES}/confluence-tags.csv'

END_MS = int(datetime(2025, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)  # hard stop: never touch 2025+
ET = ZoneInfo('America/New_York')
PIVOT_N = 2
MAX_SWINGS = 300
M15 = 900_000
H1 = 3_600_000


def parse_ts_ms(s):
    # '2020-12-27 23:00:00+00:00' — always UTC
    return int(datetime.fromisoformat(s).timestamp() * 1000)


def read_1m(path):
    """Yield (ts_ms, o, h, l, c) rows < END_MS, deduped by timestamp."""
    seen_last = -1
    with open(path) as f:
        f.readline()
        for line in f:
            p = line.split(',')
            ts = parse_ts_ms(p[0])
            if ts >= END_MS:
                break  # files are chronological
            if ts == seen_last:
                continue  # dedupe consecutive duplicate timestamps
            seen_last = ts
            yield ts, float(p[1]), float(p[2]), float(p[3]), float(p[4])


def aggregate_15m(rows):
    """Epoch-floor 15m aggregation; yields closed bars as dicts."""
    cur = None
    for ts, o, h, l, c in rows:
        b = ts - ts % M15
        if cur is None or b != cur['ts']:
            if cur is not None:
                yield cur
            cur = {'ts': b, 'open': o, 'high': h, 'low': l, 'close': c}
        else:
            cur['high'] = max(cur['high'], h)
            cur['low'] = min(cur['low'], l)
            cur['close'] = c
    if cur is not None:
        yield cur


# ---------------------------------------------------------------------------
# Shared structure discipline (port of jv-ict.js pivot/break logic)
# ---------------------------------------------------------------------------

def last_unbroken(swings):
    for s in reversed(swings):
        if not s['broken']:
            return s
    return None


class StructureTracker:
    """pivotN-lagged fractal pivots + close-confirmed breaks.
    Port of _processClosedHtfBar / _processEsBar (identical discipline)."""

    def __init__(self):
        self.bars = []          # dicts ts/open/high/low/close
        self.highs = []         # {price, broken}
        self.lows = []
        self.structure = None   # 'bullish' | 'bearish' | None

    def process_bar(self, bar):
        b = self.bars
        b.append(bar)
        idx = len(b) - 1
        i = idx - PIVOT_N
        if i >= PIVOT_N:
            is_high = all(b[i]['high'] > b[i - k]['high'] and b[i]['high'] > b[i + k]['high']
                          for k in range(1, PIVOT_N + 1))
            is_low = all(b[i]['low'] < b[i - k]['low'] and b[i]['low'] < b[i + k]['low']
                         for k in range(1, PIVOT_N + 1))
            if is_high:
                self.highs.append({'price': b[i]['high'], 'broken': False})
                if len(self.highs) > MAX_SWINGS:
                    self.highs.pop(0)
            if is_low:
                self.lows.append({'price': b[i]['low'], 'broken': False})
                if len(self.lows) > MAX_SWINGS:
                    self.lows.pop(0)

        # Sweep info + breaks vs levels as of PRIOR close (pre-broken-marking)
        sh = last_unbroken(self.highs)
        sl = last_unbroken(self.lows)
        info = {
            'hasHigh': sh is not None,
            'hasLow': sl is not None,
            'sweptHigh': sh is not None and bar['high'] > sh['price'],
            'sweptLow': sl is not None and bar['low'] < sl['price'],
        }
        broke_up = sh is not None and bar['close'] > sh['price']
        broke_down = sl is not None and bar['close'] < sl['price']
        if broke_up and broke_down:
            self.structure = 'bullish' if bar['close'] >= bar['open'] else 'bearish'
        elif broke_up:
            self.structure = 'bullish'
        elif broke_down:
            self.structure = 'bearish'

        for s in self.highs:
            if not s['broken'] and bar['close'] > s['price']:
                s['broken'] = True
        for s in self.lows:
            if not s['broken'] and bar['close'] < s['price']:
                s['broken'] = True
        return info


# ---------------------------------------------------------------------------
# ES pass: per-15m-bar sweep info (SMT source), keyed by period-start ms
# ---------------------------------------------------------------------------

def build_es_info():
    tracker = StructureTracker()
    info_by_ts = {}
    n = 0
    for bar in aggregate_15m(read_1m(ES_1M)):
        info_by_ts[bar['ts']] = tracker.process_bar(bar)
        n += 1
    print(f'ES 15m bars processed: {n} '
          f'({datetime.fromtimestamp(min(info_by_ts)/1000, timezone.utc):%Y-%m-%d} → '
          f'{datetime.fromtimestamp(max(info_by_ts)/1000, timezone.utc):%Y-%m-%d})')
    return info_by_ts


def smt_status(es_info, is_short, push_ts_ms):
    info = es_info.get(push_ts_ms)
    if info is None:
        return None
    if is_short:
        if not info['hasHigh']:
            return None
        return 'agree' if info['sweptHigh'] else 'divergent'
    if not info['hasLow']:
        return None
    return 'agree' if info['sweptLow'] else 'divergent'


# ---------------------------------------------------------------------------
# NQ replay: daily / weekly / monthly opens+extremes and 1H structure
# ---------------------------------------------------------------------------

def et_parts(ts_ms):
    dt = datetime.fromtimestamp(ts_ms / 1000, ET)
    return dt


def trading_day_key(dt_et):
    """18:00 ET Globex boundary: bars at/after 18:00 belong to next day."""
    d = dt_et.date()
    if dt_et.hour >= 18:
        d = d.fromordinal(d.toordinal() + 1)
    return d


def week_key(day):
    """Monday of the trading week containing trading-day `day`."""
    return day.fromordinal(day.toordinal() - day.weekday())


def replay_nq(signals_by_ts):
    """One chronological pass over closed NQ 15m bars. For each signal ts
    (a 15m close time), snapshot causal state AFTER feeding the bar that
    closes at that ts (mirrors jv-ict.js: _updateDaily runs on the decision
    bar before the signal is emitted; HTF bars consumed when period end <=
    closeTs)."""
    htf = StructureTracker()
    htf_bucket = None  # in-progress 1h bucket

    # daily (mirror of _updateDaily incl. partial-day handling)
    cur_day = None
    cur_day_partial = True
    day_high = day_low = None
    daily_open = None
    pdh = pdl = None

    # weekly
    cur_week = None
    cur_week_partial = True
    week_high = week_low = None
    weekly_open = None
    pwh = pwl = None

    # monthly
    cur_month = None
    cur_month_partial = True
    monthly_open = None

    out = {}
    nbars = 0
    for bar in aggregate_15m(read_1m(NQ_1M)):
        ts = bar['ts']
        close_ts = ts + M15
        nbars += 1
        dt = et_parts(ts)
        day = trading_day_key(dt)
        is_session_open_bar = dt.hour == 18 and dt.minute == 0

        # --- daily roll (bar START time keying, as in jv-ict.js) ---
        if day != cur_day:
            if cur_day is not None and not cur_day_partial:
                pdh, pdl = day_high, day_low
            elif cur_day is not None:
                pdh = pdl = None
            cur_day = day
            day_high, day_low = bar['high'], bar['low']
            cur_day_partial = not is_session_open_bar
            daily_open = bar['open'] if is_session_open_bar else None
        else:
            day_high = max(day_high, bar['high'])
            day_low = min(day_low, bar['low'])

        # --- weekly roll (week of the trading day; opens at Sunday 18:00 ET) ---
        wk = week_key(day)
        if wk != cur_week:
            if cur_week is not None and not cur_week_partial:
                pwh, pwl = week_high, week_low
            elif cur_week is not None:
                pwh = pwl = None
            first_week = cur_week is None
            cur_week = wk
            week_high, week_low = bar['high'], bar['low']
            # trustworthy only if the week starts at its first session open
            cur_week_partial = first_week or not is_session_open_bar
            weekly_open = None if cur_week_partial else bar['open']
        else:
            week_high = max(week_high, bar['high'])
            week_low = min(week_low, bar['low'])

        # --- monthly roll (month of the trading day) ---
        mo = (day.year, day.month)
        if mo != cur_month:
            first_month = cur_month is None
            cur_month = mo
            cur_month_partial = first_month or not is_session_open_bar
            monthly_open = None if cur_month_partial else bar['open']

        # --- 1H structure: feed bar, consume buckets whose end <= close_ts ---
        hb = ts - ts % H1
        if htf_bucket is None or hb != htf_bucket['ts']:
            if htf_bucket is not None:
                # previous bucket necessarily ended at/before this bar's start
                htf.process_bar(htf_bucket)
            htf_bucket = {'ts': hb, 'open': bar['open'], 'high': bar['high'],
                          'low': bar['low'], 'close': bar['close']}
        else:
            htf_bucket['high'] = max(htf_bucket['high'], bar['high'])
            htf_bucket['low'] = min(htf_bucket['low'], bar['low'])
            htf_bucket['close'] = bar['close']
        if htf_bucket['ts'] + H1 <= close_ts:
            htf.process_bar(htf_bucket)
            htf_bucket = None

        # --- snapshot state for any signal decided at this bar's close ---
        if close_ts in signals_by_ts:
            out[close_ts] = {
                'daily_open_replay': daily_open,
                'pdh_replay': pdh,
                'pdl_replay': pdl,
                'weekly_open': weekly_open,
                'monthly_open': monthly_open,
                'prev_week_high': pwh,
                'prev_week_low': pwl,
                'htf1h_structure': htf.structure,
            }
    print(f'NQ 15m bars processed: {nbars}')
    return out


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    with open(SIGNALS) as f:
        sigs = json.load(f)['signals']
    print(f'signals: {len(sigs)}')
    sig_ts = {s['ts'] for s in sigs}

    es_info = build_es_info()
    state = replay_nq(sig_ts)

    missing_state = [s['ts'] for s in sigs if s['ts'] not in state]
    if missing_state:
        print(f'WARNING: {len(missing_state)} signals with no replay state (first: {missing_state[:3]})')

    # verification: replayed daily context vs engine metadata
    mismatch = {'daily_open': 0, 'pdh': 0, 'pdl': 0}
    compared = {'daily_open': 0, 'pdh': 0, 'pdl': 0}

    rows = []
    bands = {'half': 0.5, 'primary': 1.0, 'double': 2.0}
    for s in sigs:
        m = s['metadata']
        ts = s['ts']
        st = state.get(ts, {})
        entry = s['entryPrice']
        side = s['side']
        is_short = side == 'sell'

        # engine-canonical daily context
        d_open, d_pdh, d_pdl = m['daily_open'], m['pdh'], m['pdl']
        for name, eng, rep in (('daily_open', d_open, st.get('daily_open_replay')),
                               ('pdh', d_pdh, st.get('pdh_replay')),
                               ('pdl', d_pdl, st.get('pdl_replay'))):
            if eng is not None and rep is not None:
                compared[name] += 1
                if abs(eng - rep) > 1e-6:
                    mismatch[name] += 1

        # band-independent features
        fib_band = m['band_low'] - 1e-9 <= entry <= m['band_high'] + 1e-9
        imb_overlap = len(m['imb_overlaps']) > 0
        ob_overlap = bool(m['ob_zone'] and m['ob_zone']['overlaps'])
        htf_struct = st.get('htf1h_structure')
        htf_align = htf_struct == ('bearish' if is_short else 'bullish')
        push_ts = parse_ts_ms(m['sweep_extreme_ts'].replace('Z', '+00:00'))
        smt_st = smt_status(es_info, is_short, push_ts)
        smt = smt_st == 'divergent'

        base_band = max(15.0, 0.001 * entry)
        levels = {
            'pdh_pdl': [d_pdh, d_pdl],
            'daily_open': [d_open],
            'weekly_open': [st.get('weekly_open')],
            'monthly_open': [st.get('monthly_open')],
            'prev_week_hl': [st.get('prev_week_high'), st.get('prev_week_low')],
        }

        row = {
            'signal_ts': datetime.fromtimestamp(ts / 1000, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z'),
            'side': side,
            'entry': entry,
            'year': datetime.fromtimestamp(ts / 1000, timezone.utc).year,
            'band_pts': round(base_band, 4),
            'fib_band': int(fib_band),
            'imb_overlap': int(imb_overlap),
            'ob_overlap': int(ob_overlap),
            'htf_align': int(htf_align),
            'htf1h_structure': htf_struct or '',
            'smt': int(smt),
            'smt_status': smt_st or '',
            'pdh': d_pdh, 'pdl': d_pdl, 'daily_open_lvl': d_open,
            'weekly_open_lvl': st.get('weekly_open'),
            'monthly_open_lvl': st.get('monthly_open'),
            'prev_week_high': st.get('prev_week_high'),
            'prev_week_low': st.get('prev_week_low'),
        }
        for bname, mult in bands.items():
            bd = base_band * mult
            total = imb_overlap + ob_overlap + htf_align + smt
            for feat, lvls in levels.items():
                hit = any(l is not None and abs(l - entry) <= bd for l in lvls)
                row[f'{feat}_{bname}'] = int(hit)
                total += hit
            row[f'confluence_count_{bname}'] = total
        rows.append(row)

    print('verification vs engine metadata (non-null both sides):')
    for k in compared:
        print(f'  {k}: compared {compared[k]}, mismatches {mismatch[k]}')

    fields = list(rows[0].keys())
    with open(OUT, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    print(f'wrote {len(rows)} rows -> {OUT}')

    # quick distribution print
    from collections import Counter
    c = Counter(r['confluence_count_primary'] for r in rows)
    print('confluence_count (primary band) distribution:', dict(sorted(c.items())))


if __name__ == '__main__':
    main()
