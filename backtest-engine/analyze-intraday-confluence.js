#!/usr/bin/env node
/**
 * Intraday Confluence Analysis
 *
 * Analyzes 15-minute aligned data for intraday trading signals
 * Focuses on:
 * 1. Time-of-day patterns
 * 2. Level interactions (price vs GEX levels)
 * 3. IV spikes and mean reversion
 * 4. Liquidity sentiment shifts
 */

import fs from 'fs';
import path from 'path';

const DATA_DIR = './data';

// Load 15-minute IV data
function loadIVData() {
  const ivPath = path.join(DATA_DIR, 'iv/qqq_atm_iv_15m.csv');
  const content = fs.readFileSync(ivPath, 'utf8');
  const lines = content.split('\n');
  const data = new Map();

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 7) continue;

    const timestamp = new Date(cols[0]).getTime();
    data.set(timestamp, {
      iv: parseFloat(cols[1]),
      spotPrice: parseFloat(cols[2]),
      callIV: parseFloat(cols[4]),
      putIV: parseFloat(cols[5]),
      dte: parseInt(cols[6])
    });
  }

  return data;
}

// Load 15-minute liquidity data
function loadLiquidityData() {
  const liqPath = path.join(DATA_DIR, 'liquidity/NQ_liquidity_levels.csv');
  const content = fs.readFileSync(liqPath, 'utf8');
  const lines = content.split('\n');
  const data = new Map();

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 8) continue;

    const timestamp = parseInt(cols[1]);
    data.set(timestamp, {
      sentiment: cols[2],
      levels: [
        parseFloat(cols[3]),
        parseFloat(cols[4]),
        parseFloat(cols[5]),
        parseFloat(cols[6]),
        parseFloat(cols[7])
      ]
    });
  }

  return data;
}

// Load GEX JSON files for 15-minute data
function loadGEXIntraday() {
  const gexDir = path.join(DATA_DIR, 'gex');
  const files = fs.readdirSync(gexDir).filter(f => f.endsWith('.json'));
  const data = new Map();

  for (const file of files) {
    try {
      const json = JSON.parse(fs.readFileSync(path.join(gexDir, file), 'utf8'));
      if (!json.data) continue;

      for (const snapshot of json.data) {
        const timestamp = new Date(snapshot.timestamp).getTime();
        data.set(timestamp, {
          spot: snapshot.nq_spot,
          gammaFlip: snapshot.gamma_flip,
          callWall: snapshot.call_wall,
          putWall: snapshot.put_wall,
          totalGex: snapshot.total_gex,
          regime: snapshot.regime,
          resistance: snapshot.resistance || [],
          support: snapshot.support || []
        });
      }
    } catch (e) {
      // Skip invalid files
    }
  }

  return data;
}

// Load OHLCV 15-minute data
function loadOHLCV() {
  const ohlcvPath = path.join(DATA_DIR, 'ohlcv/NQ_ohlcv_1m.csv');
  const content = fs.readFileSync(ohlcvPath, 'utf8');
  const lines = content.split('\n');
  const data = new Map();

  let currentCandle = null;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 10) continue;

    const symbol = cols[9];
    if (symbol.includes('-')) continue;

    const timestamp = new Date(cols[0]).getTime();
    const interval15m = Math.floor(timestamp / (15 * 60 * 1000)) * (15 * 60 * 1000);

    const open = parseFloat(cols[4]);
    const high = parseFloat(cols[5]);
    const low = parseFloat(cols[6]);
    const close = parseFloat(cols[7]);
    const volume = parseInt(cols[8]);

    if (isNaN(close)) continue;

    if (!currentCandle || currentCandle.timestamp !== interval15m) {
      if (currentCandle) {
        data.set(currentCandle.timestamp, currentCandle);
      }
      currentCandle = {
        timestamp: interval15m,
        open,
        high,
        low,
        close,
        volume,
        symbol
      };
    } else {
      currentCandle.high = Math.max(currentCandle.high, high);
      currentCandle.low = Math.min(currentCandle.low, low);
      currentCandle.close = close;
      currentCandle.volume += volume;
    }
  }

  if (currentCandle) data.set(currentCandle.timestamp, currentCandle);
  return data;
}

// Main analysis
function analyzeIntradayConfluence() {
  console.log('Loading 15-minute data...\n');

  const ivData = loadIVData();
  const liquidityData = loadLiquidityData();
  const gexData = loadGEXIntraday();
  const ohlcvData = loadOHLCV();

  console.log(`IV readings: ${ivData.size}`);
  console.log(`Liquidity readings: ${liquidityData.size}`);
  console.log(`GEX snapshots: ${gexData.size}`);
  console.log(`OHLCV candles: ${ohlcvData.size}`);

  // Find aligned timestamps (where we have all 4 data sources)
  const alignedData = [];

  for (const [ts, ohlcv] of ohlcvData) {
    const iv = ivData.get(ts);
    const liq = liquidityData.get(ts);
    const gex = gexData.get(ts);

    if (iv && liq && gex) {
      alignedData.push({
        timestamp: ts,
        date: new Date(ts).toISOString(),
        hour: new Date(ts).getUTCHours(),
        ohlcv,
        iv,
        liquidity: liq,
        gex
      });
    }
  }

  console.log(`\nAligned data points: ${alignedData.length}`);

  // Sort by timestamp
  alignedData.sort((a, b) => a.timestamp - b.timestamp);

  // Calculate forward returns for each candle
  for (let i = 0; i < alignedData.length - 4; i++) {
    const current = alignedData[i];
    const next1 = alignedData[i + 1];
    const next4 = alignedData[i + 4]; // 1 hour forward

    current.return15m = ((next1.ohlcv.close - current.ohlcv.close) / current.ohlcv.close) * 100;
    current.return1h = ((next4.ohlcv.close - current.ohlcv.close) / current.ohlcv.close) * 100;
  }

  // Filter to only data with forward returns
  const analysisData = alignedData.filter(d => d.return15m !== undefined);

  console.log(`\n========================================`);
  console.log(`TIME-OF-DAY ANALYSIS`);
  console.log(`========================================\n`);

  const hourlyStats = {};
  for (const d of analysisData) {
    const hour = d.hour;
    if (!hourlyStats[hour]) {
      hourlyStats[hour] = { returns15m: [], returns1h: [], count: 0 };
    }
    hourlyStats[hour].returns15m.push(d.return15m);
    hourlyStats[hour].returns1h.push(d.return1h);
    hourlyStats[hour].count++;
  }

  console.log('Hour (UTC) | 15m Avg | 15m Win% | 1h Avg | 1h Win% | Count');
  console.log('-'.repeat(65));

  for (const hour of Object.keys(hourlyStats).sort((a, b) => a - b)) {
    const stats = hourlyStats[hour];
    const avg15m = stats.returns15m.reduce((a, b) => a + b, 0) / stats.returns15m.length;
    const win15m = stats.returns15m.filter(r => r > 0).length / stats.returns15m.length;
    const avg1h = stats.returns1h.reduce((a, b) => a + b, 0) / stats.returns1h.length;
    const win1h = stats.returns1h.filter(r => r > 0).length / stats.returns1h.length;

    console.log(
      `${hour.toString().padStart(2, '0')}:00     | ${avg15m.toFixed(3).padStart(7)} | ${(win15m * 100).toFixed(1).padStart(7)}% | ${avg1h.toFixed(3).padStart(6)} | ${(win1h * 100).toFixed(1).padStart(6)}% | ${stats.count}`
    );
  }

  console.log(`\n========================================`);
  console.log(`IV SPIKE / CRUSH ANALYSIS`);
  console.log(`========================================\n`);

  // Calculate IV change from previous candle
  for (let i = 1; i < analysisData.length; i++) {
    analysisData[i].ivChange = analysisData[i].iv.iv - analysisData[i - 1].iv.iv;
  }

  const ivSpikeBuckets = {
    bigSpike: { label: 'IV Spike (>0.02)', returns: [] },
    smallSpike: { label: 'IV Rise (0.005-0.02)', returns: [] },
    stable: { label: 'IV Stable', returns: [] },
    smallCrush: { label: 'IV Drop (-0.02 to -0.005)', returns: [] },
    bigCrush: { label: 'IV Crush (<-0.02)', returns: [] }
  };

  for (const d of analysisData) {
    if (d.ivChange === undefined) continue;

    let bucket;
    if (d.ivChange > 0.02) bucket = ivSpikeBuckets.bigSpike;
    else if (d.ivChange > 0.005) bucket = ivSpikeBuckets.smallSpike;
    else if (d.ivChange > -0.005) bucket = ivSpikeBuckets.stable;
    else if (d.ivChange > -0.02) bucket = ivSpikeBuckets.smallCrush;
    else bucket = ivSpikeBuckets.bigCrush;

    bucket.returns.push({ r15m: d.return15m, r1h: d.return1h });
  }

  console.log('IV Change Pattern    | 15m Avg | 15m Win% | 1h Avg | 1h Win% | Count');
  console.log('-'.repeat(75));

  for (const [key, bucket] of Object.entries(ivSpikeBuckets)) {
    if (bucket.returns.length === 0) continue;

    const avg15m = bucket.returns.reduce((a, b) => a + b.r15m, 0) / bucket.returns.length;
    const win15m = bucket.returns.filter(r => r.r15m > 0).length / bucket.returns.length;
    const avg1h = bucket.returns.reduce((a, b) => a + b.r1h, 0) / bucket.returns.length;
    const win1h = bucket.returns.filter(r => r.r1h > 0).length / bucket.returns.length;

    console.log(
      `${bucket.label.padEnd(20)} | ${avg15m.toFixed(3).padStart(7)} | ${(win15m * 100).toFixed(1).padStart(7)}% | ${avg1h.toFixed(3).padStart(6)} | ${(win1h * 100).toFixed(1).padStart(6)}% | ${bucket.returns.length}`
    );
  }

  console.log(`\n========================================`);
  console.log(`LEVEL INTERACTION ANALYSIS`);
  console.log(`========================================\n`);

  // Analyze price interaction with GEX levels
  const levelInteractions = {
    aboveGammaFlip: { label: 'Above Gamma Flip', returns: [] },
    belowGammaFlip: { label: 'Below Gamma Flip', returns: [] },
    nearCallWall: { label: 'Near Call Wall (<0.3%)', returns: [] },
    nearPutWall: { label: 'Near Put Wall (<0.3%)', returns: [] },
    betweenWalls: { label: 'Between Walls', returns: [] }
  };

  for (const d of analysisData) {
    const price = d.ohlcv.close;
    const gammaFlip = d.gex.gammaFlip;
    const callWall = d.gex.callWall;
    const putWall = d.gex.putWall;

    if (!gammaFlip || !callWall || !putWall) continue;

    // Position relative to gamma flip
    if (price > gammaFlip) {
      levelInteractions.aboveGammaFlip.returns.push({ r15m: d.return15m, r1h: d.return1h });
    } else {
      levelInteractions.belowGammaFlip.returns.push({ r15m: d.return15m, r1h: d.return1h });
    }

    // Wall proximity
    const callDist = Math.abs(callWall - price) / price;
    const putDist = Math.abs(price - putWall) / price;

    if (callDist < 0.003) {
      levelInteractions.nearCallWall.returns.push({ r15m: d.return15m, r1h: d.return1h });
    } else if (putDist < 0.003) {
      levelInteractions.nearPutWall.returns.push({ r15m: d.return15m, r1h: d.return1h });
    } else {
      levelInteractions.betweenWalls.returns.push({ r15m: d.return15m, r1h: d.return1h });
    }
  }

  console.log('Level Position       | 15m Avg | 15m Win% | 1h Avg | 1h Win% | Count');
  console.log('-'.repeat(75));

  for (const [key, bucket] of Object.entries(levelInteractions)) {
    if (bucket.returns.length === 0) continue;

    const avg15m = bucket.returns.reduce((a, b) => a + b.r15m, 0) / bucket.returns.length;
    const win15m = bucket.returns.filter(r => r.r15m > 0).length / bucket.returns.length;
    const avg1h = bucket.returns.reduce((a, b) => a + b.r1h, 0) / bucket.returns.length;
    const win1h = bucket.returns.filter(r => r.r1h > 0).length / bucket.returns.length;

    console.log(
      `${bucket.label.padEnd(20)} | ${avg15m.toFixed(3).padStart(7)} | ${(win15m * 100).toFixed(1).padStart(7)}% | ${avg1h.toFixed(3).padStart(6)} | ${(win1h * 100).toFixed(1).padStart(6)}% | ${bucket.returns.length}`
    );
  }

  console.log(`\n========================================`);
  console.log(`SENTIMENT SHIFT ANALYSIS`);
  console.log(`========================================\n`);

  // Track sentiment shifts
  for (let i = 1; i < analysisData.length; i++) {
    const prev = analysisData[i - 1];
    const curr = analysisData[i];
    curr.sentimentShift = prev.liquidity.sentiment !== curr.liquidity.sentiment;
    curr.shiftToBullish = curr.sentimentShift && curr.liquidity.sentiment === 'BULLISH';
    curr.shiftToBearish = curr.sentimentShift && curr.liquidity.sentiment === 'BEARISH';
  }

  const sentimentShifts = {
    shiftToBullish: { label: 'Shift to BULLISH', returns: [] },
    shiftToBearish: { label: 'Shift to BEARISH', returns: [] },
    stayBullish: { label: 'Stay BULLISH', returns: [] },
    stayBearish: { label: 'Stay BEARISH', returns: [] }
  };

  for (const d of analysisData) {
    if (d.shiftToBullish) {
      sentimentShifts.shiftToBullish.returns.push({ r15m: d.return15m, r1h: d.return1h });
    } else if (d.shiftToBearish) {
      sentimentShifts.shiftToBearish.returns.push({ r15m: d.return15m, r1h: d.return1h });
    } else if (d.liquidity.sentiment === 'BULLISH') {
      sentimentShifts.stayBullish.returns.push({ r15m: d.return15m, r1h: d.return1h });
    } else {
      sentimentShifts.stayBearish.returns.push({ r15m: d.return15m, r1h: d.return1h });
    }
  }

  console.log('Sentiment Pattern    | 15m Avg | 15m Win% | 1h Avg | 1h Win% | Count');
  console.log('-'.repeat(75));

  for (const [key, bucket] of Object.entries(sentimentShifts)) {
    if (bucket.returns.length === 0) continue;

    const avg15m = bucket.returns.reduce((a, b) => a + b.r15m, 0) / bucket.returns.length;
    const win15m = bucket.returns.filter(r => r.r15m > 0).length / bucket.returns.length;
    const avg1h = bucket.returns.reduce((a, b) => a + b.r1h, 0) / bucket.returns.length;
    const win1h = bucket.returns.filter(r => r.r1h > 0).length / bucket.returns.length;

    console.log(
      `${bucket.label.padEnd(20)} | ${avg15m.toFixed(3).padStart(7)} | ${(win15m * 100).toFixed(1).padStart(7)}% | ${avg1h.toFixed(3).padStart(6)} | ${(win1h * 100).toFixed(1).padStart(6)}% | ${bucket.returns.length}`
    );
  }

  console.log(`\n========================================`);
  console.log(`INTRADAY CONFLUENCE SIGNALS`);
  console.log(`========================================\n`);

  // Build confluence signals for each bar
  const confluenceResults = {
    strongBullish: { label: 'Strong Bullish Confluence (3+)', returns: [] },
    moderateBullish: { label: 'Moderate Bullish (1-2)', returns: [] },
    neutral: { label: 'Neutral', returns: [] },
    moderateBearish: { label: 'Moderate Bearish (-1 to -2)', returns: [] },
    strongBearish: { label: 'Strong Bearish (-3 or more)', returns: [] }
  };

  for (const d of analysisData) {
    let bullishScore = 0;
    let bearishScore = 0;

    // IV signals
    if (d.iv.iv < 0.18) bullishScore++;
    if (d.iv.iv > 0.30) bearishScore++;
    if (d.ivChange && d.ivChange < -0.01) bullishScore++;
    if (d.ivChange && d.ivChange > 0.01) bearishScore++;

    // GEX signals
    if (d.gex.regime === 'strong_positive' || d.gex.regime === 'positive') bullishScore++;
    if (d.gex.regime === 'negative' || d.gex.regime === 'strong_negative') bearishScore++;
    if (d.gex.gammaFlip && d.ohlcv.close > d.gex.gammaFlip) bullishScore++;
    if (d.gex.gammaFlip && d.ohlcv.close < d.gex.gammaFlip) bearishScore++;

    // Liquidity signals
    if (d.liquidity.sentiment === 'BULLISH') bullishScore++;
    if (d.liquidity.sentiment === 'BEARISH') bearishScore++;
    if (d.shiftToBullish) bullishScore++;
    if (d.shiftToBearish) bearishScore++;

    const netScore = bullishScore - bearishScore;

    let bucket;
    if (netScore >= 3) bucket = confluenceResults.strongBullish;
    else if (netScore >= 1) bucket = confluenceResults.moderateBullish;
    else if (netScore === 0) bucket = confluenceResults.neutral;
    else if (netScore >= -2) bucket = confluenceResults.moderateBearish;
    else bucket = confluenceResults.strongBearish;

    bucket.returns.push({ r15m: d.return15m, r1h: d.return1h, netScore, date: d.date });
  }

  console.log('Confluence Level     | 15m Avg | 15m Win% | 1h Avg | 1h Win% | Count');
  console.log('-'.repeat(75));

  for (const [key, bucket] of Object.entries(confluenceResults)) {
    if (bucket.returns.length === 0) continue;

    const avg15m = bucket.returns.reduce((a, b) => a + b.r15m, 0) / bucket.returns.length;
    const win15m = bucket.returns.filter(r => r.r15m > 0).length / bucket.returns.length;
    const avg1h = bucket.returns.reduce((a, b) => a + b.r1h, 0) / bucket.returns.length;
    const win1h = bucket.returns.filter(r => r.r1h > 0).length / bucket.returns.length;

    console.log(
      `${bucket.label.padEnd(20)} | ${avg15m.toFixed(3).padStart(7)} | ${(win15m * 100).toFixed(1).padStart(7)}% | ${avg1h.toFixed(3).padStart(6)} | ${(win1h * 100).toFixed(1).padStart(6)}% | ${bucket.returns.length}`
    );
  }

  // Best and worst performing specific conditions
  console.log(`\n========================================`);
  console.log(`HIGH-PROBABILITY INTRADAY SETUPS`);
  console.log(`========================================\n`);

  // Find the best combinations
  const specificSetups = [];

  for (const d of analysisData) {
    if (!d.gex.gammaFlip || !d.ivChange) continue;

    const setup = {
      timestamp: d.timestamp,
      date: d.date,
      return15m: d.return15m,
      return1h: d.return1h,
      // Conditions
      lowIV: d.iv.iv < 0.18,
      highIV: d.iv.iv > 0.28,
      ivCrushing: d.ivChange < -0.01,
      ivRising: d.ivChange > 0.01,
      positiveGEX: d.gex.regime === 'positive' || d.gex.regime === 'strong_positive',
      negativeGEX: d.gex.regime === 'negative',
      aboveGammaFlip: d.ohlcv.close > d.gex.gammaFlip,
      belowGammaFlip: d.ohlcv.close < d.gex.gammaFlip,
      bullishSentiment: d.liquidity.sentiment === 'BULLISH',
      bearishSentiment: d.liquidity.sentiment === 'BEARISH',
      shiftToBullish: d.shiftToBullish || false,
      shiftToBearish: d.shiftToBearish || false
    };

    specificSetups.push(setup);
  }

  // Test specific high-probability setups
  const setups = [
    {
      name: 'LONG: Low IV + Positive GEX + Above Flip + Bullish',
      filter: s => s.lowIV && s.positiveGEX && s.aboveGammaFlip && s.bullishSentiment
    },
    {
      name: 'LONG: IV Crush + Positive GEX + Above Flip',
      filter: s => s.ivCrushing && s.positiveGEX && s.aboveGammaFlip
    },
    {
      name: 'LONG: Shift to Bullish + Positive GEX',
      filter: s => s.shiftToBullish && s.positiveGEX
    },
    {
      name: 'LONG: Low IV + Above Flip + Bullish',
      filter: s => s.lowIV && s.aboveGammaFlip && s.bullishSentiment
    },
    {
      name: 'SHORT: High IV + Negative GEX + Below Flip + Bearish',
      filter: s => s.highIV && s.negativeGEX && s.belowGammaFlip && s.bearishSentiment
    },
    {
      name: 'SHORT: IV Rising + Negative GEX + Below Flip',
      filter: s => s.ivRising && s.negativeGEX && s.belowGammaFlip
    },
    {
      name: 'SHORT: Shift to Bearish + Negative GEX',
      filter: s => s.shiftToBearish && s.negativeGEX
    },
    {
      name: 'SHORT: High IV + Below Flip + Bearish',
      filter: s => s.highIV && s.belowGammaFlip && s.bearishSentiment
    },
    {
      name: 'FADE: Above Flip but Bearish Sentiment',
      filter: s => s.aboveGammaFlip && s.bearishSentiment && s.positiveGEX
    },
    {
      name: 'FADE: Below Flip but Bullish Sentiment',
      filter: s => s.belowGammaFlip && s.bullishSentiment && s.positiveGEX
    }
  ];

  console.log('Setup Name                                        | 15m Win | 1h Win | Avg 1h  | Count');
  console.log('-'.repeat(95));

  for (const setup of setups) {
    const matching = specificSetups.filter(setup.filter);
    if (matching.length < 10) continue;

    const win15m = matching.filter(m => m.return15m > 0).length / matching.length;
    const win1h = matching.filter(m => m.return1h > 0).length / matching.length;
    const avg1h = matching.reduce((a, b) => a + b.return1h, 0) / matching.length;

    console.log(
      `${setup.name.padEnd(49)} | ${(win15m * 100).toFixed(1).padStart(6)}% | ${(win1h * 100).toFixed(1).padStart(5)}% | ${avg1h.toFixed(3).padStart(7)}% | ${matching.length}`
    );
  }

  console.log(`\n========================================`);
  console.log(`ACTIONABLE INTRADAY STRATEGY RULES`);
  console.log(`========================================\n`);

  console.log(`LONG ENTRY CONDITIONS:`);
  console.log(`-`.repeat(50));
  console.log(`1. IV < 18% AND positive GEX regime`);
  console.log(`2. Price above gamma flip`);
  console.log(`3. Liquidity sentiment = BULLISH or just shifted to BULLISH`);
  console.log(`4. Avoid entries in first 30 min and last 30 min of session`);
  console.log(``);
  console.log(`LONG EXIT CONDITIONS:`);
  console.log(`-`.repeat(50));
  console.log(`1. Price reaches call wall resistance`);
  console.log(`2. Sentiment shifts to BEARISH`);
  console.log(`3. IV spikes >2% from entry`);
  console.log(`4. Price crosses below gamma flip`);
  console.log(``);
  console.log(`SHORT ENTRY CONDITIONS:`);
  console.log(`-`.repeat(50));
  console.log(`1. IV > 25% or rising rapidly`);
  console.log(`2. Negative GEX regime`);
  console.log(`3. Price below gamma flip`);
  console.log(`4. Liquidity sentiment = BEARISH`);
  console.log(``);
  console.log(`SHORT EXIT CONDITIONS:`);
  console.log(`-`.repeat(50));
  console.log(`1. Price reaches put wall support`);
  console.log(`2. Sentiment shifts to BULLISH`);
  console.log(`3. IV crushing (drops >2% from entry)`);
  console.log(`4. Price crosses above gamma flip`);
}

analyzeIntradayConfluence();
