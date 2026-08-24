/** Columnar 1s cache loader. Columns stay as typed arrays (no per-bar objects, ever). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadCache(product, dir = path.join(__dirname, 'cache')) {
  const d = path.join(dir, product.toUpperCase());
  const meta = JSON.parse(fs.readFileSync(path.join(d, 'meta.json')));
  const rd = (n, T) => { const b = fs.readFileSync(path.join(d, n)); return new T(b.buffer, b.byteOffset, b.length / T.BYTES_PER_ELEMENT); };
  return {
    meta,
    ts: rd('ts.i32', Int32Array), o: rd('o.i32', Int32Array), h: rd('h.i32', Int32Array),
    l: rd('l.i32', Int32Array), c: rd('c.i32', Int32Array), v: rd('v.i32', Int32Array), sym: rd('sym.u8', Uint8Array),
    n: meta.nBars, tick: meta.tickSize,
    /** [startRow, endRow) for a trade date */
    day(td) { return meta.days[td]; },
    /** row range covering a date span (inclusive) */
    range(from, to) {
      const ks = Object.keys(meta.days).sort().filter((k) => (!from || k >= from) && (!to || k <= to));
      if (!ks.length) return null;
      return [meta.days[ks[0]][0], meta.days[ks[ks.length - 1]][1], ks];
    },
  };
}
