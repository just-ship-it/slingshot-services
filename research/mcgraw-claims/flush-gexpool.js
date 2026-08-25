#!/usr/bin/env node
/**
 * Clear ONLY the letf-gamma-close gamma pool, preserving the day-move window.
 *
 * Why: the pool was carried over from the Schwab/hybrid provider (|gex| ~2.5-2.9)
 * and CBOE samples (~0.47) were being appended to it, because the legacy Redis
 * payload has no `gexSource` tag and the strategy's switch-detection only fires
 * when a KNOWN previous source differs. A mixed pool makes the percentile
 * deadband meaningless.
 *
 * `obs` (day move, |15:30 close - 09:30 open| in points) is price-derived and
 * provider-independent, so it is preserved untouched.
 */
import Redis from 'ioredis';

const KEY = process.env.LGC_REDIS_KEY || 'strategy:letf-gamma-close:observations';
const dry = process.argv.includes('--dry-run');

const r = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
await r.connect();

const raw = await r.get(KEY);
if (!raw) { console.error('key missing:', KEY); await r.quit(); process.exit(1); }

const cur = JSON.parse(raw);
const obs = Array.isArray(cur) ? cur : (cur.obs || []);
const pool = Array.isArray(cur.gexPool) ? cur.gexPool : [];

console.log(`before: obs=${obs.length} gexPool=${pool.length} gexSource=${cur.gexSource ?? 'ABSENT (legacy)'}`);
if (pool.length) {
  const vs = pool.map(o => o.v).filter(Number.isFinite).sort((a, b) => a - b);
  console.log(`  |gex| median ${vs[Math.floor(vs.length / 2)].toFixed(3)}  min ${vs[0].toFixed(3)}  max ${vs[vs.length - 1].toFixed(3)}`);
  const tagged = pool.filter(o => o.src).length;
  console.log(`  tagged with src: ${tagged}/${pool.length}`);
}

if (dry) { console.log('\n--dry-run: nothing written'); await r.quit(); process.exit(0); }

await r.set(KEY, JSON.stringify({ obs, gexPool: [], gexSource: 'cboe' }));
console.log(`after : obs=${obs.length} (PRESERVED) gexPool=0 gexSource=cboe`);
await r.quit();
