#!/usr/bin/env node
/**
 * Generate a TradingView Pine v6 indicator from prod signal-generator logs.
 *
 * Usage:
 *   node scripts/generate-pine-signals.js <log-csv> [options]
 *
 * Options:
 *   --strategy <name>   Strategy to filter (default: iv-skew-gex)
 *   --target <pts>      Target points (default: 70)
 *   --stop <pts>        Stop loss points (default: 70)
 *   --box-bars <n>      How many bars forward to extend boxes (default: 60)
 *   -o, --output <file> Write Pine script to file (default: stdout)
 *
 * Examples:
 *   node scripts/generate-pine-signals.js prod-logs/sig-gen.csv
 *   node scripts/generate-pine-signals.js prod-logs/sig-gen.csv --strategy short-dte-iv --target 40 --stop 30
 *   node scripts/generate-pine-signals.js prod-logs/sig-gen.csv -o signals.pine
 */

import { readFileSync, writeFileSync } from 'fs';

// ── CLI args ──
const args = process.argv.slice(2);
let logFile = null;
let strategy = 'iv-skew-gex';
let targetPts = 70;
let stopPts = 70;
let boxBars = 60;
let outputFile = null;

for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
        case '--strategy':  strategy = args[++i]; break;
        case '--target':    targetPts = parseInt(args[++i]); break;
        case '--stop':      stopPts = parseInt(args[++i]); break;
        case '--box-bars':  boxBars = parseInt(args[++i]); break;
        case '-o': case '--output': outputFile = args[++i]; break;
        case '--help': case '-h': printUsage(); process.exit(0);
        default:
            if (!args[i].startsWith('--')) logFile = args[i];
    }
}

if (!logFile) {
    printUsage();
    process.exit(1);
}

function printUsage() {
    console.error(`Usage: node scripts/generate-pine-signals.js <log-csv> [options]
Options:
  --strategy <name>   Strategy filter (default: iv-skew-gex)
  --target <pts>      Target points (default: 70)
  --stop <pts>        Stop loss points (default: 70)
  --box-bars <n>      Box length in bars (default: 60)
  -o, --output <file> Output file (default: stdout)`);
}

// ── Parse log ──
const csv = readFileSync(logFile, 'utf-8');
const lines = csv.split('\n');

const signalPattern = new RegExp(
    `Signal from ${strategy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} for (\\w+): (\\w+) (\\w+) @ ([\\d.]+)`
);

const signals = [];
const seen = new Set();

for (const line of lines) {
    const match = line.match(signalPattern);
    if (!match) continue;

    const [, product, action, side, priceStr] = match;

    // Extract timestamp — first occurrence of YYYY-MM-DD HH:MM:SS in the line
    const tsMatch = line.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
    if (!tsMatch) continue;

    const utcTs = tsMatch[1];
    const epochMs = new Date(utcTs.replace(' ', 'T') + 'Z').getTime();
    const price = parseFloat(priceStr);

    // Deduplicate (same timestamp + price = same signal logged twice)
    const key = `${epochMs}-${price}`;
    if (seen.has(key)) continue;
    seen.add(key);

    signals.push({
        utcTs,
        epochMs,
        product,
        action,
        side: side === 'short' ? -1 : 1,
        sideLabel: side.toUpperCase(),
        price,
    });
}

if (signals.length === 0) {
    console.error(`No signals found for strategy "${strategy}" in ${logFile}`);
    process.exit(1);
}

// Date range for title
const firstDate = signals[0].utcTs.split(' ')[0];
const lastDate = signals[signals.length - 1].utcTs.split(' ')[0];
console.error(`Found ${signals.length} ${strategy} signals (${firstDate} → ${lastDate})`);

// ── Generate Pine v6 ──
const pine = generatePine(signals, strategy, targetPts, stopPts, boxBars, firstDate, lastDate);

if (outputFile) {
    writeFileSync(outputFile, pine);
    console.error(`Written to ${outputFile}`);
} else {
    console.log(pine);
}

function generatePine(signals, strategy, targetPts, stopPts, boxBars, startDate, endDate) {
    const title = `${strategy.toUpperCase()} Signals (${startDate} to ${endDate})`;

    // Build array.push() lines for each signal
    const pushLines = signals.map(s => {
        // Convert UTC to ET for the comment
        const dt = new Date(s.epochMs);
        const etStr = dt.toLocaleString('en-US', {
            timeZone: 'America/New_York',
            month: '2-digit', day: '2-digit',
            hour: 'numeric', minute: '2-digit',
            hour12: true
        });
        return [
            `    // ${etStr} ET — ${s.sideLabel} @ ${s.price}`,
            `    sTimes.push(${s.epochMs})`,
            `    sPrices.push(${s.price})`,
            `    sSides.push(${s.side})`,
        ].join('\n');
    }).join('\n\n');

    return `//@version=6
indicator("${title}", overlay=true, max_boxes_count=500, max_labels_count=500, max_lines_count=500)

// ─── Inputs ───
i_targetPts  = input.int(${targetPts}, "Target Points")
i_stopPts    = input.int(${stopPts}, "Stop Points")
i_boxBars    = input.int(${boxBars}, "Box Length (bars)")
i_showLabels = input.bool(true, "Show Labels")
i_showEntry  = input.bool(true, "Show Entry Line")

// ─── Signal Data (generated from prod logs) ───
var sTimes  = array.new<int>()
var sPrices = array.new<float>()
var sSides  = array.new<int>()   // 1 = long, -1 = short

if barstate.isfirst
${pushLines}

// ─── Plot Signals ───
for i = 0 to sTimes.size() - 1
    sigTime = sTimes.get(i)
    if time <= sigTime and sigTime < time_close
        entryPrice = sPrices.get(i)
        side       = sSides.get(i)

        tp = side == 1 ? entryPrice + i_targetPts : entryPrice - i_targetPts
        sl = side == 1 ? entryPrice - i_stopPts   : entryPrice + i_stopPts

        // Target zone (green)
        box.new(bar_index, math.max(entryPrice, tp), bar_index + i_boxBars, math.min(entryPrice, tp),
             bgcolor=color.new(color.green, 85), border_color=color.new(color.green, 50))

        // Stop zone (red)
        box.new(bar_index, math.max(entryPrice, sl), bar_index + i_boxBars, math.min(entryPrice, sl),
             bgcolor=color.new(color.red, 85), border_color=color.new(color.red, 50))

        // Entry line
        if i_showEntry
            line.new(bar_index, entryPrice, bar_index + i_boxBars, entryPrice,
                 color=color.new(color.white, 30), style=line.style_dashed, width=1)

        // Label
        if i_showLabels
            lbl = (side == -1 ? "S" : "L") + " @ " + str.tostring(entryPrice, "#.##")
            label.new(bar_index, entryPrice, lbl,
                 style=side == -1 ? label.style_label_down : label.style_label_up,
                 color=side == -1 ? color.red : color.green,
                 textcolor=color.white, size=size.small)
`;
}
