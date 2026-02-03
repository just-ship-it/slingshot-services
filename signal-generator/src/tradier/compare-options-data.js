#!/usr/bin/env node

// Compare raw options chain data between CBOE and Tradier sources
import { createLogger } from '../../../shared/index.js';
import TradierClient from './tradier-client.js';
import GexCalculator from '../gex/gex-calculator.js';
import config from '../utils/config.js';

const logger = createLogger('data-comparison');

async function compareOptionsData() {
  console.log('\n📊 Options Data Source Comparison');
  console.log('==================================\n');

  try {
    // Initialize both data sources
    console.log('🔧 Initializing data sources...');

    // CBOE calculator
    const cboeCalculator = new GexCalculator();

    // Tradier client
    const tradierConfig = config.getTradierConfig();
    const tradierClient = new TradierClient({
      accessToken: tradierConfig.accessToken,
      baseUrl: tradierConfig.baseUrl,
      accountId: tradierConfig.accountId
    });

    console.log('✅ Both sources initialized\n');

    // Fetch data from both sources
    console.log('📥 Fetching options data from both sources...');

    // CBOE data
    console.log('📊 Fetching CBOE data for QQQ...');
    const cboeStartTime = Date.now();
    const cboeData = await cboeCalculator.fetchCBOEOptions();
    const cboeFetchTime = Date.now() - cboeStartTime;
    console.log(`✅ CBOE data fetched in ${cboeFetchTime}ms`);

    // Tradier data (get from running service)
    console.log('🔗 Getting Tradier data from running service...');
    const tradierStartTime = Date.now();

    const axios = (await import('axios')).default;
    const tradierResponse = await axios.get('http://localhost:3015/tradier/status');

    if (!tradierResponse.data.active) {
      throw new Error('Tradier service not active');
    }

    // Get cached chain data from the service
    const chainsResponse = await axios.get('http://localhost:3015/tradier/chains');
    const tradierData = chainsResponse.data.QQQ || {};

    const tradierFetchTime = Date.now() - tradierStartTime;
    console.log(`✅ Tradier data retrieved from cache in ${tradierFetchTime}ms\n`);

    // Compare basic metrics
    console.log('📈 Basic Data Comparison:');
    console.log('─'.repeat(50));

    // CBOE structure
    const cboeSpot = cboeData.data?.close;
    const cboeOptions = cboeData.data?.options || [];
    console.log(`CBOE Spot Price: ${cboeSpot}`);
    console.log(`CBOE Options Count: ${cboeOptions.length}`);

    // Tradier structure (flattened array of options from all expirations)
    let tradierSpot = null;
    let tradierOptions = [];

    // QQQ data is an array of expiration objects
    if (Array.isArray(tradierData) && tradierData.length > 0) {
      // Get spot price from first expiration
      tradierSpot = tradierData[0].underlying?.last;

      // Flatten all options from all expirations
      tradierData.forEach(expiration => {
        if (expiration.options && Array.isArray(expiration.options)) {
          tradierOptions = tradierOptions.concat(expiration.options);
        }
      });
    }
    console.log(`Tradier Spot Price: ${tradierSpot}`);
    console.log(`Tradier Options Count: ${tradierOptions.length}`);
    console.log('');

    // Compare option samples
    console.log('🔍 Sample Options Comparison:');
    console.log('─'.repeat(50));

    // Find some common strikes for comparison
    const cboeStrikes = new Set();
    const tradierStrikes = new Set();

    // Parse CBOE strikes
    cboeOptions.forEach(opt => {
      if (opt.option) {
        try {
          const parsed = cboeCalculator.parseOptionSymbol(opt.option);
          cboeStrikes.add(parsed.strike);
        } catch (e) {
          // Skip invalid options
        }
      }
    });

    // Parse Tradier strikes
    tradierOptions.forEach(opt => {
      if (opt.strike) {
        tradierStrikes.add(parseFloat(opt.strike));
      }
    });

    console.log(`CBOE Strike Range: ${Math.min(...cboeStrikes).toFixed(0)} - ${Math.max(...cboeStrikes).toFixed(0)}`);
    console.log(`Tradier Strike Range: ${Math.min(...tradierStrikes).toFixed(0)} - ${Math.max(...tradierStrikes).toFixed(0)}`);

    // Find common strikes
    const commonStrikes = [...cboeStrikes].filter(strike => tradierStrikes.has(strike));
    console.log(`Common Strikes: ${commonStrikes.length} out of ${Math.max(cboeStrikes.size, tradierStrikes.size)} total`);
    console.log('');

    // Detailed comparison for a few strikes
    console.log('📋 Detailed Strike-by-Strike Comparison:');
    console.log('─'.repeat(80));

    // Pick 5 strikes around the spot price for detailed comparison
    const spotPrice = cboeSpot || tradierSpot;
    const nearStrikes = commonStrikes
      .filter(strike => Math.abs(strike - spotPrice) < 50)
      .sort((a, b) => Math.abs(a - spotPrice) - Math.abs(b - spotPrice))
      .slice(0, 5);

    for (const strike of nearStrikes) {
      console.log(`\n💰 Strike: $${strike}`);
      console.log('─'.repeat(40));

      // Find CBOE options at this strike
      const cboeAtStrike = cboeOptions.filter(opt => {
        if (!opt.option) return false;
        try {
          const parsed = cboeCalculator.parseOptionSymbol(opt.option);
          return Math.abs(parsed.strike - strike) < 0.01;
        } catch (e) {
          return false;
        }
      });

      // Find Tradier options at this strike
      const tradierAtStrike = tradierOptions.filter(opt => {
        return Math.abs(parseFloat(opt.strike) - strike) < 0.01;
      });

      console.log(`CBOE Options: ${cboeAtStrike.length}`);
      console.log(`Tradier Options: ${tradierAtStrike.length}`);

      // Compare calls and puts separately
      ['call', 'put'].forEach(optType => {
        const cboeType = cboeAtStrike.filter(opt => {
          try {
            const parsed = cboeCalculator.parseOptionSymbol(opt.option);
            return parsed.optType === optType;
          } catch (e) {
            return false;
          }
        });

        const tradierType = tradierAtStrike.filter(opt => {
          return opt.option_type === (optType === 'call' ? 'call' : 'put');
        });

        if (cboeType.length > 0 && tradierType.length > 0) {
          const cboeOpt = cboeType[0];
          const tradierOpt = tradierType[0];

          console.log(`\n  ${optType.toUpperCase()}S:`);
          console.log(`    CBOE - OI: ${cboeOpt.open_interest || 'N/A'}, IV: ${(cboeOpt.iv * 100).toFixed(1) || 'N/A'}%`);
          console.log(`    Tradier - OI: ${tradierOpt.open_interest || 'N/A'}, IV: ${(tradierOpt.greeks?.smv_vol * 100).toFixed(1) || 'N/A'}%`);

          // Calculate differences
          const oiDiff = Math.abs((cboeOpt.open_interest || 0) - (tradierOpt.open_interest || 0));
          const ivDiff = Math.abs((cboeOpt.iv || 0) - (tradierOpt.greeks?.smv_vol || 0));

          if (oiDiff > 1000) {
            console.log(`    ⚠️  Large OI difference: ${oiDiff.toFixed(0)}`);
          }
          if (ivDiff > 0.05) {
            console.log(`    ⚠️  Large IV difference: ${(ivDiff * 100).toFixed(1)}%`);
          }
        }
      });
    }

    // Compare data freshness
    console.log('\n\n📅 Data Freshness Comparison:');
    console.log('─'.repeat(50));

    // CBOE timestamp
    const cboeTimestamp = cboeData.data?.timestamp || cboeData.timestamp;
    console.log(`CBOE Data Timestamp: ${cboeTimestamp || 'Not available'}`);

    // Tradier timestamp
    const tradierTimestamp = tradierData.options?.underlying?.last_trade_time;
    console.log(`Tradier Data Timestamp: ${tradierTimestamp || 'Not available'}`);

    // Performance comparison
    console.log('\n⚡ Performance Comparison:');
    console.log('─'.repeat(50));
    console.log(`CBOE Fetch Time: ${cboeFetchTime}ms`);
    console.log(`Tradier Fetch Time: ${tradierFetchTime}ms`);
    console.log(`Speed Advantage: ${tradierFetchTime < cboeFetchTime ? 'Tradier' : 'CBOE'} (${Math.abs(cboeFetchTime - tradierFetchTime)}ms faster)`);

    // Summary of key differences
    console.log('\n📋 Key Differences Summary:');
    console.log('─'.repeat(50));

    const optionCountDiff = Math.abs(cboeOptions.length - tradierOptions.length);
    const spotDiff = Math.abs((cboeSpot || 0) - (tradierSpot || 0));

    if (optionCountDiff > 100) {
      console.log(`⚠️  Significant difference in options count: ${optionCountDiff}`);
    }

    if (spotDiff > 1) {
      console.log(`⚠️  Spot price difference: $${spotDiff.toFixed(2)}`);
    }

    const strikeCoverage = (commonStrikes.length / Math.max(cboeStrikes.size, tradierStrikes.size)) * 100;
    console.log(`📊 Strike price overlap: ${strikeCoverage.toFixed(1)}%`);

    if (strikeCoverage < 80) {
      console.log('⚠️  Low strike price overlap - different option series covered');
    }

  } catch (error) {
    console.error('\n❌ Data comparison failed:', error.message);
    logger.error('Options data comparison error:', error);
  }
}

// Export for use as module
export { compareOptionsData };

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  compareOptionsData()
    .then(() => {
      console.log('\n🎉 Options data comparison completed');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n💥 Options data comparison failed:', error);
      process.exit(1);
    });
}