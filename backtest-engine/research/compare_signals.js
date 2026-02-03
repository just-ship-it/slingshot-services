import { loadTrades } from "./utils/data-loader.js";
import { calculatePerformance, round } from "./utils/analysis-helpers.js";

const trades = await loadTrades();

const obBounce = trades.filter(t => t.signal?.metadata?.signalType === "OB_BOUNCE");
const wPattern = trades.filter(t => t.signal?.metadata?.signalType === "W_PATTERN");

console.log("=== COMPARING OB_BOUNCE vs W_PATTERN ===\n");

// Compare metadata fields
console.log("Sample OB_BOUNCE metadata:");
const ob1 = obBounce[0].signal.metadata;
console.log("  patternType:", ob1.patternType);
console.log("  patternStage:", ob1.patternStage);
console.log("  mssType:", ob1.mssType);
console.log("  chochType:", ob1.chochType);
console.log("  confidence:", ob1.confidence);
console.log("  riskReward:", ob1.riskReward);

console.log("\nSample W_PATTERN metadata:");
const wp1 = wPattern[0].signal.metadata;
console.log("  patternType:", wp1.patternType);
console.log("  patternStage:", wp1.patternStage);
console.log("  mssType:", wp1.mssType);
console.log("  chochType:", wp1.chochType);
console.log("  confidence:", wp1.confidence);
console.log("  riskReward:", wp1.riskReward);

// Check confidence distribution
console.log("\n=== CONFIDENCE LEVELS ===\n");

const obConfidence = {};
obBounce.forEach(t => {
  const conf = t.signal.metadata.confidence;
  if (!obConfidence[conf]) obConfidence[conf] = [];
  obConfidence[conf].push(t);
});

console.log("OB_BOUNCE by confidence:");
Object.entries(obConfidence).sort((a,b) => b[0] - a[0]).forEach(([conf, trs]) => {
  const perf = calculatePerformance(trs);
  console.log("  " + conf + ": " + perf.tradeCount + " trades, " + perf.winRate + "% WR");
});

const wpConfidence = {};
wPattern.forEach(t => {
  const conf = t.signal.metadata.confidence;
  if (!wpConfidence[conf]) wpConfidence[conf] = [];
  wpConfidence[conf].push(t);
});

console.log("\nW_PATTERN by confidence:");
Object.entries(wpConfidence).sort((a,b) => b[0] - a[0]).forEach(([conf, trs]) => {
  const perf = calculatePerformance(trs);
  console.log("  " + conf + ": " + perf.tradeCount + " trades, " + perf.winRate + "% WR");
});

// Check patternStage
console.log("\n=== PATTERN STAGE ===\n");

const wpStages = {};
wPattern.forEach(t => {
  const stage = t.signal.metadata.patternStage || "none";
  if (!wpStages[stage]) wpStages[stage] = [];
  wpStages[stage].push(t);
});

console.log("W_PATTERN by patternStage:");
Object.entries(wpStages).sort((a,b) => b[1].length - a[1].length).forEach(([stage, trs]) => {
  const perf = calculatePerformance(trs);
  console.log("  " + stage + ": " + perf.tradeCount + " trades, " + perf.winRate + "% WR, $" + perf.totalPnL);
});

// What if we filter W_PATTERN by MSS type?
console.log("\n=== W_PATTERN BY MSS TYPE ===\n");

const wpMss = {};
wPattern.forEach(t => {
  const mss = t.signal.metadata.mssType || "none";
  if (!wpMss[mss]) wpMss[mss] = [];
  wpMss[mss].push(t);
});

Object.entries(wpMss).sort((a,b) => b[1].length - a[1].length).forEach(([mss, trs]) => {
  const perf = calculatePerformance(trs);
  console.log(mss + ": " + perf.tradeCount + " trades, " + perf.winRate + "% WR, $" + perf.totalPnL);
});

// OB_BOUNCE by MSS type
console.log("\n=== OB_BOUNCE BY MSS TYPE ===\n");

const obMss = {};
obBounce.forEach(t => {
  const mss = t.signal.metadata.mssType || "none";
  if (!obMss[mss]) obMss[mss] = [];
  obMss[mss].push(t);
});

Object.entries(obMss).sort((a,b) => b[1].length - a[1].length).forEach(([mss, trs]) => {
  const perf = calculatePerformance(trs);
  console.log(mss + ": " + perf.tradeCount + " trades, " + perf.winRate + "% WR, $" + perf.totalPnL);
});
