const crypto = require('crypto');
const { query } = require('./db');
const { env } = require('./config');
const { unauthorized } = require('./errors');

function safeEq(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

// Phone: Authorization: Bearer <token>. Sets req.user = {user_id, home_region}.
// If X-Sim-Key matches, skip user lookup and set req.isSim = true.
async function phoneAuth(req, res, next) {
  try {
    const simKey = req.get('X-Sim-Key');
    if (simKey) {
      if (!safeEq(simKey, env.SIM_KEY)) throw unauthorized('invalid sim key');
      req.isSim = true;
      return next();
    }
    const m = /^Bearer\s+(.+)$/i.exec(req.get('Authorization') || '');
    if (!m) throw unauthorized('missing bearer token');
    const { rows } = await query('SELECT user_id, home_region FROM users WHERE token = $1', [m[1].trim()]);
    if (!rows[0]) throw unauthorized('invalid token');
    req.user = rows[0];
    next();
  } catch (e) {
    next(e);
  }
}

// Dashboard: X-Dept-Key header, or ?key= for SSE (EventSource cannot set headers).
function deptAuth(req, res, next) {
  const key = req.get('X-Dept-Key') || req.query.key;
  if (!safeEq(key, env.DEPT_KEY)) return next(unauthorized('invalid dept key'));
  next();
}

module.exports = { phoneAuth, deptAuth, safeEq };
