// POST /api/reports: validate, dedupe, resolve location, store in the queue.
// Grouping into events is done by the Python table manager, not here.
const crypto = require('crypto');
const express = require('express');
const { z } = require('zod');
const { query } = require('./db');
const { getEffective } = require('./config');
const { phoneAuth } = require('./auth');
const { unauthorized, unprocessable, AppError } = require('./errors');
const { resolveLocation, cleanIp } = require('./location');
const sse = require('./sse');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const num = (min, max) => {
  let s = z.number();
  if (min != null) s = s.min(min);
  if (max != null) s = s.max(max);
  return s.nullish();
};

const reportSchema = z
  .object({
    report_id: z.uuid(),
    user_id: z.uuid().optional(),
    event_ts: z.iso.datetime({ offset: true }),
    lat: num(-90, 90),
    lng: num(-180, 180),
    accuracy_m: num(0, null),
    loc_source: z.enum(['gps', 'none']).nullish(),
    score: z.number().min(0).max(1),
    peak_g: num(0, null),
    duration_ms: z.number().int().min(0).nullish(),
    home_region: z.string().min(1).nullish(),
    sim_ip: z.string().nullish(),
  })
  .refine((b) => (b.lat == null) === (b.lng == null), { message: 'lat and lng must both be set or both null' });

// Simple per-IP limiter: 60 requests / minute on /api/reports (simulator bypasses).
const hits = new Map();
function rateLimit(req, res, next) {
  if (req.isSim) return next();
  const now = Date.now();
  const key = req.ip;
  const arr = (hits.get(key) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(key, arr);
  if (arr.length > 60) return next(new AppError('rate_limited', 'too many reports, slow down'));
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (!v.some((t) => now - t < 60000)) hits.delete(k);
}, 60000).unref();

const respond = (row, eventTimeoutS, duplicate) => ({
  report_id: row.report_id,
  received_at: new Date(row.received_ts).toISOString(),
  deadline_ts: new Date(new Date(row.event_ts).getTime() + eventTimeoutS * 1000).toISOString(),
  event_id: row.event_id || null,
  duplicate,
  counted: row.counted,
});

const router = express.Router();

router.post('/api/reports', phoneAuth, rateLimit, wrap(async (req, res) => {
  const b = reportSchema.parse(req.body);
  const settings = getEffective();
  const timeoutS = settings.timeout_seconds;

  // Identity
  let userId = b.user_id;
  if (req.isSim) {
    userId = userId || crypto.randomUUID();
  } else if (!userId || userId !== req.user.user_id) {
    throw unauthorized('user_id does not match token');
  }

  // Time handling
  const now = Date.now();
  let eventTs = new Date(b.event_ts).getTime();
  let clockSkew = false;
  if (eventTs - now > 60000) { eventTs = now; clockSkew = true; }
  if (now - eventTs > 24 * 3600 * 1000) throw unprocessable('event_ts is older than 24 h');

  // Idempotency
  const dupe = await query('SELECT * FROM notifications WHERE report_id = $1', [b.report_id]);
  if (dupe.rows[0]) return res.status(200).json(respond(dupe.rows[0], timeoutS, true));

  // Counted flags
  let counted = true;
  let duplicateUser = false;
  if (b.score < settings.min_score) counted = false;
  const ud = await query(
    `SELECT 1 FROM notifications
     WHERE user_id = $1 AND abs(extract(epoch FROM (event_ts - $2::timestamptz))) < $3 LIMIT 1`,
    [userId, new Date(eventTs).toISOString(), settings.dedupe_user_s]
  );
  if (ud.rows[0]) { counted = false; duplicateUser = true; }

  // Location: gps -> ip -> region
  const homeRegion = b.home_region || (req.user && req.user.home_region) || null;
  const senderIp = cleanIp(req.isSim ? (b.sim_ip || null) : req.ip);
  const loc = await resolveLocation(
    { lat: b.lat, lng: b.lng, accuracy_m: b.accuracy_m, ip: senderIp, home_region: homeRegion },
    settings
  );
  if (!loc) counted = false;

  const ins = await query(
    `INSERT INTO notifications
       (report_id, user_id, event_ts, lat, lng, accuracy_m, loc_source, score, peak_g, duration_ms,
        home_region, sender_ip, counted, duplicate_user, clock_skew, is_sim)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (report_id) DO NOTHING
     RETURNING *`,
    [
      b.report_id, userId, new Date(eventTs).toISOString(),
      loc ? loc.lat : null, loc ? loc.lng : null, loc ? loc.accuracy_m : null, loc ? loc.loc_source : null,
      b.score, b.peak_g ?? null, b.duration_ms ?? null,
      homeRegion, senderIp, counted, duplicateUser, clockSkew, !!req.isSim,
    ]
  );
  if (!ins.rows[0]) {
    // lost a race with an identical request
    const again = await query('SELECT * FROM notifications WHERE report_id = $1', [b.report_id]);
    return res.status(200).json(respond(again.rows[0], timeoutS, true));
  }
  const row = ins.rows[0];

  sse.emit('notification', {
    report_id: row.report_id,
    event_ts: new Date(row.event_ts).toISOString(),
    received_ts: new Date(row.received_ts).toISOString(),
    lat: row.lat,
    lng: row.lng,
    accuracy_m: row.accuracy_m,
    loc_source: row.loc_source,
    score: row.score,
    counted: row.counted,
    is_sim: row.is_sim,
  });

  res.status(202).json(respond(row, timeoutS, false));
}));

module.exports = router;
