import { loadTrades } from "./utils/data-loader.js";
import { calculatePerformance } from "./utils/analysis-helpers.js";

const trades = await loadTrades();

// Get ALL unique signal types
const signalTypes = {};
trades.forEach(t => {
  const type = t.signal?.metadata?.signalType || t.signal?.signalType || "unknown";
  if (!signalTypes[type]) signalTypes[type] = [];
  signalTypes[type].push(t);
});

console.log("=== ALL SIGNAL TYPES ===\n");
Object.entries(signalTypes)
  .sort((a,b) => b[1].length - a[1].length)
  .forEach(([type, trs]) => {
    const perf = calculatePerformance(trs);
    console.log(type + ":");
    console.log("  Trades:", perf.tradeCount);
    console.log("  Win Rate:", perf.winRate + "%");
    console.log("  Total P&L: $" + perf.totalPnL);
    console.log();
  });

// Look at a sample OB_BOUNCE trade
const obBounce = trades.filter(t => {
  const type = t.signal?.metadata?.signalType || t.signal?.signalType;
  return type === "OB_BOUNCE";
});

console.log("=== SAMPLE OB_BOUNCE TRADE METADATA ===\n");
if (obBounce.length > 0) {
  const meta = obBounce[0].signal.metadata;
  console.log("signalType:", meta.signalType);
  console.log("trigger:", meta.trigger);
  console.log("htfBias:", meta.htfBias);
  console.log("confidence:", meta.confidence);
  console.log("orderBlock:", JSON.stringify(meta.orderBlock));
  console.log("mssType:", meta.mssType);
  console.log("chochType:", meta.chochType);
}

// Check how many trades have orderBlock metadata at all
const withOB = trades.filter(t => t.signal?.metadata?.orderBlock);
console.log("\nTrades with orderBlock metadata:", withOB.length);

// What triggers are used?
console.log("\n=== TRIGGERS ===\n");
const triggers = {};
trades.forEach(t => {
  const trigger = t.signal?.metadata?.trigger || "unknown";
  if (!triggers[trigger]) triggers[trigger] = [];
  triggers[trigger].push(t);
});

Object.entries(triggers)
  .sort((a,b) => b[1].length - a[1].length)
  .forEach(([trigger, trs]) => {
    const perf = calculatePerformance(trs);
    console.log(trigger + ": " + perf.tradeCount + " trades, " + perf.winRate + "% WR, $" + perf.totalPnL);
  });
