// GET /api/cases/:report_id
const express = require('express');
const { query } = require('./db');
const { getEffective } = require('./config');
const { phoneAuth } = require('./auth');
const { notFound } = require('./errors');
const { tableName, qi, iso } = require('./events');
const { nearest } = require('./shelters');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const router = express.Router();

router.get('/api/cases/:report_id', phoneAuth, wrap(async (req, res) => {
  const id = req.params.report_id;
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('case not found');

  const params = [id];
  let sql = 'SELECT * FROM notifications WHERE report_id = $1';
  if (!req.isSim) { sql += ' AND user_id = $2'; params.push(req.user.user_id); }
  const { rows } = await query(sql, params);
  const n = rows[0];
  if (!n) throw notFound('case not found');

  if (n.event_id) {
    const t = await tableName({ query }, n.event_id);
    if (t) {
      const r = await query(`SELECT * FROM ${qi(t)} WHERE report_id = $1`, [id]);
      const c = r.rows[0];
      if (c) {
        // Shelters were "sent" automatically when the person was safe; compute the list now.
        const shelters = c.shelters_sent_at && c.lat != null ? await nearest(c.lat, c.lng) : null;
        return res.json({
          report_id: id,
          status: c.status,
          event_id: n.event_id,
          deadline_ts: iso(c.deadline_ts),
          answer: c.answer,
          shelters,
          shelters_sent_at: iso(c.shelters_sent_at),
          found_safe_at: iso(c.found_safe_at),
        });
      }
    }
  }

  // Not (yet) part of an event: derive from the notification.
  const deadline = new Date(new Date(n.event_ts).getTime() + getEffective().timeout_seconds * 1000);
  let status = 'pending';
  if (n.answer) status = n.answer === 'safe' ? 'safe' : 'unsafe';
  else if (deadline.getTime() <= Date.now()) status = 'no_response';
  res.json({
    report_id: id,
    status,
    event_id: null,
    deadline_ts: deadline.toISOString(),
    answer: n.answer,
    shelters: null,
    shelters_sent_at: null,
    found_safe_at: null,
  });
}));

module.exports = router;
