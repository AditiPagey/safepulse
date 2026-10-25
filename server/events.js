// Helpers for per-event tables. Table names come ONLY from event_index and are regex-checked.
const TABLE_RE = /^ev(sim)?_[a-z0-9_]+$/;

const iso = (d) => (d ? new Date(d).toISOString() : null);
const qi = (t) => `"${t}"`;

async function tableName(q, eventId) {
  const { rows } = await q.query('SELECT table_name FROM event_index WHERE event_id = $1', [eventId]);
  if (!rows[0]) return null;
  const t = rows[0].table_name;
  if (!TABLE_RE.test(t)) throw new Error(`invalid table name: ${t}`);
  return t;
}

// event_index row -> contract "event" object
function eventObject(r) {
  return {
    event_id: r.event_id,
    type: r.type,
    status: r.status,
    center: { lat: r.center_lat, lng: r.center_lng },
    radius_m: r.radius_m,
    opened_at: iso(r.opened_at),
    first_signal_ts: iso(r.first_signal_ts),
    resolved_at: iso(r.resolved_at),
    parent_event_id: r.parent_event_id,
    is_sim: r.is_sim,
    counts: {
      total: r.total, pending: r.pending, safe: r.safe,
      unsafe: r.unsafe, no_response: r.no_response, found_safe: r.found_safe,
    },
    shelters_sent_at: iso(r.shelters_sent_at),
  };
}

// event table row -> contract "case" object
function caseObject(r) {
  return {
    report_id: r.report_id,
    user_short: String(r.user_id || '').slice(-6),
    event_ts: iso(r.event_ts),
    joined_at: iso(r.joined_at),
    lat: r.lat,
    lng: r.lng,
    accuracy_m: r.accuracy_m,
    loc_source: r.loc_source,
    score: r.score,
    status: r.status,
    answer: r.answer,
    answer_ts: iso(r.answer_ts),
    deadline_ts: iso(r.deadline_ts),
    late: r.late,
    shelters_sent_at: iso(r.shelters_sent_at),
    found_safe_at: iso(r.found_safe_at),
  };
}

// Recompute counts from the event table (never increment). q = pool or client.
async function refreshCounts(q, eventId) {
  const t = await tableName(q, eventId);
  if (!t) return null;
  const { rows } = await q.query(`SELECT status, count(*)::int AS n FROM ${qi(t)} GROUP BY status`);
  const c = { pending: 0, safe: 0, unsafe: 0, no_response: 0, found_safe: 0 };
  let total = 0;
  for (const r of rows) { c[r.status] = r.n; total += r.n; }
  const up = await q.query(
    `UPDATE event_index SET total=$2, pending=$3, safe=$4, unsafe=$5, no_response=$6, found_safe=$7
     WHERE event_id=$1 RETURNING *`,
    [eventId, total, c.pending, c.safe, c.unsafe, c.no_response, c.found_safe]
  );
  return up.rows[0] ? eventObject(up.rows[0]) : null;
}

async function logEvent(q, eventId, actor, action, detail) {
  await q.query(
    'INSERT INTO event_log (event_id, actor, action, detail) VALUES ($1,$2,$3,$4)',
    [eventId, actor, action, detail ? JSON.stringify(detail) : null]
  );
}

module.exports = { TABLE_RE, qi, tableName, eventObject, caseObject, refreshCounts, logEvent, iso };
