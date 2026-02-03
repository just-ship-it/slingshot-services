#!/usr/bin/env node

// Comprehensive analysis of Tradier API options and parameters
import { createLogger } from '../../../shared/index.js';
import TradierClient from './tradier-client.js';
import config from '../utils/config.js';

const logger = createLogger('tradier-api-analysis');

async function analyzeApiOptions() {
  console.log('\n📡 Tradier API Options Analysis');
  console.log('================================\n');

  try {
    // Initialize Tradier client
    const tradierConfig = config.getTradierConfig();
    const tradierClient = new TradierClient({
      accessToken: tradierConfig.accessToken,
      baseUrl: tradierConfig.baseUrl,
      accountId: tradierConfig.accountId
    });

    console.log('🔧 Analyzing API capabilities for QQQ...\n');

    // 1. Get all available expirations
    console.log('📅 Available Expirations:');
    console.log('─'.repeat(30));
    const expirations = await tradierClient.getExpirations('QQQ');

    let expList = [];
    if (expirations?.expirations?.date) {
      expList = Array.isArray(expirations.expirations.date)
        ? expirations.expirations.date
        : [expirations.expirations.date];
    }

    console.log(`Total expirations available: ${expList.length}`);
    console.log(`Nearest 10: ${expList.slice(0, 10).join(', ')}`);
    console.log(`Furthest 5: ${expList.slice(-5).join(', ')}`);
    console.log('');

    // 2. Test different API parameter combinations
    console.log('🔬 Testing API Parameter Options:');
    console.log('─'.repeat(40));

    const testExpiration = expList[0]; // Use nearest expiration
    const testParams = [
      { desc: 'Standard call', params: `symbol=QQQ&expiration=${testExpiration}&greeks=true` },
      { desc: 'Without Greeks', params: `symbol=QQQ&expiration=${testExpiration}&greeks=false` },
      { desc: 'With range param', params: `symbol=QQQ&expiration=${testExpiration}&greeks=true&range=all` },
      { desc: 'With side filter', params: `symbol=QQQ&expiration=${testExpiration}&greeks=true&side=call` },
      { desc: 'Strike range test', params: `symbol=QQQ&expiration=${testExpiration}&greeks=true&strike=620,630` },
    ];

    const results = [];

    for (const test of testParams) {
      try {
        console.log(`Testing: ${test.desc}...`);

        const startTime = Date.now();
        const response = await fetch(`${tradierConfig.baseUrl}/markets/options/chains?${test.params}`, {
          headers: {
            'Authorization': `Bearer ${tradierConfig.accessToken}`,
            'Accept': 'application/json'
          }
        });

        const fetchTime = Date.now() - startTime;
        const data = await response.json();

        const optionsCount = data?.options?.option ?
          (Array.isArray(data.options.option) ? data.options.option.length : 1) : 0;

        results.push({
          test: test.desc,
          status: response.status,
          time: fetchTime,
          optionsCount,
          hasGreeks: data?.options?.option?.[0]?.greeks ? 'Yes' : 'No',
          success: response.ok
        });

        console.log(`  ✅ ${optionsCount} options in ${fetchTime}ms`);

      } catch (error) {
        results.push({
          test: test.desc,
          status: 'Error',
          time: 0,
          optionsCount: 0,
          hasGreeks: 'N/A',
          success: false,
          error: error.message
        });
        console.log(`  ❌ Failed: ${error.message}`);
      }
    }

    console.log('\n📊 Results Summary:');
    console.log('─'.repeat(60));
    results.forEach(result => {
      console.log(`${result.test}: ${result.success ? '✅' : '❌'} ${result.optionsCount} options, ${result.time}ms`);
      if (result.error) console.log(`  Error: ${result.error}`);
    });

    // 3. Compare different expiration strategies
    console.log('\n📈 Expiration Strategy Analysis:');
    console.log('─'.repeat(40));

    const strategies = [
      { name: 'Nearest 3', exps: expList.slice(0, 3) },
      { name: 'Nearest 6', exps: expList.slice(0, 6) },
      { name: 'Nearest 12', exps: expList.slice(0, 12) },
      { name: 'All available', exps: expList }
    ];

    for (const strategy of strategies.slice(0, 3)) { // Limit to avoid rate limits
      console.log(`\n${strategy.name} expirations:`);

      let totalOptions = 0;
      const startTime = Date.now();

      for (const exp of strategy.exps) {
        try {
          const response = await fetch(
            `${tradierConfig.baseUrl}/markets/options/chains?symbol=QQQ&expiration=${exp}&greeks=true`,
            { headers: {
              'Authorization': `Bearer ${tradierConfig.accessToken}`,
              'Accept': 'application/json'
            }}
          );

          if (response.ok) {
            const data = await response.json();
            const count = data?.options?.option ?
              (Array.isArray(data.options.option) ? data.options.option.length : 1) : 0;
            totalOptions += count;
          }

          // Rate limiting
          await new Promise(resolve => setTimeout(resolve, 100));

        } catch (error) {
          console.log(`  Error fetching ${exp}: ${error.message}`);
        }
      }

      const totalTime = Date.now() - startTime;
      console.log(`  Total options: ${totalOptions}`);
      console.log(`  Total time: ${totalTime}ms`);
      console.log(`  Avg per expiration: ${(totalTime / strategy.exps.length).toFixed(0)}ms`);
    }

    // 4. Configuration recommendations
    console.log('\n💡 Configuration Recommendations:');
    console.log('─'.repeat(50));

    const maxOptions = Math.max(...results.filter(r => r.success).map(r => r.optionsCount));
    const fastestTime = Math.min(...results.filter(r => r.success).map(r => r.time));

    console.log('For maximum data coverage (like CBOE):');
    console.log(`  • Increase maxExpirations from 6 to ${Math.min(expList.length, 20)}`);
    console.log(`  • This would get ~${maxOptions * Math.min(expList.length, 20)} options total`);
    console.log(`  • Trade-off: ${Math.min(expList.length, 20) * 100}ms+ fetch time`);

    console.log('\nFor fast actionable data:');
    console.log('  • Keep maxExpirations at 3-6 (current setup)');
    console.log(`  • Focus on nearest expirations (0-30 DTE)`);
    console.log(`  • ~${maxOptions * 6} options in ~600ms`);

    console.log('\nHybrid approach options:');
    console.log('  • Use Tradier for 0-30 DTE (live greeks, fast updates)');
    console.log('  • Use CBOE for 30+ DTE (comprehensive coverage)');
    console.log('  • Combine data sources in exposure calculator');

    // 5. Rate limit analysis
    console.log('\n⚡ Rate Limiting Considerations:');
    console.log('─'.repeat(40));
    console.log(`Current rate limit: ${tradierConfig.symbols.length} symbols × 6 expirations = ${tradierConfig.symbols.length * 6} requests/cycle`);
    console.log(`At 100 requests/minute: ${60 / (tradierConfig.symbols.length * 6)} cycles per minute max`);
    console.log(`Recommended polling: Every ${Math.max(2, Math.ceil((tradierConfig.symbols.length * 6) / 100 * 60))} minutes`);

  } catch (error) {
    console.error('\n❌ Analysis failed:', error.message);
    logger.error('Tradier API analysis error:', error);
  }
}

// Export for use as module
export { analyzeApiOptions };

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  analyzeApiOptions()
    .then(() => {
      console.log('\n🎉 Tradier API analysis completed');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n💥 Tradier API analysis failed:', error);
      process.exit(1);
    });
}