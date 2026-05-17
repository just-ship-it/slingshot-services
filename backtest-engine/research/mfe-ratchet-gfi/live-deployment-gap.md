# Live Deployment: The Gap We Need to Close

## Surprising finding (worth confirming with Drew in the morning)

While preparing M6 — staging the live-deploy diff so the chosen ratchet config
would actually run in production — I found that **the current live BE 70/+5 rule
appears to never run on the broker side for gex-flip-ivpct**. Documenting it
here so we can verify before deploying anything new.

### What the strategy emits today

`shared/strategies/gex-flip-ivpct.js:465-472` adds these fields to every signal
when `params.breakevenStop === true`:

```js
signal.breakeven_stop = true;
signal.breakevenStop = true;
signal.breakeven_trigger = trig;   // 70
signal.breakevenOffset = 5;
```

### What the orchestrator forwards

`trade-orchestrator/index.js:465-483` builds the `orderRequest` published to
`order.request`:

```js
const orderRequest = {
  ...,
  stopLoss: signal.stop_loss ?? null,
  takeProfit: signal.take_profit ?? null,
  trailingTrigger: signal.trailing_trigger ?? null,
  trailingOffset:  signal.trailing_offset  ?? null,
  ...
};
```

**The breakeven fields are not in `orderRequest`** — only `trailing_*`. The
breakeven fields are dropped here.

### What tradovate-service does with the order

`tradovate-service/TradovateClient.js:520-590` builds a Tradovate bracket with
`autoTrail` populated from `orderData.bracket1.autoTrail`, sourced from the
forwarded `trailingTrigger`/`trailingOffset`. There is **no Tradovate-native
"breakeven after X MFE" feature**. If we want a stop to move based on MFE
post-fill, *we* have to publish a `modify_stop` signal — which gex-flip-ivpct
never does. The orchestrator has no MFE-watching polling loop either; its
30 s loops cover EOD force-flat, max-hold, and stale limits only.

### What this implies for today's audit

Today's 5 signals were all rejected by `trading_disabled`, so we can only
talk about the hypothetical. But the hypothetical I gave during the audit
("BE saved Trade 1 for +$100") is probably **not the live behavior**:

- Trade 1: filled 29665.5, static SL 29725.5, static TP 29465.5. Price ran
  to 29526.75 then back to 29725.5. **SL would have hit. −$1,200.**
- Trade 2: 29677.5, SL 29737.5, hit 11:14. −$1,200.
- Trade 3: 29733, SL 29793, TP 29533. Drew said it didn't hit either, MFE 138,
  back to entry by 13:46. T3 would still be open at 16:40 → EOD force-flat
  by trade-orchestrator at the 16:40 ET market price.

If the live BE were actually wired, today's live P&L would have been roughly
**−$1,000** (per the audit). If it isn't wired, it could have been closer to
**−$2,400 to −$2,500** plus T3's EOD close (price level unknown without 1m
data for today).

This needs to be verified before we move forward. Two possible explanations:

1. **The BE rule has always been a backtest-only knob.** Backtest engine
   simulates it (trade-simulator.js:1057), live system never enforced it. The
   "tight-stop" sweep that produced PF 2.99 / Sharpe 6.41 reflects the
   simulator's BE behavior, but no live trade has actually benefited.
2. **There's a path I missed.** Possible — but I greped every file in
   trade-orchestrator/, tradovate-service/, and signal-generator/ for
   `breakeven|modify_stop|trailing` references and didn't find a runtime
   manager for non-AI strategies. Open to being shown otherwise.

## What the codebase already has for the live path

`signal-generator/src/ai/live-trade-manager.js` is a fully-built MFE ratchet
manager — same tier defaults as the backtest, publishes `modify_stop` signals,
wired into tradovate-service via the existing `modify_stop` action handler
(`cross-strategy-filter.js:34` whitelists it, `TradovateClient.js:721`
processes `modifyStop`).

It's currently instantiated only in AI-trader mode (`main.js:223`), bound to
`strategyConstant: 'AI_TRADER'`. The constructor already accepts
`strategyConstant` as a parameter, so the class is mostly strategy-agnostic
at the API level. Strategy-specific bits in the class today: LLM management
(opt-in), structural trail (uses LiveFeatureAggregator), condition tightening
(uses LT data).

## Proposed live wiring (post-sweep approval)

Once Drew picks a tier config in the morning, the path to live looks like:

1. **Confirm the gap.** Either find the missing live BE path I missed, or
   confirm that today's audit was based on a backtest-only feature.

2. **Generalize LiveTradeManager.**
   - Pass tier config in via constructor (replace hard-coded
     `MFE_RATCHET_TIERS` const at line 30).
   - Add a `mode` option that disables LLM management and structural/
     condition checks when running for non-AI strategies. The pure MFE
     ratchet path at `_checkMFERatchet` / `_modifyStop` is already isolated.
   - Strip the AI-specific imports out of the dependency path so a
     non-AI consumer doesn't have to wire `featureAggregator` /
     `llmClient` / `promptBuilder` just to get ratchet behavior.

3. **Wire into multi-strategy mode.** In `signal-generator/src/main.js` (or
   wherever the multi-strategy entry point lives), instantiate one
   `LiveTradeManager` per strategy that wants it, configured with that
   strategy's tier config:
   ```js
   this.gfiTradeManager = new LiveTradeManager({
     strategyConstant: 'GEX_FLIP_IVPCT',
     ratchetTiers: parseTiers(process.env.GFI_MFE_RATCHET_TIERS),
     ticker: candleBaseSymbol,
     // No LLM, no structural, no condition — pure ratchet
     pureRatchetMode: true,
   });
   ```
   Subscribe it to `position.opened` / `position.update` / `position.closed`
   filtered by `strategy === 'GEX_FLIP_IVPCT'`. Existing
   `multi-strategy-engine.js:218` already maintains per-strategy position
   state — we tap that.

4. **Configure via env vars.**
   - `GFI_MFE_RATCHET=true`
   - `GFI_MFE_RATCHET_TIERS="100:0.60,70:0.50"` (or whichever wins the sweep)
   - `GFI_BREAKEVEN_STOP=false` (sunset the BE config explicitly)

5. **Strategy emits the new fields** (so backtest parity is preserved and
   signal payload documents what's expected). Drop BE emission, add ratchet
   emission in `gex-flip-ivpct.js`. This is the actual code diff for the
   strategy file; ~20 lines.

6. **Verify in shadow.** Run for 1–2 sessions with `TRADING_ENABLED=false`
   but the manager active. Inspect that `modify_stop` signals fire on the
   expected MFE thresholds. Then flip the kill switch.

## Why I'm stopping short of staging the diff overnight

The plan said "stage a diff in the working tree." But the diff isn't a
config tweak — it's a meaningful refactor of `LiveTradeManager` (decoupling
from AI dependencies) plus new wiring in `main.js`. That's
substantial enough that Drew should:
- Review the gap analysis above and confirm or correct it
- Pick whether the wiring goes via generalized `LiveTradeManager` or via a
  new lean `GenericRatchetManager` (less risk to AI trader code path)
- Then we implement.

What IS staged for review (no `git add` performed):
- All the backtest-engine changes (M1-M5): metrics, sweep, ranking,
  today-replay. These are research artifacts — no production impact.
- This document.

Nothing in `shared/`, `signal-generator/`, `trade-orchestrator/`, or
`tradovate-service/` has been touched.
