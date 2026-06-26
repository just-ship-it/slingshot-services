# Capital Flows Research — "theDesk" / "Mindset Corner" Slide Decks

**Source:** https://chimerical-dasik-375654.netlify.app/ (a self-contained "Segment Library" SPA)
**Author:** Jaymes Rosenthal — @JaymesRosenthal (YouTube) · https://www.capitalflowsresearch.com/
**Captured:** 2026-06-25

## How they were obtained
The Netlify page is a single-page app. The 13 decks are **not external links** — every deck is a complete,
self-contained HTML slide deck stored base64-encoded inside a `window.DECK_DATA = {…}` object in the page source.
Each was decoded to its own `.html` (open in a browser — they're interactive, arrow-key navigable) and a `.txt`
(plain-text dump of all slide copy for reading/grepping).

## Content character
These are **trading psychology / execution / market-structure** decks — discretionary-trader mindset material, not
quant signals. Two of them (`volregime`, `positioning`) and one (`exit`) contain ideas that map directly onto
existing Slingshot research threads (see "Relevance to your strategies" at the bottom). The rest are discipline/
framework material with no codifiable edge.

---

## The 13 decks

| File | Title | Category | One-line |
|------|-------|----------|----------|
| `exit` | The Art of the Exit | Execution & Psychology | Pre-commit a "credible exit" menu while calm; scale out ⅓/⅓/runner; grade process not outcome. |
| `knives` | Catching Knives | Risk & Timing | Buying violent dips: funnel macro→asset, scale in (¼s) not all-in, only with edge/plan/dry powder. |
| `bubble` | How To Trade A Bubble | Trading Psychology | Bubble vol is one-way (fading = death); rent the trend, bank in pieces, size is a staircase. |
| `oracle` | The Oracle Bet | Global Macro | Long-ORCL thesis: betting the company *and* Ellison; contrarian AI-infra capex bet. (Specific trade idea.) |
| `seat` | Own the Seat | Trading Psychology | Radical ownership: drop excuses, grade decisions not P&L, right-can-lose/wrong-can-win. |
| `iron` | The Iron Triangle | Trading Psychology | Edge / Frequency / Risk-capacity — pick 2. Archetypes: Sniper, Machine, Gambler. |
| `token` | The Token Flow | Market Structure | 10-layer AI value-chain map (apps→models→cloud→…→power→raw) + a tickered watchlist. |
| `trap` | The 24/7 Trap | Trading Psychology | 24/7 perps removed the closing bell; build an off-switch architecture; "sleep is a position." |
| `debrief` | Mindset Corner: The Debrief | Process | Run an OODA debrief on every trade (before/during/after report card) to harvest reps. |
| `positioning` | Positioning Into Events | Market Structure | The event isn't the trade — the crowd's *lean* into it is. Same headline, opposite move vs the book. |
| `volregime` | The Volatility Secret Sauce | Risk / Regime | Size to vol not conviction (constant *risk*, not constant size); vol clusters; suppressed vol = coiled spring. |
| `verthoriz` | Vertical vs Horizontal | Mindset | Specialist (deep, informational moat) vs generalist (portable process); the dangerous place is the middle. |
| `uthesunkcostfallacy` | The Sunk-Cost Fallacy | Mindset | Only forward EV matters; "would I buy this today from scratch?"; cut anchors. |

---

## Per-deck detail

### exit — The Art of the Exit (15 slides)
- A "credible exit" = pre-committed, specific, and yours (fits personality + objective). Decide it while flat/calm.
- **Exit menu** (map ALL conditions you'd be happy leaving on): S/R levels, move×time target, vol expansion / rich
  premium, sentiment flip to euphoria, crowded positioning, put/call skew, sector over-exuberance, your own tell.
- Scenario plan if-this-then-that *before* entry. Guardrails to avoid reactionary "it'll keep running."
- Two leak profiles: A "gives it back" (holds too long → fix: exit at spots) vs B "sells too soon" (→ let runners run).
- **Scale out ⅓ / ⅓ / runner** — satisfies the urge to claim victory while keeping big-outcome exposure.

### knives — Catching Knives (9 slides)
- Funnel **macro regime first** (rates, dollar, geopolitics, inflation/oil) → only then the asset.
- Checklist before catching: real experience, reading regime, recent results solid, long horizon, conviction,
  allocation room, defined risk + written plan, calm. More boxes = a decision, not a flinch.
- Distinguish "a trade" (tight invalidation, small, quick) from "conviction" (scale over time, wider berth, years).
- **Scale in ¼/¼/¼/reserve** — never lunge all-in at the first scary print.

### bubble — How To Trade A Bubble (15 slides)
- Price = belief; doubt is fuel; reflexivity. Life cycle: stealth→awareness→mania→blow-off (smart money early, public late).
- Historical manias (tulips, dot-com, housing, crypto) all same shape.
- **Bubble vol ≠ normal vol**: normal is mean-reverting (fade extremes); bubble is one-way trend (fading = death).
- Size is a staircase, not a leap. Aggressive *inside the lines*: size to conviction, fixed daily risk, add to winners
  only, pre-written exit. Tells it's ending: vertical blow-off, everyone an expert, good news stops working, narrowing breadth.
- Goal: don't call the top — **rent the trend, keep the gains.**

### oracle — The Oracle Bet (21 slides)  ← only deck with a concrete trade idea
- Long Oracle (ORCL) thesis. Two stacked bets: the company + the operator (Larry Ellison).
- Macro backdrop framing: long-end up, short-term real rates down, money out the risk curve; growth strong + no recession.
- Entry ~−61% off highs, clear invalidation, "domino" upside. Explicitly: not free money — define size, define where wrong.
- *(Dated, single-name equity idea — not relevant to your NQ futures system except as a macro-regime read.)*

### seat — Own the Seat (13 slides)
- Radical ownership: bet on yourself, drop every excuse, accept every result, own how you move forward.
- The 2×2: right+win=earned, wrong+win=lucky/noise, right+lose=unlucky/noise, wrong+lose=deserved → **grade the
  decision, not the result.** A loss you examine is data; a loss you blame vanishes.
- Three rings must align to *you*: strategy / time horizon / risk. Copying someone else's trade misaligns the rings.

### iron — The Iron Triangle (11 slides)
- **Edge · Frequency · Risk-capacity — pick two**, the third always pays the bill. Sum to 100%.
- Archetypes: **Sniper** (gives up frequency), **Machine** (gives up edge), **Gambler** (gives up risk-capacity/safety).
- Overload = trying to max all three → overtrading, oversize, surprise drawdown.

### token — The Token Flow (15 slides)  ← tickered AI value-chain map
- "Every AI dollar enters in one place and flows to ten." 10-layer stack, margin gets fatter the deeper you go:
  00 end-user demand → 01 apps (contested) → 02 models (cash burn) → 03 cloud/inference (strong) →
  04 interconnect/memory (oligopoly) → 05 accelerators (NVDA monopoly/toll booth) → 06 foundry (TSMC near-monopoly) →
  07 chip equipment (ASML chokepoint) → 08 power & cooling (binding constraint) → 09 raw inputs (cyclical, upstream).
- Hyperscalers (MSFT/AMZN/GOOGL) = "the valve," not a pure-play layer.
- Includes a full **watchlist of tickers per layer** (see `token.txt` bottom). Lesson: "follow the bottleneck."

### trap — The 24/7 Trap (12 slides)
- 24/7 perps removed the closing bell, which was actually *protection* (forced rest, off-ramp for tilt).
- Decision quality decays with screen hours; "always on" is compulsion mislabeled as dedication.
- Build the **off-switch architecture** (set your own hours, phone in another room, fixed sleep window). "Sleep is a position."

### debrief — The Debrief (8 slides)
- Harvest each trade with an OODA debrief: **Before** (plan/feeling/why), **During** (executing vs reacting), **After**
  (report card: Process / Risk-mgmt / Execution / Mindset, graded A–F on *process not P&L*). Then pre-game the next.

### positioning — Positioning Into Events (12 slides)  ← maps to your event research
- "The event was never the trade — how everyone is positioned into it is."
- The reactive crowd *is the liquidity*; you want to be the fill, not the chaser.
- Ask "**who's positioned?**" not "what happens?" Read the lean via: price action into the event, IV/term structure,
  credit spreads, put/call skew, fear&greed, COT, real-time positioning.
- **Same headline → opposite move depending on the book**: hawkish-surprise into crowded longs = violent unwind/air
  pocket; into already-short crowd = shrug. Dovish into shorts = face-rip squeeze.
- Redundancy-plan the range with weighted branches; write the if→then *before* the bell (invert the reactive crowd).

### volregime — The Volatility Secret Sauce (12 slides)  ← maps directly to your vol-regime filter work
- "You're reading nominal; the tape trades real." A +3% move is a 3-sigma shock in a calm regime and background noise
  in a storm regime — **divide the move by the regime** (the vol denominator).
- **Vol clusters** (calm begets calm, chaos begets chaos); the handoff between regimes is where people get hurt.
- **Constant risk, not constant size**: as vol rises, size comes down — hold *risk* flat, never share count.
- Pre-define triggers: IF vol expands past my line → cut size; IF ranges double → widen stops/step off; IF book one-sided
  → hedge tail; IF vol cheap & ignored → add convexity.
- Suppressed vol = compressed spring (complacency, correlations rise, violent repricing on release).
- Edge lives where vol is *mispriced* — cheap convexity in ignored corners, positioned before it screams.

### verthoriz — Vertical vs Horizontal (11 slides)
- Two honest edges: **Vertical** = informational moat (one well, all the way down — e.g. an oil specialist who knows the
  futures complex, crack spreads, COT, structural bull/bear). **Horizontal** = procedural moat (portable framework:
  asymmetry, downside control, rotation, correlation — "go where the vol goes").
- The trap is the *middle* (no moat, no process). Two overreach failure modes: false-specialist (sizes big without the
  moat → exit liquidity) and the Dunning-Kruger specialist (assumes edge transfers). Choose by temperament, not merit.

### uthesunkcostfallacy — The Sunk-Cost Fallacy (12 slides)
- Already-spent time/money/research is gone; **forward EV is the only input a dollar cares about.**
- The trap is identity ("I'm a ___ guy", $TICKER = who I am). Excuse-tells are anchors: "too deep to sell," "just need
  breakeven," "it'll come back," "averaging down lowers cost basis."
- The cutting question: **"With fresh cash and zero history, would I buy this — here, at this size — today?"** If no, trim/cut.

---

## Relevance to your strategies (Slingshot)

Most of this is discretionary-trader psychology and won't change a backtest. The three that genuinely intersect
existing research threads:

1. **`volregime` ↔ your vol-regime FCFS filter** (`memory/vol-regime-filter-fcfs.md`, `research/vix-vol-es/`).
   Reinforces the core idea you're already testing: size/gate to a vol regime, hold *risk* constant not size, and that
   suppressed vol precedes violent repricing. Confirms the direction; no new mechanics, but the "constant risk not
   constant size" framing is a clean way to think about per-regime position sizing (vs your current per-strategy
   on/off gating). Worth considering: regime-scaled quantity rather than binary enable/disable.

2. **`positioning` ↔ your event-positioning audit** (`memory/event-positioning-audit-2026-06-17.md`).
   Your audit *concluded no flatten rule* (book already avoids events via short holds + 15:45 EOD). This deck argues the
   opposite-of-naive view: the tradeable variable is the *lean* (IV term structure, skew, COT, credit) not the print.
   Your strategies don't currently read positioning into FOMC/CPI. If you ever revisit event behavior, "read the lean"
   (e.g. put/call skew + IV term structure as a pre-event gate) is the concrete, data-available angle — and you already
   compute IV skew in data-service.

3. **`exit` ↔ your exit-rule / MFE / scale-out research** (gold-standard BE/target/trail work across glf/gfi/glx/lstb).
   The "exit menu" and "⅓/⅓/runner" framing aligns with your per-rule BE + target-widening findings and your prior
   conclusion that *trailing stops destroy edge* while structural BE catches the "MFE 60-80% → SL" pattern. Nothing to
   change, but the deck's "vol expansion / rich premium" and "crowded positioning" as exit triggers are levers you
   haven't tested as exit conditions (you've tested static BE/target/trail, not vol-expansion-triggered exits).

Net: **no plug-and-play signal here** — these are framework decks. The only directly actionable thread is using
volatility-regime and options-positioning (skew/IV-term) reads you *already compute* as gates/sizers, which you're
partly exploring already.
