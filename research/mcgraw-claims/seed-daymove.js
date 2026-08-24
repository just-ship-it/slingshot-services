#!/usr/bin/env node
/**
 * Seed the letf-gamma-close DAY-MOVE buffer from historical OHLCV.
 *
 * Why this is safe (unlike seeding the gamma pool): day-move is |15:30 close −
 * 09:30 open| in NQ points — pure price, identical whatever GEX source runs live.
 * The gamma pool must NOT be seeded from foreign data (OPRA vs CBOE scale differs
 * ~25%), and this script never touches it.
 *
 * MERGES into the existing Redis value — preserves gexPool and any observations
 * the live strategy has already recorded. Dates already present are left alone.
 *
 *   node seed-daymove.js <nq_1m.csv> [--limit 40] [--dry-run]
 *   REDIS_URL=redis://... node seed-daymove.js ...     # target prod
 */
import fs from 'fs';
import Redis from 'ioredis';

const KEY = process.env.LGC_REDIS_KEY || 'strategy:letf-gamma-close:observations';
const file = process.argv[2];
const limit = parseInt((process.argv.find(a => a.startsWith('--limit=')) || '--limit=40').split('=')[1], 10);
const dry = process.argv.includes('--dry-run');
if (!file) { console.error('usage: seed-daymove.js <nq_1m.csv> [--limit=40] [--dry-run]'); process.exit(1); }

// --- compute |15:30 close - 09:30 open| per ET session ---
const rows = fs.readFileSync(file, 'utf8').trim().split('\n');
const hdr = rows[0].split(',');
const iTs = hdr.indexOf('ts'), iO = hdr.indexOf('open'), iC = hdr.indexOf('close');
const sess = new Map();
for (let i = 1; i < rows.length; i++) {
  const p = rows[i].split(',');
  const ms = parseInt(p[iTs], 10) * 1000;
  const d = new Date(ms);
  const et = d.toLocaleString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const [dp, tp] = et.split(', ');
  const [mm, dd, yy] = dp.split('/');
  let [hh, mi] = tp.split(':').map(Number);
  if (hh === 24) hh = 0;
  const key = `${yy}-${mm}-${dd}`;
  const mod = hh * 60 + mi;
  const r = sess.get(key) || {};
  if (mod === 570) r.open = parseFloat(p[iO]);          // 09:30 ET bar OPEN
  if (mod <= 930) r.last = parseFloat(p[iC]);           // running close through 15:30
  if (mod === 929) r.c1530 = parseFloat(p[iC]);         // the 15:29 bar closes AT 15:30
  sess.set(key, r);
}
const obs = [];
for (const [date, r] of [...sess.entries()].sort()) {
  const close = r.c1530 ?? r.last;
  if (!Number.isFinite(r.open) || !Number.isFinite(close)) continue;
  obs.push({ date, move: Math.abs(close - r.open) });
}
const seed = obs.slice(-limit);
console.log(`computed ${obs.length} sessions from ${file}; seeding last ${seed.length}`);
console.log(`  range ${seed[0]?.date} .. ${seed[seed.length - 1]?.date}`);
const mv = seed.map(o => o.move).sort((a, b) => a - b);
console.log(`  |day move| pts: median ${mv[Math.floor(mv.length / 2)].toFixed(1)}  min ${mv[0].toFixed(1)}  max ${mv[mv.length - 1].toFixed(1)}`);
if (dry) { console.log('\n--dry-run: nothing written'); process.exit(0); }

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: 2 });
await redis.connect();
const raw = await redis.get(KEY);
const cur = raw ? JSON.parse(raw) : {};
const curObs = Array.isArray(cur) ? cur : (cur.obs || []);
const gexPool = Array.isArray(cur.gexPool) ? cur.gexPool : [];
const have = new Set(curObs.map(o => o.date));
const added = seed.filter(o => !have.has(o.date));
const merged = [...curObs, ...added].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-60);
await redis.set(KEY, JSON.stringify({ obs: merged, gexPool }));
console.log(`\nMERGED -> ${KEY}`);
console.log(`  obs: ${curObs.length} existing + ${added.length} added = ${merged.length}`);
console.log(`  gexPool PRESERVED: ${gexPool.length} samples`);
await redis.quit();
