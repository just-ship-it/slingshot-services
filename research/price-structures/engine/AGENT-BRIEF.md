# Detector-implementation brief (shared by all detector agents)

Repo: /home/drew/projects/slingshot-services. Engine: `shared/pattern-engine/` (ES modules, no deps).
READ FIRST: `shared/pattern-engine/patterns/README.md` (contract), `engine.js`, `lifecycle.js`,
`features.js`, `pivots/{fractal,zigzag,track}.js`, `time.js`, and the example detector
`patterns/candles/single-bar.js`. Design context: `research/price-structures/DESIGN.md`; parameter
defaults: `research/price-structures/catalog/01-chart-patterns.md` §A, §D; candle normalization:
`catalog/02-candlestick-patterns.md` §1.3; equivalence table: `catalog/03-school-specific-structures.md` §7.

Hard rules
1. Only closed bars (`ctx.bars`) and confirmed pivots (`ctx.pivots.fractal|zigzag`, `.window(n)`, `.last(n)`).
   Every anchor's `confirmedAt` ≤ `ctx.now` or the engine throws. Never touch the future.
2. Emit `forming` ONCE per instance with a stable `key` (first anchor ts, plus a discriminator if
   the same anchors can yield several patternIds). The engine owns the lifecycle after that; you may
   additionally emit `invalidated` for geometry violations.
3. ATR-scale every threshold (`f.atr`, `f.scale`), floor in ticks (0.25). Bar-count durations ~constant across tfs.
4. Fill `geometry` with ATR-normalized descriptors (see README) — the probability layer conditions on them.
5. Tags: where a school name maps to the same primitive (catalog 03 §7), put aliases in
   `geometry.tags: [...]` rather than emitting duplicate events.
6. Keep detectors O(1)-ish per bar (bounded loops over ≤ 64 pivots / ≤ 400 bars).
7. Performance target: engine ≥ 2000 1m-bars/s with all detectors on 8 tfs.

Verify before reporting
- `node --check` each file; then knowability gate:
  `node research/price-structures/engine/test-knowability.js --start 2024-03-04 --end 2024-03-08 --cuts 6 --detectors <your ids>`
  and once more on `--start 2024-11-01 --end 2024-11-05` (DST fall-back). Both must print `KNOWABILITY: PASS`.
- Count sanity: `node research/price-structures/engine/run-historical.js --start 2024-03-04 --end 2024-03-08 --detectors <ids> --stats --out /tmp/claude-1000/-home-drew-projects-slingshot-services/2477722f-c0cd-43ec-b691-128902081a81/scratchpad/ev-<yourname>` and report events/day per patternId per tf; eyeball 3-5 emitted events against the raw bars for one pattern to confirm the geometry/levels are right (print the bars around an instance).
- Report: files written, patternIds emitted, per-tf counts/day, params chosen, known limitations.
Do NOT modify engine.js / lifecycle.js / features.js / pivots / time.js / aggregator.js — if you need a
change there, describe it precisely in your report instead.
