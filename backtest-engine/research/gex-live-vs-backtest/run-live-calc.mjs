// Endpoint A: run the REAL live ExposureCalculator on a Schwab snapshot.
import fs from 'fs';
import ExposureCalculator from '../../../signal-generator/src/tradier/exposure-calculator.js';

const day = process.argv[2] || '2026-05-08';
const targetHH = process.argv[3] || '14';
const qqqSpot = process.argv[4] ? parseFloat(process.argv[4]) : null;

const dir = `../../data/schwab-snapshots/${day}`;
const files = fs.readdirSync(new URL(dir, import.meta.url)).filter(f=>f.startsWith('snapshot_')).sort();
const pick = files.find(f=>f>=`snapshot_${targetHH}-00`) || files[Math.floor(files.length/2)];
const snap = JSON.parse(fs.readFileSync(new URL(`${dir}/${pick}`, import.meta.url),'utf8'));
const chains = snap.chains.QQQ || [];
const asOf = new Date(snap.timestamp);

// derive a spot if not given: use ATM (min |strike-?|) — but better require passed spot
const spot = qqqSpot;
const calc = new ExposureCalculator({ riskFreeRate: 0.05 });
const res = calc.calculateExposures({QQQ: chains}, {QQQ: spot}, {asOf});
const q = res.QQQ;
console.log(JSON.stringify({
  snapshot: pick, asOf: snap.timestamp, spot,
  totalGEX_B: (q.totals.gex/1e9).toFixed(2),
  callWall: q.levels.callWall, putWall: q.levels.putWall, gammaFlip: q.levels.gammaFlip,
  support: q.levels.support, resistance: q.levels.resistance,
  nStrikes: Object.keys(q.exposuresByStrike).length,
}, null, 1));
