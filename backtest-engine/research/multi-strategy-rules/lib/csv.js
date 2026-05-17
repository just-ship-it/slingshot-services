// Tiny CSV writer. No external deps. Handles quoting for commas, quotes, and newlines.

import fs from 'fs';

function cell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function writeCsv(filePath, header, rows) {
  const lines = [header.map(cell).join(',')];
  for (const row of rows) {
    lines.push(header.map(h => cell(row[h])).join(','));
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}
