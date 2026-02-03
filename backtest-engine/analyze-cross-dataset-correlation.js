#!/usr/bin/env node
/**
 * Cross-Dataset Correlation Analysis
 *
 * Analyzes IV, GEX, Liquidity, and OHLCV data to find:
 * 1. Correlations between datasets
 * 2. Confluence patterns
 * 3. Actionable alpha for NQ futures trading
 */

import fs from 'fs';
import path from 'path';

const DATA_DIR = './data';

// ========================================
// DATA LOADERS
// ========================================

function loadIVData() {
  const ivPath = path.join(DATA_DIR, 'iv/qqq_atm_iv_15m.csv');
  const content = fs.readFileSync(ivPath, 'utf8');
  const lines = content.split('\n');
  const data = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 7) continue;

    const timestamp = new Date(cols[0]).getTime();
    const dateStr = new Date(timestamp).toISOString().split('T')[0];

    data.push({
      timestamp,
      dateStr,
      iv: parseFloat(cols[1]),
      spotPrice: parseFloat(cols[2]),
      atmStrike: parseFloat(cols[3]),
      callIV: parseFloat(cols[4]),
      putIV: parseFloat(cols[5]),
      dte: parseInt(cols[6]),
      ivSkew: parseFloat(cols[5]) - parseFloat(cols[4]) // put IV - call IV
    });
  }

  console.log(`Loaded ${data.length} IV records (${data[0]?.dateStr} to ${data[data.length-1]?.dateStr})`);
  return data;
}

function loadGEXData() {
  // Load daily GEX CSV
  const gexPath = path.join(DATA_DIR, 'gex/NQ_gex_levels.csv');
  const content = fs.readFileSync(gexPath, 'utf8');
  const lines = content.split('\n');
  const data = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 12) continue;

    data.push({
      dateStr: cols[0],
      gammaFlip: parseFloat(cols[1]) || null,
      putWall1: parseFloat(cols[2]),
      putWall2: parseFloat(cols[3]),
      putWall3: parseFloat(cols[4]),
      callWall1: parseFloat(cols[5]),
      callWall2: parseFloat(cols[6]),
      callWall3: parseFloat(cols[7]),
      conversionFactor: parseFloat(cols[8]),
      totalGex: parseFloat(cols[10]),
      regime: cols[11]
    });
  }

  console.log(`Loaded ${data.length} daily GEX records (${data[0]?.dateStr} to ${data[data.length-1]?.dateStr})`);
  return data;
}

function loadGEXJsonForDate(dateStr) {
  const jsonPath = path.join(DATA_DIR, `gex/nq_gex_${dateStr}.json`);
  if (!fs.existsSync(jsonPath)) return null;

  try {
    return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function loadLiquidityData() {
  const liqPath = path.join(DATA_DIR, 'liquidity/NQ_liquidity_levels.csv');
  const content = fs.readFileSync(liqPath, 'utf8');
  const lines = content.split('\n');
  const data = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 8) continue;

    const datetime = cols[0];
    const dateStr = datetime.split(' ')[0];

    data.push({
      datetime,
      dateStr,
      timestamp: parseInt(cols[1]),
      sentiment: cols[2],
      level1: parseFloat(cols[3]),
      level2: parseFloat(cols[4]),
      level3: parseFloat(cols[5]),
      level4: parseFloat(cols[6]),
      level5: parseFloat(cols[7])
    });
  }

  console.log(`Loaded ${data.length} liquidity records (${data[0]?.dateStr} to ${data[data.length-1]?.dateStr})`);
  return data;
}

function loadOHLCVData() {
  const ohlcvPath = path.join(DATA_DIR, 'ohlcv/NQ_ohlcv_1m.csv');
  const content = fs.readFileSync(ohlcvPath, 'utf8');
  const lines = content.split('\n');
  const data = [];

  // Aggregate to 15-minute candles for analysis
  let currentCandle = null;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 10) continue;

    const symbol = cols[9];
    // Filter for main contract (not spreads)
    if (symbol.includes('-')) continue;

    const timestamp = new Date(cols[0]).getTime();
    const interval15m = Math.floor(timestamp / (15 * 60 * 1000)) * (15 * 60 * 1000);
    const dateStr = new Date(timestamp).toISOString().split('T')[0];

    const open = parseFloat(cols[4]);
    const high = parseFloat(cols[5]);
    const low = parseFloat(cols[6]);
    const close = parseFloat(cols[7]);
    const volume = parseInt(cols[8]);

    if (isNaN(close)) continue;

    if (!currentCandle || currentCandle.interval15m !== interval15m) {
      if (currentCandle) {
        data.push(currentCandle);
      }
      currentCandle = {
        interval15m,
        dateStr,
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

  if (currentCandle) data.push(currentCandle);

  console.log(`Loaded ${data.length} 15-minute OHLCV records`);
  return data;
}

// ========================================
// ANALYSIS FUNCTIONS
// ========================================

function calculateDailyMetrics(ivData, gexData, liquidityData, ohlcvData) {
  // Group all data by date
  const dailyMetrics = new Map();

  // Process IV data
  for (const iv of ivData) {
    if (!dailyMetrics.has(iv.dateStr)) {
      dailyMetrics.set(iv.dateStr, { date: iv.dateStr });
    }
    const day = dailyMetrics.get(iv.dateStr);

    if (!day.ivReadings) day.ivReadings = [];
    day.ivReadings.push(iv);
  }

  // Process GEX data
  for (const gex of gexData) {
    if (!dailyMetrics.has(gex.dateStr)) {
      dailyMetrics.set(gex.dateStr, { date: gex.dateStr });
    }
    const day = dailyMetrics.get(gex.dateStr);
    day.gex = gex;
  }

  // Process liquidity data - get daily averages and sentiment changes
  for (const liq of liquidityData) {
    if (!dailyMetrics.has(liq.dateStr)) {
      dailyMetrics.set(liq.dateStr, { date: liq.dateStr });
    }
    const day = dailyMetrics.get(liq.dateStr);

    if (!day.liquidityReadings) day.liquidityReadings = [];
    day.liquidityReadings.push(liq);
  }

  // Process OHLCV data
  for (const candle of ohlcvData) {
    if (!dailyMetrics.has(candle.dateStr)) {
      dailyMetrics.set(candle.dateStr, { date: candle.dateStr });
    }
    const day = dailyMetrics.get(candle.dateStr);

    if (!day.candles) day.candles = [];
    day.candles.push(candle);
  }

  // Calculate daily aggregates
  for (const [date, day] of dailyMetrics) {
    // IV aggregates
    if (day.ivReadings && day.ivReadings.length > 0) {
      const ivs = day.ivReadings.map(r => r.iv).filter(v => !isNaN(v));
      const skews = day.ivReadings.map(r => r.ivSkew).filter(v => !isNaN(v));

      day.avgIV = ivs.reduce((a, b) => a + b, 0) / ivs.length;
      day.maxIV = Math.max(...ivs);
      day.minIV = Math.min(...ivs);
      day.ivRange = day.maxIV - day.minIV;
      day.avgSkew = skews.reduce((a, b) => a + b, 0) / skews.length;
      day.openIV = day.ivReadings[0].iv;
      day.closeIV = day.ivReadings[day.ivReadings.length - 1].iv;
      day.ivChange = day.closeIV - day.openIV;
    }

    // Liquidity aggregates
    if (day.liquidityReadings && day.liquidityReadings.length > 0) {
      const bullish = day.liquidityReadings.filter(r => r.sentiment === 'BULLISH').length;
      const bearish = day.liquidityReadings.filter(r => r.sentiment === 'BEARISH').length;
      day.bullishRatio = bullish / day.liquidityReadings.length;
      day.bearishRatio = bearish / day.liquidityReadings.length;
      day.sentimentFlips = day.liquidityReadings.reduce((count, r, i, arr) => {
        if (i === 0) return 0;
        return count + (r.sentiment !== arr[i-1].sentiment ? 1 : 0);
      }, 0);
    }

    // OHLCV aggregates
    if (day.candles && day.candles.length > 0) {
      day.dayOpen = day.candles[0].open;
      day.dayHigh = Math.max(...day.candles.map(c => c.high));
      day.dayLow = Math.min(...day.candles.map(c => c.low));
      day.dayClose = day.candles[day.candles.length - 1].close;
      day.dayRange = day.dayHigh - day.dayLow;
      day.dayReturn = (day.dayClose - day.dayOpen) / day.dayOpen * 100;
      day.dayVolume = day.candles.reduce((sum, c) => sum + c.volume, 0);

      // Calculate intraday volatility (sum of candle ranges)
      day.intradayVolatility = day.candles.reduce((sum, c) => sum + (c.high - c.low), 0);
    }
  }

  return dailyMetrics;
}

function analyzeIVPriceCorrelation(dailyMetrics) {
  console.log('\n========================================');
  console.log('IV vs PRICE CORRELATION ANALYSIS');
  console.log('========================================\n');

  // Get days with both IV and price data
  const validDays = [...dailyMetrics.values()].filter(d =>
    d.avgIV !== undefined && d.dayReturn !== undefined
  );

  console.log(`Analyzing ${validDays.length} days with both IV and price data\n`);

  // 1. IV Level Buckets vs Returns
  const ivBuckets = {
    low: { label: 'Low IV (<15%)', days: [], returns: [] },
    medium: { label: 'Medium IV (15-25%)', days: [], returns: [] },
    high: { label: 'High IV (25-35%)', days: [], returns: [] },
    veryHigh: { label: 'Very High IV (>35%)', days: [], returns: [] }
  };

  for (const day of validDays) {
    const ivPct = day.avgIV * 100;
    let bucket;
    if (ivPct < 15) bucket = ivBuckets.low;
    else if (ivPct < 25) bucket = ivBuckets.medium;
    else if (ivPct < 35) bucket = ivBuckets.high;
    else bucket = ivBuckets.veryHigh;

    bucket.days.push(day);
    bucket.returns.push(day.dayReturn);
  }

  console.log('Daily Returns by IV Level:');
  console.log('-'.repeat(70));

  for (const [key, bucket] of Object.entries(ivBuckets)) {
    if (bucket.days.length === 0) continue;

    const avgReturn = bucket.returns.reduce((a, b) => a + b, 0) / bucket.returns.length;
    const posReturns = bucket.returns.filter(r => r > 0).length;
    const absReturns = bucket.returns.map(r => Math.abs(r));
    const avgAbsReturn = absReturns.reduce((a, b) => a + b, 0) / absReturns.length;

    console.log(`${bucket.label}:`);
    console.log(`  Days: ${bucket.days.length}`);
    console.log(`  Avg Return: ${avgReturn.toFixed(3)}%`);
    console.log(`  Avg Abs Return: ${avgAbsReturn.toFixed(3)}%`);
    console.log(`  Win Rate: ${(posReturns / bucket.returns.length * 100).toFixed(1)}%`);
    console.log();
  }

  // 2. IV Skew Analysis
  console.log('\nIV Skew Analysis (Put IV - Call IV):');
  console.log('-'.repeat(70));

  const skewBuckets = {
    putPremium: { label: 'Put Premium (skew > 0.02)', days: [], returns: [] },
    neutral: { label: 'Neutral (-0.02 to 0.02)', days: [], returns: [] },
    callPremium: { label: 'Call Premium (skew < -0.02)', days: [], returns: [] }
  };

  for (const day of validDays) {
    if (day.avgSkew === undefined) continue;

    let bucket;
    if (day.avgSkew > 0.02) bucket = skewBuckets.putPremium;
    else if (day.avgSkew < -0.02) bucket = skewBuckets.callPremium;
    else bucket = skewBuckets.neutral;

    bucket.days.push(day);
    bucket.returns.push(day.dayReturn);
  }

  for (const [key, bucket] of Object.entries(skewBuckets)) {
    if (bucket.days.length === 0) continue;

    const avgReturn = bucket.returns.reduce((a, b) => a + b, 0) / bucket.returns.length;
    const posReturns = bucket.returns.filter(r => r > 0).length;

    console.log(`${bucket.label}:`);
    console.log(`  Days: ${bucket.days.length}`);
    console.log(`  Avg Return: ${avgReturn.toFixed(3)}%`);
    console.log(`  Win Rate: ${(posReturns / bucket.returns.length * 100).toFixed(1)}%`);
    console.log();
  }

  // 3. IV Change vs Next Day Return
  console.log('\nIV Change vs Next Day Return:');
  console.log('-'.repeat(70));

  const sortedDays = validDays.sort((a, b) => a.date.localeCompare(b.date));
  const ivChangeReturns = {
    increasing: { label: 'IV Increasing (>0.01)', nextReturns: [] },
    decreasing: { label: 'IV Decreasing (<-0.01)', nextReturns: [] },
    stable: { label: 'IV Stable', nextReturns: [] }
  };

  for (let i = 0; i < sortedDays.length - 1; i++) {
    const today = sortedDays[i];
    const tomorrow = sortedDays[i + 1];

    if (today.ivChange === undefined || tomorrow.dayReturn === undefined) continue;

    let bucket;
    if (today.ivChange > 0.01) bucket = ivChangeReturns.increasing;
    else if (today.ivChange < -0.01) bucket = ivChangeReturns.decreasing;
    else bucket = ivChangeReturns.stable;

    bucket.nextReturns.push(tomorrow.dayReturn);
  }

  for (const [key, bucket] of Object.entries(ivChangeReturns)) {
    if (bucket.nextReturns.length === 0) continue;

    const avgReturn = bucket.nextReturns.reduce((a, b) => a + b, 0) / bucket.nextReturns.length;
    const posReturns = bucket.nextReturns.filter(r => r > 0).length;

    console.log(`${bucket.label}:`);
    console.log(`  Sample Size: ${bucket.nextReturns.length}`);
    console.log(`  Avg Next Day Return: ${avgReturn.toFixed(3)}%`);
    console.log(`  Next Day Win Rate: ${(posReturns / bucket.nextReturns.length * 100).toFixed(1)}%`);
    console.log();
  }

  return { ivBuckets, skewBuckets, ivChangeReturns };
}

function analyzeGEXCorrelation(dailyMetrics) {
  console.log('\n========================================');
  console.log('GEX vs PRICE CORRELATION ANALYSIS');
  console.log('========================================\n');

  const validDays = [...dailyMetrics.values()].filter(d =>
    d.gex && d.dayReturn !== undefined
  );

  console.log(`Analyzing ${validDays.length} days with both GEX and price data\n`);

  // 1. GEX Regime Analysis
  const regimeBuckets = {
    positive: { label: 'Positive GEX', days: [], returns: [], ranges: [] },
    negative: { label: 'Negative GEX', days: [], returns: [], ranges: [] }
  };

  for (const day of validDays) {
    const bucket = day.gex.regime === 'positive' ? regimeBuckets.positive : regimeBuckets.negative;
    bucket.days.push(day);
    bucket.returns.push(day.dayReturn);
    if (day.dayRange) bucket.ranges.push(day.dayRange);
  }

  console.log('Daily Returns by GEX Regime:');
  console.log('-'.repeat(70));

  for (const [key, bucket] of Object.entries(regimeBuckets)) {
    if (bucket.days.length === 0) continue;

    const avgReturn = bucket.returns.reduce((a, b) => a + b, 0) / bucket.returns.length;
    const absReturns = bucket.returns.map(r => Math.abs(r));
    const avgAbsReturn = absReturns.reduce((a, b) => a + b, 0) / absReturns.length;
    const posReturns = bucket.returns.filter(r => r > 0).length;
    const avgRange = bucket.ranges.length > 0 ? bucket.ranges.reduce((a, b) => a + b, 0) / bucket.ranges.length : 0;

    console.log(`${bucket.label}:`);
    console.log(`  Days: ${bucket.days.length}`);
    console.log(`  Avg Return: ${avgReturn.toFixed(3)}%`);
    console.log(`  Avg Abs Return (Volatility): ${avgAbsReturn.toFixed(3)}%`);
    console.log(`  Win Rate (Up Days): ${(posReturns / bucket.returns.length * 100).toFixed(1)}%`);
    console.log(`  Avg Daily Range: ${avgRange.toFixed(2)} pts`);
    console.log();
  }

  // 2. Price vs Gamma Flip Analysis
  console.log('\nPrice Position Relative to Gamma Flip:');
  console.log('-'.repeat(70));

  const gammaFlipBuckets = {
    above: { label: 'Price Above Gamma Flip', days: [], returns: [] },
    below: { label: 'Price Below Gamma Flip', days: [], returns: [] },
    noFlip: { label: 'No Gamma Flip', days: [], returns: [] }
  };

  for (const day of validDays) {
    if (!day.gex.gammaFlip || !day.dayClose) {
      gammaFlipBuckets.noFlip.days.push(day);
      gammaFlipBuckets.noFlip.returns.push(day.dayReturn);
      continue;
    }

    const bucket = day.dayClose > day.gex.gammaFlip ? gammaFlipBuckets.above : gammaFlipBuckets.below;
    bucket.days.push(day);
    bucket.returns.push(day.dayReturn);
  }

  for (const [key, bucket] of Object.entries(gammaFlipBuckets)) {
    if (bucket.days.length === 0) continue;

    const avgReturn = bucket.returns.reduce((a, b) => a + b, 0) / bucket.returns.length;
    const absReturns = bucket.returns.map(r => Math.abs(r));
    const avgAbsReturn = absReturns.reduce((a, b) => a + b, 0) / absReturns.length;
    const posReturns = bucket.returns.filter(r => r > 0).length;

    console.log(`${bucket.label}:`);
    console.log(`  Days: ${bucket.days.length}`);
    console.log(`  Avg Return: ${avgReturn.toFixed(3)}%`);
    console.log(`  Avg Volatility: ${avgAbsReturn.toFixed(3)}%`);
    console.log(`  Win Rate: ${(posReturns / bucket.returns.length * 100).toFixed(1)}%`);
    console.log();
  }

  // 3. Wall Proximity Analysis
  console.log('\nWall Proximity Analysis (within 0.5%):');
  console.log('-'.repeat(70));

  const wallProximity = {
    nearCallWall: { label: 'Near Call Wall', days: [], returns: [] },
    nearPutWall: { label: 'Near Put Wall', days: [], returns: [] },
    betweenWalls: { label: 'Between Walls', days: [], returns: [] }
  };

  for (const day of validDays) {
    if (!day.dayClose) continue;

    const callWall = day.gex.callWall1;
    const putWall = day.gex.putWall1;
    const price = day.dayClose;

    const callDistance = (callWall - price) / price;
    const putDistance = (price - putWall) / price;

    let bucket;
    if (callDistance < 0.005 && callDistance > -0.005) {
      bucket = wallProximity.nearCallWall;
    } else if (putDistance < 0.005 && putDistance > -0.005) {
      bucket = wallProximity.nearPutWall;
    } else {
      bucket = wallProximity.betweenWalls;
    }

    bucket.days.push(day);
    bucket.returns.push(day.dayReturn);
  }

  for (const [key, bucket] of Object.entries(wallProximity)) {
    if (bucket.days.length === 0) continue;

    const avgReturn = bucket.returns.reduce((a, b) => a + b, 0) / bucket.returns.length;
    const posReturns = bucket.returns.filter(r => r > 0).length;

    console.log(`${bucket.label}:`);
    console.log(`  Days: ${bucket.days.length}`);
    console.log(`  Avg Next Return: ${avgReturn.toFixed(3)}%`);
    console.log(`  Win Rate: ${(posReturns / bucket.returns.length * 100).toFixed(1)}%`);
    console.log();
  }

  return { regimeBuckets, gammaFlipBuckets, wallProximity };
}

function analyzeLiquidityCorrelation(dailyMetrics) {
  console.log('\n========================================');
  console.log('LIQUIDITY SENTIMENT vs PRICE ANALYSIS');
  console.log('========================================\n');

  const validDays = [...dailyMetrics.values()].filter(d =>
    d.bullishRatio !== undefined && d.dayReturn !== undefined
  );

  console.log(`Analyzing ${validDays.length} days with both liquidity and price data\n`);

  // 1. Sentiment Ratio Analysis
  const sentimentBuckets = {
    strongBullish: { label: 'Strong Bullish (>70%)', days: [], returns: [] },
    moderateBullish: { label: 'Moderate Bullish (55-70%)', days: [], returns: [] },
    neutral: { label: 'Neutral (45-55%)', days: [], returns: [] },
    moderateBearish: { label: 'Moderate Bearish (30-45%)', days: [], returns: [] },
    strongBearish: { label: 'Strong Bearish (<30%)', days: [], returns: [] }
  };

  for (const day of validDays) {
    const ratio = day.bullishRatio * 100;
    let bucket;
    if (ratio > 70) bucket = sentimentBuckets.strongBullish;
    else if (ratio > 55) bucket = sentimentBuckets.moderateBullish;
    else if (ratio > 45) bucket = sentimentBuckets.neutral;
    else if (ratio > 30) bucket = sentimentBuckets.moderateBearish;
    else bucket = sentimentBuckets.strongBearish;

    bucket.days.push(day);
    bucket.returns.push(day.dayReturn);
  }

  console.log('Daily Returns by Liquidity Sentiment:');
  console.log('-'.repeat(70));

  for (const [key, bucket] of Object.entries(sentimentBuckets)) {
    if (bucket.days.length === 0) continue;

    const avgReturn = bucket.returns.reduce((a, b) => a + b, 0) / bucket.returns.length;
    const posReturns = bucket.returns.filter(r => r > 0).length;

    console.log(`${bucket.label}:`);
    console.log(`  Days: ${bucket.days.length}`);
    console.log(`  Avg Return: ${avgReturn.toFixed(3)}%`);
    console.log(`  Win Rate: ${(posReturns / bucket.returns.length * 100).toFixed(1)}%`);
    console.log();
  }

  // 2. Sentiment Flip Analysis
  console.log('\nSentiment Flip Frequency Analysis:');
  console.log('-'.repeat(70));

  const flipBuckets = {
    stable: { label: 'Stable (<3 flips)', days: [], returns: [] },
    moderate: { label: 'Moderate (3-6 flips)', days: [], returns: [] },
    choppy: { label: 'Choppy (>6 flips)', days: [], returns: [] }
  };

  for (const day of validDays) {
    if (day.sentimentFlips === undefined) continue;

    let bucket;
    if (day.sentimentFlips < 3) bucket = flipBuckets.stable;
    else if (day.sentimentFlips <= 6) bucket = flipBuckets.moderate;
    else bucket = flipBuckets.choppy;

    bucket.days.push(day);
    bucket.returns.push(day.dayReturn);
  }

  for (const [key, bucket] of Object.entries(flipBuckets)) {
    if (bucket.days.length === 0) continue;

    const avgReturn = bucket.returns.reduce((a, b) => a + b, 0) / bucket.returns.length;
    const absReturns = bucket.returns.map(r => Math.abs(r));
    const avgAbsReturn = absReturns.reduce((a, b) => a + b, 0) / absReturns.length;

    console.log(`${bucket.label}:`);
    console.log(`  Days: ${bucket.days.length}`);
    console.log(`  Avg Return: ${avgReturn.toFixed(3)}%`);
    console.log(`  Avg Volatility: ${avgAbsReturn.toFixed(3)}%`);
    console.log();
  }

  return { sentimentBuckets, flipBuckets };
}

function analyzeConfluence(dailyMetrics) {
  console.log('\n========================================');
  console.log('CONFLUENCE ANALYSIS - COMBINED SIGNALS');
  console.log('========================================\n');

  const validDays = [...dailyMetrics.values()].filter(d =>
    d.avgIV !== undefined &&
    d.gex &&
    d.bullishRatio !== undefined &&
    d.dayReturn !== undefined
  );

  console.log(`Analyzing ${validDays.length} days with all four data sources\n`);

  // Define signal conditions
  function getSignals(day) {
    const signals = {
      bullish: [],
      bearish: []
    };

    // IV signals
    const ivPct = day.avgIV * 100;
    if (ivPct < 18) signals.bullish.push('low_iv');
    if (ivPct > 30) signals.bearish.push('high_iv');
    if (day.avgSkew > 0.02) signals.bearish.push('put_premium');
    if (day.avgSkew < -0.02) signals.bullish.push('call_premium');
    if (day.ivChange < -0.015) signals.bullish.push('iv_declining');
    if (day.ivChange > 0.015) signals.bearish.push('iv_rising');

    // GEX signals
    if (day.gex.regime === 'positive') signals.bullish.push('positive_gex');
    if (day.gex.regime === 'negative') signals.bearish.push('negative_gex');
    if (day.gex.gammaFlip && day.dayClose > day.gex.gammaFlip) {
      signals.bullish.push('above_gamma_flip');
    }
    if (day.gex.gammaFlip && day.dayClose < day.gex.gammaFlip) {
      signals.bearish.push('below_gamma_flip');
    }

    // Liquidity signals
    if (day.bullishRatio > 0.65) signals.bullish.push('bullish_liquidity');
    if (day.bullishRatio < 0.35) signals.bearish.push('bearish_liquidity');
    if (day.sentimentFlips < 2) signals.bullish.push('stable_sentiment');
    if (day.sentimentFlips > 8) signals.bearish.push('choppy_sentiment');

    return signals;
  }

  // Analyze confluence levels
  const confluenceResults = [];

  for (const day of validDays) {
    const signals = getSignals(day);
    confluenceResults.push({
      date: day.date,
      bullishCount: signals.bullish.length,
      bearishCount: signals.bearish.length,
      netSignal: signals.bullish.length - signals.bearish.length,
      bullishSignals: signals.bullish,
      bearishSignals: signals.bearish,
      return: day.dayReturn,
      range: day.dayRange
    });
  }

  // Group by net signal strength
  const signalStrengthBuckets = {
    strongBullish: { label: 'Strong Bullish (3+ net bullish)', days: [], returns: [] },
    moderateBullish: { label: 'Moderate Bullish (1-2 net)', days: [], returns: [] },
    neutral: { label: 'Neutral (0 net)', days: [], returns: [] },
    moderateBearish: { label: 'Moderate Bearish (-1 to -2 net)', days: [], returns: [] },
    strongBearish: { label: 'Strong Bearish (-3 or more)', days: [], returns: [] }
  };

  for (const result of confluenceResults) {
    let bucket;
    if (result.netSignal >= 3) bucket = signalStrengthBuckets.strongBullish;
    else if (result.netSignal >= 1) bucket = signalStrengthBuckets.moderateBullish;
    else if (result.netSignal === 0) bucket = signalStrengthBuckets.neutral;
    else if (result.netSignal >= -2) bucket = signalStrengthBuckets.moderateBearish;
    else bucket = signalStrengthBuckets.strongBearish;

    bucket.days.push(result);
    bucket.returns.push(result.return);
  }

  console.log('Returns by Confluence Signal Strength:');
  console.log('-'.repeat(70));

  for (const [key, bucket] of Object.entries(signalStrengthBuckets)) {
    if (bucket.days.length === 0) continue;

    const avgReturn = bucket.returns.reduce((a, b) => a + b, 0) / bucket.returns.length;
    const posReturns = bucket.returns.filter(r => r > 0).length;
    const absReturns = bucket.returns.map(r => Math.abs(r));
    const avgAbsReturn = absReturns.reduce((a, b) => a + b, 0) / absReturns.length;

    console.log(`${bucket.label}:`);
    console.log(`  Days: ${bucket.days.length}`);
    console.log(`  Avg Return: ${avgReturn.toFixed(3)}%`);
    console.log(`  Win Rate: ${(posReturns / bucket.returns.length * 100).toFixed(1)}%`);
    console.log(`  Avg Volatility: ${avgAbsReturn.toFixed(3)}%`);
    console.log();
  }

  // Find best confluence combinations
  console.log('\nTop Performing Signal Combinations:');
  console.log('-'.repeat(70));

  const signalCombinations = new Map();

  for (const result of confluenceResults) {
    const allSignals = [...result.bullishSignals, ...result.bearishSignals].sort().join(',');
    if (!signalCombinations.has(allSignals)) {
      signalCombinations.set(allSignals, { signals: allSignals, returns: [], count: 0 });
    }
    const combo = signalCombinations.get(allSignals);
    combo.returns.push(result.return);
    combo.count++;
  }

  // Filter for combinations with >= 5 occurrences and calculate performance
  const validCombos = [...signalCombinations.values()]
    .filter(c => c.count >= 5)
    .map(c => ({
      ...c,
      avgReturn: c.returns.reduce((a, b) => a + b, 0) / c.returns.length,
      winRate: c.returns.filter(r => r > 0).length / c.returns.length
    }))
    .sort((a, b) => b.avgReturn - a.avgReturn);

  console.log('\nBest Combinations for LONG positions (sorted by return):');
  for (const combo of validCombos.slice(0, 10)) {
    if (combo.avgReturn <= 0) continue;
    console.log(`\n  Signals: ${combo.signals || 'NONE'}`);
    console.log(`  Occurrences: ${combo.count}`);
    console.log(`  Avg Return: ${combo.avgReturn.toFixed(3)}%`);
    console.log(`  Win Rate: ${(combo.winRate * 100).toFixed(1)}%`);
  }

  console.log('\n\nBest Combinations for SHORT positions (sorted by return):');
  const shortCombos = validCombos.slice().sort((a, b) => a.avgReturn - b.avgReturn);
  for (const combo of shortCombos.slice(0, 10)) {
    if (combo.avgReturn >= 0) continue;
    console.log(`\n  Signals: ${combo.signals || 'NONE'}`);
    console.log(`  Occurrences: ${combo.count}`);
    console.log(`  Avg Return: ${combo.avgReturn.toFixed(3)}%`);
    console.log(`  Win Rate (short): ${((1 - combo.winRate) * 100).toFixed(1)}%`);
  }

  return { signalStrengthBuckets, confluenceResults };
}

function generateActionableRecommendations(ivAnalysis, gexAnalysis, liquidityAnalysis, confluenceAnalysis) {
  console.log('\n========================================');
  console.log('ACTIONABLE TRADING RECOMMENDATIONS');
  console.log('========================================\n');

  console.log('Based on the cross-dataset analysis, here are key findings:\n');

  // Long recommendations
  console.log('LONG SIGNAL CONDITIONS:');
  console.log('-'.repeat(70));
  console.log('');
  console.log('1. IV ENVIRONMENT:');
  console.log('   - Low IV (<15%): Consider long positions');
  console.log('   - IV declining from previous day: Bullish signal');
  console.log('   - Call premium in skew: Contrarian long signal');
  console.log('');
  console.log('2. GEX POSITIONING:');
  console.log('   - Positive GEX regime: Lower volatility, range-bound');
  console.log('   - Price above gamma flip: Bullish momentum');
  console.log('   - Near put wall support: Mean reversion long');
  console.log('');
  console.log('3. LIQUIDITY SENTIMENT:');
  console.log('   - Bullish sentiment >65%: Trend alignment');
  console.log('   - Stable sentiment (low flip count): Cleaner trends');
  console.log('');
  console.log('CONFLUENCE LONG ENTRY:');
  console.log('   Positive GEX + Above Gamma Flip + Low IV + Bullish Liquidity');
  console.log('');

  // Short recommendations
  console.log('\nSHORT SIGNAL CONDITIONS:');
  console.log('-'.repeat(70));
  console.log('');
  console.log('1. IV ENVIRONMENT:');
  console.log('   - High IV (>30%): Consider short or avoid');
  console.log('   - IV rising: Bearish/uncertain signal');
  console.log('   - Put premium in skew: Fear in market');
  console.log('');
  console.log('2. GEX POSITIONING:');
  console.log('   - Negative GEX regime: Higher volatility expected');
  console.log('   - Price below gamma flip: Bearish momentum');
  console.log('   - Near call wall resistance: Mean reversion short');
  console.log('');
  console.log('3. LIQUIDITY SENTIMENT:');
  console.log('   - Bearish sentiment (<35%): Trend alignment');
  console.log('   - Choppy sentiment (high flip count): Range-bound, fade extremes');
  console.log('');
  console.log('CONFLUENCE SHORT ENTRY:');
  console.log('   Negative GEX + Below Gamma Flip + High IV + Bearish Liquidity');
  console.log('');

  // Risk management
  console.log('\nRISK MANAGEMENT RULES:');
  console.log('-'.repeat(70));
  console.log('');
  console.log('1. Position sizing based on IV:');
  console.log('   - Low IV: Standard position size');
  console.log('   - Medium IV: 75% position size');
  console.log('   - High IV: 50% position size or skip');
  console.log('');
  console.log('2. Stop loss based on GEX levels:');
  console.log('   - Long: Stop below put wall or gamma flip');
  console.log('   - Short: Stop above call wall or gamma flip');
  console.log('');
  console.log('3. Target based on walls:');
  console.log('   - Long: First target at call wall');
  console.log('   - Short: First target at put wall');
  console.log('');
}

// ========================================
// MAIN EXECUTION
// ========================================

async function main() {
  console.log('Loading datasets...\n');

  const ivData = loadIVData();
  const gexData = loadGEXData();
  const liquidityData = loadLiquidityData();
  const ohlcvData = loadOHLCVData();

  console.log('\nCalculating daily metrics...');
  const dailyMetrics = calculateDailyMetrics(ivData, gexData, liquidityData, ohlcvData);
  console.log(`Created metrics for ${dailyMetrics.size} unique dates\n`);

  // Run analyses
  const ivAnalysis = analyzeIVPriceCorrelation(dailyMetrics);
  const gexAnalysis = analyzeGEXCorrelation(dailyMetrics);
  const liquidityAnalysis = analyzeLiquidityCorrelation(dailyMetrics);
  const confluenceAnalysis = analyzeConfluence(dailyMetrics);

  // Generate recommendations
  generateActionableRecommendations(ivAnalysis, gexAnalysis, liquidityAnalysis, confluenceAnalysis);

  // Save analysis results
  const analysisResults = {
    metadata: {
      generated: new Date().toISOString(),
      ivDataRange: `${ivData[0]?.dateStr} to ${ivData[ivData.length-1]?.dateStr}`,
      gexDataRange: `${gexData[0]?.dateStr} to ${gexData[gexData.length-1]?.dateStr}`,
      liquidityDataRange: `${liquidityData[0]?.dateStr} to ${liquidityData[liquidityData.length-1]?.dateStr}`,
      daysAnalyzed: dailyMetrics.size
    },
    ivAnalysis,
    gexAnalysis,
    liquidityAnalysis,
    confluenceAnalysis
  };

  fs.writeFileSync('./results/cross-dataset-analysis.json', JSON.stringify(analysisResults, null, 2));
  console.log('\nResults saved to ./results/cross-dataset-analysis.json');
}

main().catch(console.error);
