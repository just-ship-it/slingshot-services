/**
 * Big-move momentum continuation — the one lead that survived drift-removal on dev AND validation.
 * After an unusually large N-candle move, continue in that direction with a noise-respecting stop
 * (160 ticks = 40 pts) and a large target (520 ticks = 130 pts), 6-hour cap. Rare, slow, lopsided —
 * the shape a market maker doesn't want and a fund can't size.
 * Thresholds are FROZEN from dev (5th/95th percentile of the N-candle net move).
 */
import { TickCore } from './tick-core.js';
import { TickBroker } from './broker.js';
export const MOMO_DEFAULTS = { ltf:'3m', seq:10, thrTicks:-116, side:'short', stopTicks:160, targetTicks:520,
                               capMin:360, cooldownMin:0, maxOrders:1, rthOnly:false };
export function runMomo(C,cfg={},from=0,to=C.n){
  const p={...MOMO_DEFAULTS,...cfg};
  const short=p.side==='short', dir=short?-1:1;
  const core=new TickCore({cache:C,timeframes:[p.ltf],watchCapacity:128});
  const broker=new TickBroker({core,tickValue:C.meta.product==='NQ'?5.0:12.5,commissionRT:5.0,
                               slipStopTicks:2,slipMktTicks:1,maxConcurrentOrders:p.maxOrders});
  const L=core.tf(p.ltf); const closes=[]; let nSig=0,last=-1e12;
  core.run(from,to,{
    onBarClose:(f,c)=>{
      if(f.tf!==p.ltf) return;
      closes.push(f.closedC); if(closes.length>60) closes.shift();
      if(closes.length<=p.seq) return;
      const net=f.closedC-closes[closes.length-1-p.seq];
      const hit = short ? net<=p.thrTicks : net>=p.thrTicks;
      if(!hit) return;
      if(c.ts-last < p.cooldownMin*60) return;
      last=c.ts; nSig++;
      broker.place({kind:'market',side:dir,resting:false,stopTicks:p.stopTicks,targetTicks:p.targetTicks,
                    maxHoldSec:p.capMin*60,group:'momo'});
    },
    onTick:()=>broker.onTick(), onArm:(m,l)=>broker.onArm(m,l), onRoll:()=>broker.cancelAll('roll'),
  });
  return {summary:broker.summary(),trades:broker.trades,nSig,cfg:p};
}
