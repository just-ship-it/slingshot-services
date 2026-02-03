#!/usr/bin/env node

/**
 * Debug script to understand why no confluence zones are found
 */

import fs from 'fs';

// Simple CSV parser
function parseCSV(data) {
  const lines = data.trim().split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const values = line.split(',');
    const record = {};
    headers.forEach((header, index) => {
      record[header] = values[index] || '';
    });
    return record;
  });
}

// Read sample data
const gexData = fs.readFileSync('/home/drew/projects/slingshot-services/backtest-engine/data/gex/nq/NQ_gex_levels.csv', 'utf8');
const liquidityData = fs.readFileSync('/home/drew/projects/slingshot-services/backtest-engine/data/liquidity/nq/NQ_liquidity_levels.csv', 'utf8');

const gexRecords = parseCSV(gexData);
const liquidityRecords = parseCSV(liquidityData);

console.log(`📊 Data loaded:`);
console.log(`- GEX records: ${gexRecords.length}`);
console.log(`- Liquidity records: ${liquidityRecords.length}`);

// Check first few days of January 2024
console.log(`\n📅 Sample GEX data (early January 2024):`);
const januaryGex = gexRecords.filter(r => r.date?.startsWith('2024-01')).slice(0, 10);
januaryGex.forEach(record => {
  console.log(`${record.date}: gamma_flip=${record.nq_gamma_flip}, regime=${record.regime}`);
  console.log(`  Put walls: ${record.nq_put_wall_1}, ${record.nq_put_wall_2}, ${record.nq_put_wall_3}`);
  console.log(`  Call walls: ${record.nq_call_wall_1}, ${record.nq_call_wall_2}, ${record.nq_call_wall_3}`);
});

// Check corresponding liquidity data
console.log(`\n📊 Sample Liquidity data (2024-01-02):`);
const jan2Liquidity = liquidityRecords.filter(r => r.datetime?.startsWith('2024-01-02')).slice(0, 5);
jan2Liquidity.forEach(record => {
  console.log(`${record.datetime}: sentiment=${record.sentiment}`);
  console.log(`  Levels: ${record.level_1}, ${record.level_2}, ${record.level_3}, ${record.level_4}, ${record.level_5}`);
});

// Test confluence detection with sample data
function extractGexLevels(gexRecord) {
  const levels = [];

  // Gamma flip level
  if (gexRecord.nq_gamma_flip && !isNaN(parseFloat(gexRecord.nq_gamma_flip))) {
    levels.push({
      type: 'gamma_flip',
      value: parseFloat(gexRecord.nq_gamma_flip),
      importance: 'high'
    });
  }

  // Put walls
  ['nq_put_wall_1', 'nq_put_wall_2', 'nq_put_wall_3'].forEach((key, index) => {
    if (gexRecord[key] && !isNaN(parseFloat(gexRecord[key]))) {
      levels.push({
        type: `put_wall_${index + 1}`,
        value: parseFloat(gexRecord[key]),
        importance: index === 0 ? 'high' : 'medium'
      });
    }
  });

  // Call walls
  ['nq_call_wall_1', 'nq_call_wall_2', 'nq_call_wall_3'].forEach((key, index) => {
    if (gexRecord[key] && !isNaN(parseFloat(gexRecord[key]))) {
      levels.push({
        type: `call_wall_${index + 1}`,
        value: parseFloat(gexRecord[key]),
        importance: index === 0 ? 'high' : 'medium'
      });
    }
  });

  return levels;
}

function extractLdpmLevels(liquidityRecord) {
  const levels = [];

  ['level_1', 'level_2', 'level_3', 'level_4', 'level_5'].forEach((key, index) => {
    if (liquidityRecord[key] && !isNaN(parseFloat(liquidityRecord[key]))) {
      levels.push({
        type: `ldpm_${key}`,
        value: parseFloat(liquidityRecord[key]),
        importance: index < 2 ? 'high' : 'medium',
        sentiment: liquidityRecord.sentiment
      });
    }
  });

  return levels;
}

function findConfluenceZones(gexLevels, ldpmLevels, confluenceThreshold = 50) {
  const zones = [];

  for (const gexLevel of gexLevels) {
    const nearbyLdpmLevels = ldpmLevels.filter(ldpmLevel =>
      Math.abs(gexLevel.value - ldpmLevel.value) <= confluenceThreshold
    );

    if (nearbyLdpmLevels.length > 0) {
      const allLevels = [gexLevel, ...nearbyLdpmLevels];
      const center = allLevels.reduce((sum, level) => sum + level.value, 0) / allLevels.length;

      zones.push({
        center: Math.round(center * 4) / 4, // Round to 0.25
        gexLevel: gexLevel,
        ldpmLevels: nearbyLdpmLevels,
        strength: allLevels.length,
        types: [...new Set([gexLevel.type, ...nearbyLdpmLevels.map(l => l.type)])]
      });
    }
  }

  return zones.sort((a, b) => b.strength - a.strength);
}

// Test with sample data
console.log(`\n🔍 Testing confluence detection:`);

// Use January 2, 2024 GEX record (even without gamma flip)
const jan2GexRecord = gexRecords.find(r => r.date === '2024-01-02');
console.log(`Using GEX record from: ${jan2GexRecord?.date}`);

if (jan2GexRecord) {
  console.log(`GEX data: gamma_flip=${jan2GexRecord.nq_gamma_flip}, regime=${jan2GexRecord.regime}`);
  console.log(`Put walls: ${jan2GexRecord.nq_put_wall_1}, ${jan2GexRecord.nq_put_wall_2}, ${jan2GexRecord.nq_put_wall_3}`);
  console.log(`Call walls: ${jan2GexRecord.nq_call_wall_1}, ${jan2GexRecord.nq_call_wall_2}, ${jan2GexRecord.nq_call_wall_3}`);
}

const validGexRecord = jan2GexRecord;
console.log(`Testing with record from: ${validGexRecord?.date}`);

if (validGexRecord) {
  const gexLevels = extractGexLevels(validGexRecord);
  console.log(`GEX levels found: ${gexLevels.length}`);
  gexLevels.forEach(level => {
    console.log(`  ${level.type}: ${level.value} (${level.importance})`);
  });

  // Use corresponding liquidity data
  const liquidityRecord = liquidityRecords.find(r => r.datetime?.startsWith(validGexRecord.date));
  if (liquidityRecord) {
    const ldpmLevels = extractLdpmLevels(liquidityRecord);
    console.log(`LDPM levels found: ${ldpmLevels.length}`);
    ldpmLevels.forEach(level => {
      console.log(`  ${level.type}: ${level.value} (${level.importance})`);
    });

    // Find confluence
    const confluenceZones = findConfluenceZones(gexLevels, ldpmLevels, 50);
    console.log(`\nConfluence zones found: ${confluenceZones.length}`);
    confluenceZones.forEach((zone, index) => {
      console.log(`  Zone ${index + 1}: center=${zone.center}, strength=${zone.strength}`);
      console.log(`    GEX: ${zone.gexLevel.type}=${zone.gexLevel.value}`);
      console.log(`    LDPM: ${zone.ldpmLevels.map(l => `${l.type}=${l.value}`).join(', ')}`);
    });
  } else {
    console.log('❌ No matching liquidity record found');
  }
} else {
  console.log('❌ No valid GEX record found');
}