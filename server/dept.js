// Department API (X-Dept-Key). Shelters are sent automatically, so there is no send endpoint.
const express = require('express');
const { z } = require('zod');
const { query, tx, advisoryLock } = require('./db');
const { deptAuth } = require('./auth');
const { getSettings, loadSettings } = require('./config');
const { badRequest, notFound, conflict } = require('./errors');
const { tableName, qi, eventObject, caseObject, refreshCounts, logEvent, iso } = require('./events');
const { casesToCsv } = require('./csv');
const sse = require('./sse');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const now = () => new Date().toISOString();

const router = express.Router();
router.use('/api/dept', deptAuth);

router.get('/api/dept/stream', sse.handler);

// ---- summary / lists -------------------------------------------------------

router.get('/api/dept/summary', wrap(async (req, res) => {
  const ev = await query(
    `SELECT count(*) FILTER (WHERE status = 'active')::int AS active_events,
            count(*) FILTER (WHERE status = 'resolved')::int AS resolved_events,
            coalesce(sum(total) FILTER (WHERE status = 'active'), 0)::int AS total,
            coalesce(sum(pending) FILTER (WHERE status = 'active'), 0)::int AS pending,
            coalesce(sum(safe) FILTER (WHERE status = 'active'), 0)::int AS safe,
            coalesce(sum(unsafe) FILTER (WHERE status = 'active'), 0)::int AS unsafe,
            coalesce(sum(no_response) FILTER (WHERE status = 'active'), 0)::int AS no_response,
            coalesce(sum(found_safe) FILTER (WHERE status = 'active'), 0)::int AS found_safe
     FROM event_index`
  );
  const inbox = await query('SELECT count(*)::int AS n FROM notifications WHERE event_id IS NULL AND counted');
  const { active_events, resolved_events, ...totals } = ev.rows[0];
  res.json({ active_events, resolved_events, inbox_size: inbox.rows[0].n, totals, server_time: now() });
}));

router.get('/api/dept/events', wrap(async (req, res) => {
  const status = req.query.status || 'active';
  if (!['active', 'resolved', 'all'].includes(status)) throw badRequest('status must be active, resolved or all');
  const { rows } = await query(
    `SELECT * FROM event_index WHERE ($1 = 'all' OR status = $1) ORDER BY opened_at DESC`,
    [status]
  );
  res.json(rows.map(eventObject));
}));

router.get('/api/dept/events/:event_id', wrap(async (req, res) => {
  const { rows } = await query('SELECT * FROM event_index WHERE event_id = $1', [req.params.event_id]);
  if (!rows[0]) throw notFound('event not found');
  const t = await tableName({ query }, req.params.event_id);
  const cases = await query(`SELECT * FROM ${qi(t)} ORDER BY event_ts, report_id`);
  res.json({ event: eventObject(rows[0]), cases: cases.rows.map(caseObject), server_time: now() });
}));

router.get('/api/dept/events/:event_id/export.csv', wrap(async (req, res) => {
  const t = await tableName({ query }, req.params.event_id);
  if (!t) throw notFound('event not found');
  const cases = await query(`SELECT * FROM ${qi(t)} ORDER BY event_ts, report_id`);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${req.params.event_id}.csv"`);
  res.send(casesToCsv(cases.rows));
}));

router.get('/api/dept/inbox', wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
  const params = [limit];
  let since = '';
  if (req.query.since) {
    const d = new Date(req.query.since);
    if (Number.isNaN(d.getTime())) throw badRequest('since must be an ISO timestamp');
    params.push(d.toISOString());
    since = 'AND received_ts > $2';
  }
  const { rows } = await query(
    `SELECT report_id, event_ts, received_ts, lat, lng, accuracy_m, loc_source, score, counted, is_sim
     FROM notifications WHERE event_id IS NULL AND counted ${since}
     ORDER BY received_ts DESC LIMIT $1`,
    params
  );
  res.json(rows.map((r) => ({ ...r, event_ts: iso(r.event_ts), received_ts: iso(r.received_ts) })));
}));

router.get('/api/dept/shelters', wrap(async (req, res) => {
  const { rows } = await query('SELECT shelter_id, name, address, lat, lng, capacity FROM shelters ORDER BY shelter_id');
  res.json(rows);
}));

// ---- actions ---------------------------------------------------------------

router.post('/api/dept/events/:event_id/cases/:report_id/found-safe', wrap(async (req, res) => {
  const { event_id, report_id } = req.params;
  if (!UUID_RE.test(report_id)) throw notFound('case not found');
  const t = await tableName({ query }, event_id);
  if (!t) throw notFound('event not found');

  const up = await query(
    `UPDATE ${qi(t)} SET status = 'found_safe', found_safe_at = now()
     WHERE report_id = $1 AND status IN ('pending', 'unsafe', 'no_response') RETURNING *`,
    [report_id]
  );
  if (!up.rows[0]) {
    const cur = await query(`SELECT * FROM ${qi(t)} WHERE report_id = $1`, [report_id]);
    if (!cur.rows[0]) throw notFound('case not found');
    if (cur.rows[0].status === 'found_safe') return res.json({ event_id, case: caseObject(cur.rows[0]) });
    throw conflict(`cannot mark found-safe from status '${cur.rows[0].status}'`);
  }
  const ev = await refreshCounts({ query }, event_id);
  await logEvent({ query }, event_id, 'dept', 'found_safe', { report_id });
  const c = caseObject(up.rows[0]);
  sse.emit('case_updated', { event_id, case: c });
  if (ev) sse.emit('event_updated', ev);
  res.json({ event_id, case: c });
}));

const resolveSchema = z.object({ force: z.boolean().optional() });

router.post('/api/dept/events/:event_id/resolve', wrap(async (req, res) => {
  const { force } = resolveSchema.parse(req.body ?? {});
  const id = req.params.event_id;
  const emits = [];
  let event;

  await tx(async (client) => {
    await advisoryLock(client); // no report can join mid-freeze
    const evr = await client.query('SELECT * FROM event_index WHERE event_id = $1', [id]);
    if (!evr.rows[0]) throw notFound('event not found');
    if (evr.rows[0].status === 'resolved') throw conflict('event is already resolved');
    const t = await tableName(client, id);

    // timeout sweep first
    const swept = await client.query(
      `UPDATE ${qi(t)} SET status = 'no_response' WHERE status = 'pending' AND deadline_ts <= now() RETURNING *`
    );
    const pend = await client.query(`SELECT count(*)::int AS n FROM ${qi(t)} WHERE status = 'pending'`);
    const pending = pend.rows[0].n;
    let forced = [];
    if (pending > 0) {
      if (!force) throw conflict(`${pending} case(s) are still pending with time left`, { pending });
      const f = await client.query(
        `UPDATE ${qi(t)} SET status = 'no_response', notes = 'closed early by department'
         WHERE status = 'pending' RETURNING *`
      );
      forced = f.rows;
    }
    await client.query(
      `UPDATE event_index SET status = 'resolved', resolved_at = now(), resolved_by = 'dept' WHERE event_id = $1`,
      [id]
    );
    event = await refreshCounts(client, id);
    await logEvent(client, id, 'dept', 'resolve', { force: !!force, swept: swept.rowCount, forced: forced.length });
    for (const r of [...swept.rows, ...forced]) emits.push(['case_updated', { event_id: id, case: caseObject(r) }]);
    emits.push(['event_updated', event]);
  });

  for (const [name, payload] of emits) sse.emit(name, payload);
  res.json({ event });
}));

// ---- settings ---------------------------------------------------------------

const pos = z.number().positive();
const nn = z.number().min(0);
const ruleSchema = z.strictObject({
  radius_m: pos,
  window_s: pos.max(3600),
  min_count: z.number().int().min(1),
  max_accuracy_m: pos,
});
const settingsSchema = z.strictObject({
  timeout_seconds: z.number().int().min(1).max(7 * 24 * 3600),
  rules: z.strictObject({
    accident: ruleSchema,
    disaster: ruleSchema,
    disaster_pct: z.strictObject({
      enabled: z.boolean(),
      pct: z.number().min(0).max(1),
      min_registered: z.number().int().min(0),
      window_s: pos,
    }),
  }),
  lone_retention_s: z.number().int().min(10),
  auto_send_shelters: z.boolean().default(true),
  dedupe_user_s: nn,
  late_join_hours: nn,
  late_threshold_s: nn,
  shelters_k: z.number().int().min(1).max(8),
  ip_accuracy_m: pos,
  region_accuracy_m: pos,
  min_score: z.number().min(0).max(1),
  cooldown_seconds: nn,
  full_prompt_score: z.number().min(0).max(1),
});

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function deepMerge(a, b) {
  if (!isObj(a) || !isObj(b)) return b;
  const out = { ...a };
  for (const k of Object.keys(b)) out[k] = k in a ? deepMerge(a[k], b[k]) : b[k];
  return out;
}

router.get('/api/dept/settings', (req, res) => res.json(getSettings()));

// Accepts a full or partial settings object (deep-merged over the current one).
router.put('/api/dept/settings', wrap(async (req, res) => {
  if (!isObj(req.body)) throw badRequest('body must be a JSON object');
  const merged = settingsSchema.parse(deepMerge(getSettings(), req.body));
  await query(
    `INSERT INTO settings (key, value) VALUES ('main', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(merged)]
  );
  await loadSettings();
  await logEvent({ query }, null, 'dept', 'settings_updated', req.body);
  sse.emit('settings_updated', merged);
  res.json(merged);
}));

module.exports = router;
