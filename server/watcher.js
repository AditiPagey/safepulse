// Timeout sweep: pending cases past their deadline become no_response.
const { query } = require('./db');
const { getSettings } = require('./config');
const { tableName, qi, refreshCounts, caseObject, logEvent } = require('./events');
const sse = require('./sse');

const INTERVAL_MS = Number(process.env.WATCH_INTERVAL_MS) || 5000;
let running = false;

async function sweepEvent(eventId) {
  const t = await tableName({ query }, eventId);
  if (!t) return 0;
  const { rows } = await query(
    `UPDATE ${qi(t)} SET status = 'no_response'
     WHERE status = 'pending' AND deadline_ts <= now() RETURNING *`
  );
  if (!rows.length) return 0;
  const ev = await refreshCounts({ query }, eventId);
  await logEvent({ query }, eventId, 'system', 'timeout', { count: rows.length });
  for (const r of rows) sse.emit('case_updated', { event_id: eventId, case: caseObject(r) });
  if (ev) sse.emit('event_updated', ev);
  return rows.length;
}

async function sweepAll() {
  const hours = getSettings().late_join_hours || 24;
  const { rows } = await query(
    `SELECT event_id FROM event_index
     WHERE status = 'active' OR (status = 'resolved' AND resolved_at > now() - make_interval(hours => $1))`,
    [hours]
  );
  for (const r of rows) await sweepEvent(r.event_id);
}

function start() {
  setInterval(async () => {
    if (running) return;
    running = true;
    try { await sweepAll(); } catch (e) { console.error('watcher error:', e.message); } finally { running = false; }
  }, INTERVAL_MS).unref();
}

module.exports = { start, sweepEvent, sweepAll };
