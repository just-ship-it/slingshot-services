// Priority-weighted: gex-flip-ivpct (1) > gex-lt-3m (2) > gex-level-fade (3).
// Higher-priority signals can PREEMPT a lower-priority open position
// (synthetic close, then open the preempting trade).
// Same-priority conflicts → keep current.
//
// Same flip-PnL caveat as flip-on-conflict: synthetic closes on preemption may
// be optimistic if the displaced trade would've hit its stop sooner.

import { priorityFor } from '../lib/load-trades.js';
import { open, reject, realizeNativeClose, realizeSyntheticClose } from './_base.js';

export const priorityWeighted = {
  name: 'priority-weighted',
  onSignal(state, trade) {
    if (state.position == null) {
      open(state, trade);
      return;
    }
    const pNew = priorityFor(trade.strategyKey);
    const pHeld = priorityFor(state.position.trade.strategyKey);
    if (pNew < pHeld) {
      // Higher priority → preempt
      realizeSyntheticClose(state, trade.entryTime, trade.actualEntry, 'preempted');
      open(state, trade);
    } else {
      reject(state);
    }
  },
  onNativeExit(state, trade) {
    if (state.position && state.position.trade.id === trade.id) {
      realizeNativeClose(state, trade);
    }
  },
};
