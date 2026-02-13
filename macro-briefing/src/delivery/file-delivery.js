import { writeFile, readFile, copyFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../../../shared/index.js';

const logger = createLogger('file-delivery');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.join(__dirname, '../../reports');
const BACKTEST_BRIEFINGS_DIR = path.join(__dirname, '../../../backtest-engine/data/briefings');
const PRIOR_SUMMARY_FILE = path.join(REPORTS_DIR, '.prior-summary.json');

/**
 * Save the briefing report as markdown
 */
export async function save(report) {
  await mkdir(REPORTS_DIR, { recursive: true });

  const filename = `${report.date}.md`;
  const filepath = path.join(REPORTS_DIR, filename);
  const latestPath = path.join(REPORTS_DIR, 'latest.md');

  // Write dated file
  const header = `<!-- Generated: ${report.generatedAt} | Time: ${report.generationTimeMs}ms -->\n\n`;
  await writeFile(filepath, header + report.fullReport, 'utf-8');

  // Write latest copy
  await writeFile(latestPath, header + report.fullReport, 'utf-8');

  // Save full JSON to backtest data directory
  try {
    await mkdir(BACKTEST_BRIEFINGS_DIR, { recursive: true });
    const jsonPath = path.join(BACKTEST_BRIEFINGS_DIR, `${report.date}.json`);
    await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf-8');
    logger.info(`Saved backtest briefing JSON to ${jsonPath}`);
  } catch (err) {
    logger.warn('Failed to save backtest briefing JSON:', err.message);
  }

  // Save executive summary for next day's continuity prompt
  try {
    // Extract first section's executive summary (rough heuristic)
    const summaryMatch = report.fullReport.match(/## Bottom Line[\s\S]*?(?=\n---|\n##|$)/i)
      || report.fullReport.match(/\*\*Bottom Line\*\*[\s\S]*?(?=\n---|\n##|$)/i);
    const summary = summaryMatch ? summaryMatch[0].trim() : null;

    if (summary) {
      await writeFile(PRIOR_SUMMARY_FILE, JSON.stringify({
        date: report.date,
        summary
      }), 'utf-8');
    }
  } catch (err) {
    logger.warn('Failed to save prior summary:', err.message);
  }

  logger.info(`Saved briefing to ${filepath}`);
  return `saved to ${filename}`;
}

/**
 * Load the prior day's executive summary for narrative continuity
 */
export async function loadPriorSummary() {
  try {
    if (!existsSync(PRIOR_SUMMARY_FILE)) return null;
    const raw = await readFile(PRIOR_SUMMARY_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return data.summary || null;
  } catch {
    return null;
  }
}
