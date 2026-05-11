/**
 * Relabel GEX snapshot timestamps to fix the 15-min bucketing lookahead.
 *
 * BACKGROUND
 * The intraday GEX generators (generate-intraday-gex.py, generate-cbbo-gex.js)
 * bucket OHLCV closes by floor(ts / interval) * interval and overwrite each
 * bucket's price with the LAST close in that window. So a snapshot labeled
 * `T:00` contains spot from up to T+14:59 — the data is from the END of the
 * bucket but the label is the START. Every NQ-space field (multiplier, walls,
 * gamma_flip, regime, gamma_imbalance) inherits this 14-min lookahead via
 * the spot price.
 *
 * FIX
 * Shift every snapshot's `timestamp` field forward by `--shift-min` minutes
 * (default 15) so the label reflects the as-of time when the data was
 * genuinely available. After this, the engine's GexLoader.getGexLevels(t)
 * (which returns the most recent at-or-before snapshot) will correctly hand
 * the strategy a snapshot whose data is in t's past.
 *
 * Usage:
 *   node scripts/relabel-gex-timestamps.js --dir data/gex/nq [--shift-min 15] [--dry-run]
 */

import fs from 'fs';
import path from 'path';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return process.argv[i + 1];
}

const DIR = arg('dir', null);
const SHIFT_MIN = Number(arg('shift-min', 15));
const DRY_RUN = process.argv.includes('--dry-run');

if (!DIR) {
  console.error('--dir is required (e.g., --dir data/gex/nq)');
  process.exit(1);
}

const absDir = path.isAbsolute(DIR) ? DIR : path.resolve(DIR);
if (!fs.existsSync(absDir)) {
  console.error(`Directory not found: ${absDir}`);
  process.exit(1);
}

console.log(`Relabel GEX snapshot timestamps`);
console.log(`Dir: ${absDir}`);
console.log(`Shift: +${SHIFT_MIN} min`);
console.log(`Dry run: ${DRY_RUN}`);
console.log('');

const files = fs.readdirSync(absDir).filter(f => f.endsWith('.json') && f.includes('_gex_'));
console.log(`Found ${files.length} GEX JSON files\n`);

let totalSnapshots = 0;
let filesUpdated = 0;
const sample = [];

for (const file of files) {
  const filePath = path.join(absDir, file);
  let content;
  try {
    content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    console.warn(`Skipping malformed file ${file}: ${e.message}`);
    continue;
  }

  if (!content.data || !Array.isArray(content.data)) continue;

  let snapshotsTouched = 0;
  for (const snap of content.data) {
    if (!snap.timestamp) continue;
    const oldTs = new Date(snap.timestamp);
    if (isNaN(oldTs.getTime())) continue;
    const newTs = new Date(oldTs.getTime() + SHIFT_MIN * 60000);
    if (sample.length < 3) {
      sample.push({ file, old: snap.timestamp, new: newTs.toISOString() });
    }
    snap.timestamp = newTs.toISOString();
    snapshotsTouched++;
  }

  // Update metadata to record the relabel
  if (content.metadata) {
    content.metadata.lookahead_relabel = {
      shift_minutes: SHIFT_MIN,
      applied_at: new Date().toISOString(),
      note: 'Snapshot timestamps shifted forward by shift_minutes to reflect ' +
            'as-of time. Original generators bucketed OHLCV by floor and kept ' +
            'last close in window, leaving each label 14 min stale.'
    };
  }

  totalSnapshots += snapshotsTouched;
  if (snapshotsTouched > 0) filesUpdated++;

  if (!DRY_RUN) {
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
  }
}

console.log('Sample relabels:');
for (const s of sample) {
  console.log(`  ${s.file}:  ${s.old}  →  ${s.new}`);
}
console.log('');
console.log(`Files updated: ${filesUpdated} / ${files.length}`);
console.log(`Snapshots relabeled: ${totalSnapshots}`);
if (DRY_RUN) console.log('\n(DRY RUN — no files written)');
