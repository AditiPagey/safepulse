// POST /api/answers
const express = require('express');
const { z } = require('zod');
const { tx, advisoryLock } = require('./db');
const { phoneAuth } = require('./auth');
const { getSettings } = require('./config');
const { tableName, qi, refreshCounts, caseObject, logEvent } = require('./events');
const sse = require('./sse');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const answerSchema = z.object({
  report_id: z.uuid(),
  user_id: z.uuid().optional(),
  answer: z.enum(['safe', 'help']),
  answer_ts: z.iso.datetime({ offset: true }).optional(),
});

const statusFor = (answer) => (answer === 'safe' ? 'safe' : 'unsafe');

const router = express.Router();

router.post('/api/answers', phoneAuth, wrap(async (req, res) => {
  const b = answerSchema.parse(req.body);
  const userId = req.isSim ? b.user_id : req.user.user_id;
  if (!req.isSim && b.user_id && b.user_id !== req.user.user_id) {
    return res.status(401).json({ error: { code: 'unauthorized', message: 'user_id does not match token' } });
  }

  let answerTs = b.answer_ts ? new Date(b.answer_ts) : new Date();
  if (answerTs.getTime() > Date.now()) answerTs = new Date();

  const emits = [];
  const status = statusFor(b.answer);

  await tx(async (client) => {
    // Same lock the table manager holds while assigning reports to events, so an
    // answer can never slip between "read notification" and "insert case".
    await advisoryLock(client);

    const params = [b.report_id];
    let sql = 'SELECT * FROM notifications WHERE report_id = $1';
    if (userId) { sql += ' AND user_id = $2'; params.push(userId); }
    const { rows } = await client.query(sql, params);
    const n = rows[0];
    // A lone report may already have been flushed from the queue: nothing to record.
    if (!n) return;

    await client.query('UPDATE notifications SET answer = $2, answer_ts = $3 WHERE report_id = $1', [
      b.report_id, b.answer, answerTs.toISOString(),
    ]);

    if (n.event_id) {
      const t = await tableName(client, n.event_id);
      if (t) {
        // Shelters go out automatically when a person is safe: we only record that and when.
        const auto = getSettings().auto_send_shelters !== false;
        const up = await client.query(
          `UPDATE ${qi(t)} SET
             late_answer = late_answer OR status = 'no_response',
             shelters_sent_at = CASE
               WHEN $5::boolean AND $2::text = 'safe' AND status <> 'found_safe' AND shelters_sent_at IS NULL
               THEN now() ELSE shelters_sent_at END,
             status = CASE WHEN status = 'found_safe' THEN status ELSE $2::text END,
             answer = $3, answer_ts = $4
           WHERE report_id = $1 RETURNING *`,
          [b.report_id, status, b.answer, answerTs.toISOString(), auto]
        );
        if (up.rows[0] && up.rows[0].shelters_sent_at) {
          await client.query(
            'UPDATE event_index SET shelters_sent_at = COALESCE(shelters_sent_at, now()) WHERE event_id = $1',
            [n.event_id]
          );
        }
        const ev = await refreshCounts(client, n.event_id);
        await logEvent(client, n.event_id, 'user', 'answer', { report_id: b.report_id, answer: b.answer });
        if (up.rows[0]) emits.push(['case_updated', { event_id: n.event_id, case: caseObject(up.rows[0]) }]);
        if (ev) emits.push(['event_updated', ev]);
      }
    }
  });

  for (const [name, payload] of emits) sse.emit(name, payload);
  res.json({ report_id: b.report_id, status });
}));

module.exports = router;
