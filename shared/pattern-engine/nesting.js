/** NestingIndex — which higher-tf instances are live (forming/confirmed) and contain a child. */
const CONTAINER_IDS = new Set(['compression-box', 'squeeze-on', 'orb-30', 'orb-60', 'globex-orb-30', 'nr-2bar']);
const MAX_PARENTS = 12;
export class NestingIndex {
  constructor(tfs, tfMinutes) { this.order = new Map(tfs.map((tf, i) => [tf, i])); this.tfMin = tfMinutes; this.live = new Map(); }
  reset() { this.live.clear(); }
  static isContainer(evt) {
    // Only multi-bar SHAPES act as parents (the "3m flag inside a 15m flag" question); structure/event
    // primitives are far too numerous and would bloat every event. Whitelist a few range containers.
    return (evt.family && evt.family.startsWith('chart-')) || CONTAINER_IDS.has(evt.patternId);
  }
  update(evt) {
    if (!NestingIndex.isContainer(evt)) return;
    const key = evt.instanceId;
    if (evt.state === 'forming' || evt.state === 'confirmed' || evt.state === 'triggered') {
      const cur = this.live.get(key);
      const spanStart = evt.anchors?.[0]?.ts ?? evt.ts;
      this.live.set(key, { instanceId: key, tf: evt.tf, patternId: evt.patternId, state: evt.state, direction: evt.direction,
        spanStart: cur?.spanStart ?? spanStart, levels: evt.levels });
    } else if (evt.state && (evt.state.startsWith('resolved') || evt.state === 'invalidated' || evt.state === 'expired')) {
      this.live.delete(key);
    }
  }
  /** parents of an event on tf: live instances on strictly higher tfs whose span started at/before the child's span */
  parents(evt) {
    const my = this.order.get(evt.tf);
    const childStart = evt.anchors?.[0]?.ts ?? evt.ts;
    const out = [];
    for (const p of this.live.values()) {
      if (this.order.get(p.tf) <= my) continue;
      if (p.spanStart > childStart) continue;
      const alignment = p.direction === 'bilateral' || evt.direction === 'bilateral' ? 'neutral' : p.direction === evt.direction ? 'same' : 'counter';
      out.push({ instanceId: p.instanceId, tf: p.tf, state: p.state, direction: p.direction, alignment });
    }
    if (out.length > MAX_PARENTS) { out.sort((a, b) => this.order.get(a.tf) - this.order.get(b.tf)); out.length = MAX_PARENTS; }
    // compact encoding: "<instanceId>|<state[0]>|<dir[0]>|<align[0]>"  (instanceId = product:tf:patternId:key)
    return out.map((p) => `${p.instanceId}|${p.state[0]}|${p.direction[0]}|${p.alignment[0]}`);
  }
}
