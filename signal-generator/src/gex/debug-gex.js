#!/usr/bin/env node

// Debug script to compare GEX calculation data processing with Python version
import GexCalculator from './gex-calculator.js';
import config from '../utils/config.js';

console.log('='.repeat(60));
console.log('GEX Calculator Debug - Data Comparison');
console.log('='.repeat(60));

class DebugGexCalculator extends GexCalculator {
  parseOptionSymbol(symbol) {
    const result = super.parseOptionSymbol(symbol);
    return result;
  }

  calculateGEX(optionsData) {
    const data = optionsData.data || {};
    const spotPrice = data.close;
    const options = data.options || [];

    console.log('📊 Raw Options Data:');
    console.log(`- Spot Price: $${spotPrice}`);
    console.log(`- Total Options: ${options.length}`);
    console.log('');

    // Debug option parsing
    let validOptions = 0;
    let invalidOptions = 0;
    let callCount = 0;
    let putCount = 0;
    const sampleOptions = [];

    console.log('🔍 Sample Options Processing:');

    for (let i = 0; i < Math.min(10, options.length); i++) {
      const opt = options[i];
      const symbol = opt.option;

      try {
        const parsed = this.parseOptionSymbol(symbol);
        console.log(`${i + 1}. ${symbol} → Strike: ${parsed.strike}, Type: ${parsed.optType}, Expiry: ${parsed.expiry.toISOString().split('T')[0]}, OI: ${opt.open_interest || 0}, IV: ${opt.iv || 'N/A'}`);
        sampleOptions.push({ symbol, parsed, oi: opt.open_interest || 0, iv: opt.iv || 0 });
      } catch (error) {
        console.log(`${i + 1}. ${symbol} → PARSE ERROR: ${error.message}`);
      }
    }

    console.log('');

    // Process all options and collect statistics
    const now = new Date();
    let totalValidOptions = 0;
    const strikeRange = { min: Infinity, max: 0 };
    const expiryDates = new Set();

    for (const opt of options) {
      const symbol = opt.option;
      if (!symbol) {
        invalidOptions++;
        continue;
      }

      try {
        const { expiry, optType, strike } = this.parseOptionSymbol(symbol);

        // Calculate time to expiration
        const dte = Math.max(0, (expiry - now) / (1000 * 60 * 60 * 24));
        if (dte <= 0) {
          invalidOptions++;
          continue;
        }

        const oi = opt.open_interest || 0;
        if (oi === 0) {
          invalidOptions++;
          continue;
        }

        validOptions++;
        totalValidOptions++;
        strikeRange.min = Math.min(strikeRange.min, strike);
        strikeRange.max = Math.max(strikeRange.max, strike);
        expiryDates.add(expiry.toISOString().split('T')[0]);

        if (optType === 'call') callCount++;
        else putCount++;

      } catch (error) {
        invalidOptions++;
      }
    }

    console.log('📈 Processing Statistics:');
    console.log(`- Valid Options: ${validOptions}`);
    console.log(`- Invalid/Filtered: ${invalidOptions}`);
    console.log(`- Calls: ${callCount}`);
    console.log(`- Puts: ${putCount}`);
    console.log(`- Strike Range: $${strikeRange.min} - $${strikeRange.max}`);
    console.log(`- Unique Expiry Dates: ${expiryDates.size}`);
    console.log(`- Expiry Dates: ${Array.from(expiryDates).sort().join(', ')}`);
    console.log('');

    // Now run the actual calculation and show intermediate results
    const result = super.calculateGEX(optionsData);

    console.log('🎯 Calculation Results:');
    console.log(`- Total GEX: ${result.totalGex.toFixed(3)}B`);
    console.log(`- Regime: ${result.regime}`);
    console.log(`- Gamma Flip: ${result.gammaFlip}`);
    console.log(`- Put Wall: ${result.putWall}`);
    console.log(`- Call Wall: ${result.callWall}`);
    console.log('');

    return result;
  }

  calcGammaEx(S, K, vol, T, r, q, optType, OI) {
    const result = super.calcGammaEx(S, K, vol, T, r, q, optType, OI);

    // Log some sample calculations for debugging
    if (Math.random() < 0.001) { // Sample ~0.1% of calculations
      console.log(`🔬 Sample Gamma Calc: S=${S}, K=${K}, vol=${vol.toFixed(3)}, T=${T.toFixed(3)}, type=${optType}, OI=${OI}, GEX=${result.toFixed(2)}`);
    }

    return result;
  }
}

async function debug() {
  try {
    console.log('Creating debug calculator...');
    const calculator = new DebugGexCalculator({
      symbol: config.GEX_SYMBOL,
      cooldownMinutes: 0 // Bypass cooldown for debug
    });

    console.log('Fetching fresh options data...');
    const optionsData = await calculator.fetchCBOEOptions();

    console.log('Processing options data with debug info...');
    const qqqLevels = calculator.calculateGEX(optionsData);

    console.log('Translating to NQ levels...');
    const nqLevels = await calculator.translateToNQ(qqqLevels);

    console.log('🏁 Final Results:');
    console.log(`- QQQ Spot: $${qqqLevels.spotPrice.toFixed(2)}`);
    console.log(`- NQ Spot: ${nqLevels.spot.toFixed(0)}`);
    console.log(`- Multiplier: ${nqLevels.multiplier.toFixed(2)}`);
    console.log(`- Total GEX: ${qqqLevels.totalGex.toFixed(3)}B`);
    console.log(`- Regime: ${qqqLevels.regime.toUpperCase()}`);
    console.log(`- Gamma Flip: ${nqLevels.gammaFlip}`);
    console.log(`- Put Wall: ${nqLevels.putWall}`);
    console.log(`- Call Wall: ${nqLevels.callWall}`);
    console.log(`- Support: [${nqLevels.support.join(', ')}]`);
    console.log(`- Resistance: [${nqLevels.resistance.join(', ')}]`);

    // Save raw data for comparison
    console.log('');
    console.log('💾 Saving raw options data to debug_options.json for comparison...');
    const fs = await import('fs/promises');
    await fs.writeFile('./debug_options.json', JSON.stringify(optionsData, null, 2));
    console.log('✅ Raw data saved!');

  } catch (error) {
    console.error('❌ Debug failed:', error);
    process.exit(1);
  }
}

debug();