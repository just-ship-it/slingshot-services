#!/usr/bin/env python3
"""
End-to-end OOS acquisition + evaluation.

    STAGE 1 (free)     quote both months exactly, print, STOP.
    STAGE 2 (--confirm) submit batch jobs, download, extract, run FROZEN-OOS-EVAL.

Nothing is ever purchased without --confirm. Batch requests are NON-REFUNDABLE.

    python3 acquire-and-test.py                     # quote only — costs nothing
    python3 acquire-and-test.py --confirm           # quote + BUY + download + evaluate

Key is read from a file (never an argument, never echoed):
    ~/.databento_key   or  $DATABENTO_API_KEY   or  --key-file PATH
"""
import os, sys, glob, subprocess, argparse, time, shutil

# ---- the two months, chosen ROLL-FREE so each needs one symbol and one eval run ----
# REVISED 2026-08-22 after the real quote came in 53% above the model estimate
# ($81.18 for both vs ~$53 approved). Buying the DECISION-CRITICAL month only, within
# budget. Old-month probe (Oct 2021 NQZ1, $19.70) deferred — its FAIL would have been
# inconclusive anyway, so it cannot end the inquiry and is worth buying only if this passes.
PLAN = [
    dict(tag='2026-08_NQU6', symbol='NQU6', start='2026-07-22', end='2026-08-21',
         why='newest available: +6-7mo from in-sample, is the edge still alive?'),
]
SKIP_DAYS = ['20260730']   # Databento reports this session DEGRADED — excluded from eval
DATASET = 'GLBX.MDP3'
SCHEMA  = 'mbo'
BUDGET_CEILING = 53.00      # hard stop at the approved figure

def load_key(path=None):
    for p in ([path] if path else []) + [os.path.expanduser('~/.databento_key')]:
        if p and os.path.exists(p):
            k = open(p).read().strip()
            if k: return k
    k = os.environ.get('DATABENTO_API_KEY')
    if k: return k
    sys.exit("No API key. Put it in ~/.databento_key (chmod 600) or set DATABENTO_API_KEY.")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--confirm', action='store_true', help='actually spend money')
    ap.add_argument('--key-file')
    ap.add_argument('--out', default=os.path.expanduser('~/mbo-oos'))
    a = ap.parse_args()
    try:
        import databento as db
    except ImportError:
        sys.exit("pip install databento zstandard")
    c = db.Historical(load_key(a.key_file))

    # ---------------- STAGE 1: free quote ----------------
    print("="*70); print("STAGE 1 — QUOTE (free, no data transferred)"); print("="*70)
    total = 0.0
    for p in PLAN:
        cost = c.metadata.get_cost(dataset=DATASET, symbols=[p['symbol']], stype_in='raw_symbol',
                                   schema=SCHEMA, start=p['start'], end=p['end'])
        try:
            n = c.metadata.get_record_count(dataset=DATASET, symbols=[p['symbol']], stype_in='raw_symbol',
                                            schema=SCHEMA, start=p['start'], end=p['end'])
        except Exception:
            n = None
        total += cost
        p['cost'] = cost
        print(f"  {p['symbol']:<6} {p['start']} .. {p['end']}  ${cost:>8.2f}"
              f"{'  ' + format(n, ',') + ' records' if n else ''}   ({p['why']})")
    print("-"*70); print(f"  TOTAL: ${total:,.2f}   (model estimate was ~$53)")
    if total > BUDGET_CEILING:
        sys.exit(f"\nABORT: ${total:,.2f} exceeds the ${BUDGET_CEILING:.2f} ceiling. "
                 f"Re-check the plan before spending.")
    if not a.confirm:
        print("\nQuote only. Nothing purchased, nothing downloaded.")
        print("Re-run with --confirm to buy, download and evaluate.")
        return
    # ---------------- STAGE 2: purchase ----------------
    print("\n"+"="*70); print(f"STAGE 2 — PURCHASING ${total:,.2f} (non-refundable)"); print("="*70)
    os.makedirs(a.out, exist_ok=True)
    for p in PLAN:
        d = os.path.join(a.out, p['tag']); os.makedirs(d, exist_ok=True)
        if glob.glob(os.path.join(d, '*.mbo.csv')):
            print(f"  {p['tag']}: already downloaded, skipping"); continue
        job = c.batch.submit_job(dataset=DATASET, symbols=[p['symbol']], stype_in='raw_symbol',
                                 schema=SCHEMA, start=p['start'], end=p['end'],
                                 encoding='csv', compression='zstd', split_duration='day',
                                 pretty_px=True,      # decimal prices, not fixed-point ints
                                 pretty_ts=True,      # ISO 8601, not integer nanos
                                 map_symbols=True)    # REQUIRED: symbol column for front-month filter
        jid = job['id'] if isinstance(job, dict) else job.id
        print(f"  {p['tag']}: job {jid} submitted — waiting…")
        while True:
            st = [j for j in c.batch.list_jobs() if (j['id'] if isinstance(j, dict) else j.id) == jid]
            s = (st[0]['state'] if isinstance(st[0], dict) else st[0].state) if st else '?'
            if s == 'done': break
            if s in ('expired', 'cancelled'): sys.exit(f"job {jid} ended: {s}")
            time.sleep(20)
        c.batch.download(job_id=jid, output_dir=d)
        print(f"  {p['tag']}: downloaded")
        for z in glob.glob(os.path.join(d, '**', '*.zst'), recursive=True):
            subprocess.run(['zstd', '-d', '-f', '--rm', z], check=False)
        for f in glob.glob(os.path.join(d, '**', '*.csv'), recursive=True):
            if not f.endswith('.mbo.csv'):
                shutil.move(f, f.replace('.csv', '.mbo.csv') if '.mbo' not in f else f)
    # ---------------- STAGE 3: frozen evaluation, ONE RUN PER MONTH ----------------
    print("\n"+"="*70); print("STAGE 3 — FROZEN EVALUATION (parameters locked 2026-08-22)"); print("="*70)
    here = os.path.dirname(os.path.abspath(__file__))
    verdicts = {}
    for p in PLAN:
        d = os.path.join(a.out, p['tag'])
        # Databento nests downloads in a job-id subdir -> find where the CSVs actually are
        found = glob.glob(os.path.join(d, '**', '*.mbo.csv'), recursive=True)
        if not found:
            print(f"  {p['tag']}: NO CSVs FOUND — refusing to report a verdict"); continue
        src = os.path.dirname(found[0])
        # apply SKIP_DAYS via a symlink view so the frozen evaluator sees only clean sessions
        view = os.path.join(d, '_eval'); os.makedirs(view, exist_ok=True)
        for f in os.listdir(view): os.unlink(os.path.join(view, f))
        kept = 0
        for f in sorted(found):
            if any(sd in os.path.basename(f) for sd in SKIP_DAYS):
                print(f"  excluding degraded session: {os.path.basename(f)}"); continue
            os.symlink(f, os.path.join(view, os.path.basename(f))); kept += 1
        print(f"\n--- {p['tag']} ({kept} clean sessions) ---")
        r = subprocess.run([sys.executable, os.path.join(here, 'FROZEN-OOS-EVAL.py'), view, p['symbol']])
        verdicts[p['tag']] = {0:'CONFIRM', 1:'KILL', 2:'AMBIGUOUS'}.get(r.returncode, 'ERROR/NO-DATA')
    print("\n"+"="*70); print("SUMMARY"); print("="*70)
    for k, v in verdicts.items(): print(f"  {k:<16} {v}")
    print("\n  Recent-month FAIL is disqualifying. Old-month FAIL alone is INCONCLUSIVE —")
    print("  2022 NQ ran ~half today's message density. Do NOT re-tune and re-run.")

if __name__ == '__main__':
    main()
