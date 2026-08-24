/** Detector registry: every detector module under patterns/** (excluding index/README) exports default. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));

export async function listDetectorFiles() {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js') && e.name !== 'index.js' && !e.name.startsWith('_')) out.push(p); } };
  walk(here);
  return out.sort();
}

/** @param {string|string[]} which 'all' | comma list of detector ids | array */
export async function loadDetectors(which = 'all') {
  const want = which === 'all' ? null : new Set(Array.isArray(which) ? which : which.split(','));
  const defs = [];
  for (const f of await listDetectorFiles()) {
    const m = await import(f);
    const d = m.default;
    if (!d || !d.id || !d.create) continue;
    if (want && !want.has(d.id)) continue;
    defs.push(d);
  }
  if (want) for (const w of want) if (!defs.find((d) => d.id === w)) throw new Error(`unknown detector ${w}`);
  return defs;
}
