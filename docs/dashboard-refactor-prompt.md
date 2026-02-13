# Slingshot Dashboard Layout Refactor

## Goal
Reorganize the main dashboard to show all key panels on a single screen (no scroll) on desktop/4K monitors. Currently the layout has excessive vertical space usage — the header area takes ~200px across multiple rows, and the panels don't fill the viewport efficiently.

## Reference Mockup
See `dashboard-mockup.html` in the project root for a static HTML mockup of the target layout. Use it for visual reference only — don't copy the code, implement it properly in React following existing project patterns.

## What to change

### 1. Compact Header (single row, ~36px tall)
Collapse the current multi-row header (ticker bar + account summary + positions row) into ONE dense horizontal bar:
- **Left side:** Logo, nav links, ticker prices with change %
- **Right side:** Balance, Available, Day P&L, Open Positions count, account selector, Live indicator, Logout
- Remove the "No active positions or pending orders" row entirely (or only render it when there ARE active positions)

### 2. Main Grid Layout — Desktop (≥1440px)
4-column top row + 2-column bottom row, filling the viewport with no scroll:

```
| IV Skew (1fr) | GEX Levels (1.3fr) | ES Cross-Signal (1.3fr) | ES GEX Levels (1.3fr) |
| NQ vs GEX Chart (span 2)           | ES vs GEX Chart (span 2)                         |
```

CSS grid with `height: calc(100vh - <header height>)` so everything fits in the viewport.

### 3. Panel Density
- Tighter padding and smaller font sizes within panels to fit more data
- GEX tables: show key levels (Call Wall, Zero Gamma, Put Wall) + top 3 resistance and top 3 support by default. Add a "Show all" toggle if there are more rows currently displayed.
- All existing data and functionality must be preserved — just more compact presentation

### 4. Responsive Breakpoints

**Tablet (768px - 1439px):**
```css
grid-template-columns: 1fr 1fr;
height: auto; /* scrolling is fine */
```
Chart panels span full width (`grid-column: span 2`).

**Phone (<768px):**
```css
grid-template-columns: 1fr;
```
Single column, everything stacks vertically, scroll is fine. Chart panels go `grid-column: span 1`.

**Header on narrow screens:** Allow tickers to wrap to a second line rather than overflow/truncate.

### 5. Platform Status Section
Move Platform Status out of the main dashboard viewport. Either:
- A separate route/page, OR
- A slide-out drawer/panel accessible from a status icon in the header
Use your judgment on which fits better with the existing routing/navigation patterns.

## Constraints
- This is a read-only visualization dashboard — no trading controls to worry about
- Preserve all existing WebSocket connections, data flows, and state management
- Don't change any backend/API contracts
- Follow existing component patterns and styling approach in the codebase
- Test that all panels still render their data correctly after the layout changes
