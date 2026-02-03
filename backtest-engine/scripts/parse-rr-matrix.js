const fs = await import('fs');
const path = await import('path');

const resultsDir = 'results/rr-matrix';
const stops = [10, 15, 20, 25, 30, 40, 50];
const targets = [20, 30, 40, 50, 60, 80, 100];

const results = [];

for (const stop of stops) {
  for (const target of targets) {
    const file = path.join(resultsDir, `stop${stop}_target${target}.txt`);
    if (!fs.existsSync(file)) continue;

    // Strip ANSI escape codes
    const raw = fs.readFileSync(file, 'utf-8');
    const output = raw.replace(/\x1b\[\d+m/g, '');

    const m = (pattern) => {
      const match = output.match(pattern);
      return match ? match[1] : null;
    };

    results.push({
      stop,
      target,
      rr: (target / stop).toFixed(2),
      trades: parseInt(m(/Total Trades\s+│\s+(\d+)/)) || 0,
      winRate: parseFloat(m(/Win Rate\s+│\s+([\d.]+)%/)) || 0,
      pf: parseFloat(m(/Profit Factor\s+│\s+([\d.]+)/)) || 0,
      pnl: parseInt((m(/Total P&L\s+│\s+\$(-?[\d,]+)/) || '').replace(/,/g, '')) || 0,
      expectancy: parseFloat(m(/Expectancy\s+│\s+\$(-?[\d.]+)/)) || 0,
      winTrades: parseInt(m(/Winning Trades\s+│\s+(\d+)/)) || 0,
      lossTrades: parseInt(m(/Losing Trades\s+│\s+(\d+)/)) || 0,
      avgWin: parseFloat((m(/Average Win\s+│\s+\$([\d.,]+)/) || '').replace(/,/g, '')) || 0,
      avgLoss: parseFloat((m(/Average Loss\s+│\s+\$([\d.,]+)/) || '').replace(/,/g, '')) || 0,
      maxDD: parseFloat(m(/Max Drawdown\s+│\s+([\d.]+)%/)) || 0,
    });
  }
}

const pad = (s, n) => s.toString().padStart(n);
const sep = '─'.repeat(95);

// WIN RATE MATRIX
console.log('\n' + '═'.repeat(95));
console.log('📊 ASYMMETRIC R/R PROBABILITY MATRIX — CBBO-LT VOLATILITY (Jan 13-31 2025, 5m)');
console.log('═'.repeat(95));

console.log('\n📈 WIN RATE MATRIX (%)');
console.log(sep);
const header = '   Stop │ ' + targets.map(t => ('T=' + t).padStart(8)).join(' │ ');
console.log(header);
console.log(sep);

for (const stop of stops) {
  const vals = targets.map(target => {
    const r = results.find(x => x.stop === stop && x.target === target);
    if (!r) return '       ';
    const v = r.winRate.toFixed(1);
    if (r.winRate >= 50) return ' \x1b[32m' + pad(v, 5) + '%\x1b[0m';
    if (r.winRate >= 40) return ' \x1b[33m' + pad(v, 5) + '%\x1b[0m';
    return ' \x1b[31m' + pad(v, 5) + '%\x1b[0m';
  });
  console.log('S=' + pad(stop, 2) + ' │ ' + vals.join(' │ '));
}

// PNL MATRIX
console.log('\n💰 TOTAL P&L MATRIX ($)');
console.log(sep);
console.log(header);
console.log(sep);

for (const stop of stops) {
  const vals = targets.map(target => {
    const r = results.find(x => x.stop === stop && x.target === target);
    if (!r) return '       ';
    const v = (r.pnl >= 0 ? '+' : '') + (r.pnl / 1000).toFixed(1) + 'K';
    if (r.pnl >= 0) return ' \x1b[32m' + pad(v, 6) + '\x1b[0m';
    return ' \x1b[31m' + pad(v, 6) + '\x1b[0m';
  });
  console.log('S=' + pad(stop, 2) + ' │ ' + vals.join(' │ '));
}

// EXPECTANCY MATRIX
console.log('\n💵 EXPECTANCY ($/trade)');
console.log(sep);
console.log(header);
console.log(sep);

for (const stop of stops) {
  const vals = targets.map(target => {
    const r = results.find(x => x.stop === stop && x.target === target);
    if (!r) return '       ';
    const v = (r.expectancy >= 0 ? '+' : '') + '$' + r.expectancy.toFixed(0);
    if (r.expectancy >= 0) return ' \x1b[32m' + pad(v, 6) + '\x1b[0m';
    return ' \x1b[31m' + pad(v, 6) + '\x1b[0m';
  });
  console.log('S=' + pad(stop, 2) + ' │ ' + vals.join(' │ '));
}

// PROFIT FACTOR MATRIX
console.log('\n📊 PROFIT FACTOR MATRIX');
console.log(sep);
console.log(header);
console.log(sep);

for (const stop of stops) {
  const vals = targets.map(target => {
    const r = results.find(x => x.stop === stop && x.target === target);
    if (!r) return '       ';
    const v = r.pf.toFixed(2);
    if (r.pf >= 2.0) return ' \x1b[32m' + pad(v, 6) + '\x1b[0m';
    if (r.pf >= 1.5) return ' \x1b[33m' + pad(v, 6) + '\x1b[0m';
    return ' \x1b[31m' + pad(v, 6) + '\x1b[0m';
  });
  console.log('S=' + pad(stop, 2) + ' │ ' + vals.join(' │ '));
}

// R/R REFERENCE
console.log('\n🔢 R/R RATIO REFERENCE');
console.log(sep);
console.log(header);
console.log(sep);

for (const stop of stops) {
  const vals = targets.map(target => {
    return pad((target / stop).toFixed(2), 8);
  });
  console.log('S=' + pad(stop, 2) + ' │ ' + vals.join(' │ '));
}

// TOP PERFORMERS
console.log('\n🏆 TOP 10 CONFIGURATIONS BY TOTAL P&L');
console.log(sep);
console.log('Rnk │ Stop │ Tgt │  R/R │ Trades │  Win%  │    P&L     │  PF  │ Exp/Trade');
console.log(sep);

const sorted = [...results].sort((a, b) => b.pnl - a.pnl);
sorted.slice(0, 10).forEach((r, i) => {
  const c = r.pnl >= 0 ? '\x1b[32m' : '\x1b[31m';
  const pnl = (r.pnl >= 0 ? '+' : '') + '$' + r.pnl.toLocaleString();
  const exp = (r.expectancy >= 0 ? '+' : '') + '$' + r.expectancy.toFixed(0);
  console.log(
    ' ' + pad(i + 1, 2) + ' │ ' +
    pad(r.stop, 3) + 'pt │ ' +
    pad(r.target, 3) + 't │ ' +
    pad(r.rr, 5) + ' │ ' +
    pad(r.trades, 6) + ' │ ' +
    pad(r.winRate.toFixed(1), 6) + '% │ ' +
    c + pad(pnl, 10) + '\x1b[0m │ ' +
    pad(r.pf.toFixed(2), 4) + ' │ ' +
    c + pad(exp, 7) + '\x1b[0m'
  );
});

console.log('\n📉 BOTTOM 10 CONFIGURATIONS');
console.log(sep);
console.log('Rnk │ Stop │ Tgt │  R/R │ Trades │  Win%  │    P&L     │  PF  │ Exp/Trade');
console.log(sep);

sorted.slice(-10).reverse().forEach((r, i) => {
  const c = '\x1b[31m';
  const pnl = (r.pnl >= 0 ? '+' : '') + '$' + r.pnl.toLocaleString();
  const exp = (r.expectancy >= 0 ? '+' : '') + '$' + r.expectancy.toFixed(0);
  console.log(
    ' ' + pad(sorted.length - i, 2) + ' │ ' +
    pad(r.stop, 3) + 'pt │ ' +
    pad(r.target, 3) + 't │ ' +
    pad(r.rr, 5) + ' │ ' +
    pad(r.trades, 6) + ' │ ' +
    pad(r.winRate.toFixed(1), 6) + '% │ ' +
    c + pad(pnl, 10) + '\x1b[0m │ ' +
    pad(r.pf.toFixed(2), 4) + ' │ ' +
    c + pad(exp, 7) + '\x1b[0m'
  );
});

// Summary
const profitable = results.filter(r => r.pnl > 0);
const breakeven = results.filter(r => Math.abs(r.pnl) < 500);

console.log('\n' + '═'.repeat(95));
console.log('📋 SUMMARY STATISTICS');
console.log('═'.repeat(95));
console.log('   Total configurations tested:  ' + results.length);
console.log('   Profitable configurations:    ' + profitable.length + ' (' + (profitable.length / results.length * 100).toFixed(1) + '%)');
console.log('   Near-breakeven (< $500):      ' + breakeven.length + ' (' + (breakeven.length / results.length * 100).toFixed(1) + '%)');
console.log('   Best config:  S=' + sorted[0].stop + ' T=' + sorted[0].target + ' → $' + sorted[0].pnl.toLocaleString() + ' (' + sorted[0].winRate.toFixed(1) + '% win rate, PF=' + sorted[0].pf.toFixed(2) + ')');
console.log('   Worst config: S=' + sorted[sorted.length - 1].stop + ' T=' + sorted[sorted.length - 1].target + ' → $' + sorted[sorted.length - 1].pnl.toLocaleString() + ' (' + sorted[sorted.length - 1].winRate.toFixed(1) + '% win rate)');

if (profitable.length > 0) {
  console.log('\n   ✅ Profitable configurations:');
  profitable.sort((a, b) => b.pnl - a.pnl).forEach(r => {
    console.log('      S=' + r.stop + ' T=' + r.target + ' (R/R=' + r.rr + '): $' + r.pnl.toLocaleString() + ' | ' + r.winRate.toFixed(1) + '% WR | PF=' + r.pf.toFixed(2) + ' | E=$' + r.expectancy.toFixed(0) + '/trade');
  });
} else {
  console.log('\n   ❌ No configuration achieved positive P&L across the test period.');
}

console.log('');
