const { iso } = require('./events');

const COLUMNS = [
  'report_id', 'user_id', 'event_ts', 'joined_at', 'lat', 'lng', 'accuracy_m', 'loc_source', 'score',
  'status', 'answer', 'answer_ts', 'deadline_ts', 'late', 'late_answer', 'shelters_sent_at', 'found_safe_at',
];

const DATE_COLS = new Set(['event_ts', 'joined_at', 'answer_ts', 'deadline_ts', 'shelters_sent_at', 'found_safe_at']);

function cell(col, v) {
  if (v === null || v === undefined) return '';
  let s = DATE_COLS.has(col) ? iso(v) : String(v);
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function casesToCsv(rows) {
  const lines = [COLUMNS.join(',')];
  for (const r of rows) lines.push(COLUMNS.map((c) => cell(c, r[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

module.exports = { casesToCsv, COLUMNS };
