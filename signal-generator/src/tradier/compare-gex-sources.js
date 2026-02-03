#!/usr/bin/env node

// Compare GEX calculations between CBOE and Tradier sources
import { createLogger } from '../../../shared/index.js';
import TradierExposureService from './tradier-exposure-service.js';
import GexCalculator from '../gex/gex-calculator.js';
import config from '../utils/config.js';

const logger = createLogger('gex-comparison');

async function compareGexSources() {
  console.log('\n🔍 GEX Source Comparison Test');
  console.log('================================\n');

  let cboeCalculator = null;

  try {
    // Initialize CBOE calculator (existing)
    console.log('📊 Initializing CBOE GEX Calculator...');
    cboeCalculator = new GexCalculator();
    console.log('✅ CBOE calculator ready\n');

    // Check that Tradier service is running
    console.log('🔗 Checking Tradier Exposure Service...');
    const axios = (await import('axios')).default;
    try {
      const statusResponse = await axios.get('http://localhost:3015/tradier/status');
      if (!statusResponse.data.active) {
        throw new Error('Tradier service not active');
      }
      console.log('✅ Tradier service is running\n');
    } catch (error) {
      throw new Error(`Tradier service not available: ${error.message}`);
    }

    // Wait a moment for data to populate
    console.log('⏳ Waiting for data to populate...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Get current market data for comparison context
    console.log('📈 Current Market Context:');
    try {
      const statusResponse = await axios.get('http://localhost:3015/tradier/status');
      const health = statusResponse.data.health;
      console.log(`  NQ Futures: ${health.spotPrices?.QQQ ? (health.spotPrices.QQQ * 41.39).toFixed(2) : 'N/A'}`);
      console.log(`  QQQ Spot: ${health.spotPrices?.QQQ || 'N/A'}`);
      console.log(`  SPY Spot: ${health.spotPrices?.SPY || 'N/A'}`);
    } catch (error) {
      console.log('  Market data: Not available');
    }
    console.log('');

    // Calculate GEX from both sources
    console.log('🧮 Calculating GEX Levels...\n');

    // CBOE calculation
    console.log('📊 CBOE Results:');
    console.log('─'.repeat(40));
    const cboeStartTime = Date.now();
    const cboeResults = await cboeCalculator.calculateLevels();
    const cboeCalcTime = Date.now() - cboeStartTime;

    console.log(`  Data Source: CBOE`);
    console.log(`  Calculation Time: ${cboeCalcTime}ms`);
    console.log(`  NQ Spot: ${cboeResults.nqSpot}`);
    console.log(`  QQQ Spot: ${cboeResults.qqqSpot}`);
    console.log(`  Total GEX: ${cboeResults.totalGex.toFixed(2)}B`);
    console.log(`  Regime: ${cboeResults.regime}`);
    console.log(`  Gamma Flip: ${cboeResults.gammaFlip}`);
    console.log(`  Call Wall: ${cboeResults.callWall}`);
    console.log(`  Put Wall: ${cboeResults.putWall}`);
    console.log(`  Support Levels: [${cboeResults.support.slice(0, 3).join(', ')}...]`);
    console.log(`  Resistance Levels: [${cboeResults.resistance.slice(0, 3).join(', ')}...]`);
    console.log(`  From Cache: ${cboeResults.fromCache}`);
    console.log('');

    // Tradier calculation
    console.log('🔗 Tradier Results:');
    console.log('─'.repeat(40));
    const tradierStartTime = Date.now();

    // Use HTTP endpoint to get Tradier results (same way the service is accessed)
    const tradierResponse = await axios.get('http://localhost:3015/gex/levels');
    const tradierResults = tradierResponse.data;
    const tradierCalcTime = Date.now() - tradierStartTime;

    console.log(`  Data Source: Tradier API`);
    console.log(`  Calculation Time: ${tradierCalcTime}ms`);
    console.log(`  NQ Spot: ${tradierResults.nqSpot}`);
    console.log(`  QQQ Spot: ${tradierResults.qqqSpot}`);
    console.log(`  Total GEX: ${tradierResults.totalGex.toFixed(2)}B`);
    console.log(`  Regime: ${tradierResults.regime}`);
    console.log(`  Gamma Flip: ${tradierResults.gammaFlip}`);
    console.log(`  Call Wall: ${tradierResults.callWall}`);
    console.log(`  Put Wall: ${tradierResults.putWall}`);
    console.log(`  Support Levels: [${tradierResults.support.slice(0, 3).join(', ')}...]`);
    console.log(`  Resistance Levels: [${tradierResults.resistance.slice(0, 3).join(', ')}...]`);
    console.log(`  Used Live Prices: ${tradierResults.usedLivePrices}`);
    console.log('');

    // Comparison analysis
    console.log('🔍 Comparison Analysis:');
    console.log('─'.repeat(40));

    const spotDiff = Math.abs(cboeResults.nqSpot - tradierResults.nqSpot);
    const gexDiff = Math.abs(cboeResults.totalGex - tradierResults.totalGex);
    const gammaFlipDiff = Math.abs(cboeResults.gammaFlip - tradierResults.gammaFlip);
    const callWallDiff = Math.abs(cboeResults.callWall - tradierResults.callWall);
    const putWallDiff = Math.abs(cboeResults.putWall - tradierResults.putWall);

    console.log(`  NQ Spot Difference: ${spotDiff.toFixed(2)} points`);
    console.log(`  GEX Difference: ${gexDiff.toFixed(2)}B`);
    console.log(`  Gamma Flip Difference: ${gammaFlipDiff.toFixed(0)} points`);
    console.log(`  Call Wall Difference: ${callWallDiff.toFixed(0)} points`);
    console.log(`  Put Wall Difference: ${putWallDiff.toFixed(0)} points`);
    console.log(`  Regime Match: ${cboeResults.regime === tradierResults.regime ? '✅' : '❌'}`);
    console.log('');

    // Performance comparison
    console.log('⚡ Performance Comparison:');
    console.log('─'.repeat(40));
    console.log(`  CBOE Calculation: ${cboeCalcTime}ms`);
    console.log(`  Tradier Calculation: ${tradierCalcTime}ms`);
    console.log(`  Speed Advantage: ${tradierCalcTime < cboeCalcTime ? 'Tradier' : 'CBOE'} (${Math.abs(cboeCalcTime - tradierCalcTime)}ms faster)`);
    console.log('');

    // Data freshness
    console.log('📅 Data Freshness:');
    console.log('─'.repeat(40));
    console.log(`  CBOE: ${cboeResults.fromCache ? 'Cached data' : 'Fresh data'}`);
    console.log(`  Tradier: ${tradierResults.usedLivePrices ? 'Live prices' : 'Cached prices'}`);
    console.log('');

    // Summary
    console.log('📋 Summary:');
    console.log('─'.repeat(40));
    if (gexDiff < 1.0) {
      console.log('✅ GEX calculations are very close (<1B difference)');
    } else if (gexDiff < 5.0) {
      console.log('⚠️  GEX calculations have moderate differences (1-5B difference)');
    } else {
      console.log('❌ GEX calculations have significant differences (>5B difference)');
    }

    if (gammaFlipDiff < 10) {
      console.log('✅ Gamma flip levels are very close (<10 points difference)');
    } else if (gammaFlipDiff < 50) {
      console.log('⚠️  Gamma flip levels have moderate differences (10-50 points difference)');
    } else {
      console.log('❌ Gamma flip levels have significant differences (>50 points difference)');
    }

    console.log(`\n🎯 Recommended Source: ${tradierResults.usedLivePrices ? 'Tradier (live data)' : 'CBOE (more stable cache)'}`);

  } catch (error) {
    console.error('\n❌ Comparison test failed:', error.message);
    logger.error('GEX comparison error:', error);
  } finally {
    // Cleanup - no need to stop services, using HTTP endpoints
    console.log('\n✅ Comparison test completed');
  }
}

// Export for use as module
export { compareGexSources };

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  compareGexSources()
    .then(() => {
      console.log('\n🎉 GEX comparison finished');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n💥 GEX comparison failed:', error);
      process.exit(1);
    });
}