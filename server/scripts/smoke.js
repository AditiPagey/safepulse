#!/usr/bin/env node
// End-to-end smoke test with real users/tokens. Needs the server AND the manager running.
// node scripts/smoke.js   (takes ~75 s in DEMO_MODE because it waits for the 60 s timeout)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const crypto = require('crypto');

const BASE = process.env.BASE_URL || `http://localhost:${process.env.PORT || 8080}`;
const KEY = process.env.DEPT_KEY;
const [clat, clng] = (process.env.DEFAULT_CENTER || '34.0522,-118.2437').split(',').map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : extra}`);
  if (!ok) failed++;
};

async function api(method, path, { token, body, headers } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const jitter = (m) => (Math.random() - 0.5) * 2 * (m / 111000);

async function getUser() {
  const r = await api('POST', '/api/users', { body: { home_region: 'sim-region' } });
  return r.body;
}

function mkReport(user, over = {}) {
  return {
    report_id: crypto.randomUUID(), user_id: user.user_id, event_ts: new Date().toISOString(),
    lat: clat - 0.01 + jitter(15), lng: clng - 0.01 + jitter(15), accuracy_m: 12, loc_source: 'gps',
    score: 0.85, peak_g: 2.1, duration_ms: 3800, home_region: 'sim-region', ...over,
  };
}

(async () => {
  console.log('== auth and validation');
  const u0 = await getUser();
  check('POST /api/users returns user_id + token', !!(u0 && u0.user_id && u0.token));
  let r = await api('POST', '/api/reports', { body: mkReport(u0) });
  check('report without token -> 401', r.status === 401, r.status);
  const other = await getUser();
  r = await api('POST', '/api/reports', { token: other.token, body: mkReport(u0) });
  check('user_id not matching token -> 401', r.status === 401, r.status);
  r = await api('POST', '/api/reports', { token: u0.token, body: mkReport(u0, { lat: 123 }) });
  check('lat out of range -> 400', r.status === 400, r.status);
  r = await api('POST', '/api/reports', { token: u0.token, body: mkReport(u0, { lat: 34.0, lng: null }) });
  check('lat without lng -> 400', r.status === 400, r.status);
  r = await api('POST', '/api/reports', { token: u0.token, body: mkReport(u0, { event_ts: new Date(Date.now() - 25 * 3600e3).toISOString() }) });
  check('report older than 24 h -> 422', r.status === 422, r.status);

  console.log('== E2E-1/2/4: four phones, one incident');
  const users = [];
  const reports = [];
  for (let i = 0; i < 4; i++) {
    const u = await getUser();
    users.push(u);
    const rep = mkReport(u);
    reports.push(rep);
    r = await api('POST', '/api/reports', { token: u.token, body: rep });
    check(`report ${i + 1} accepted (202, event_id null at intake)`, r.status === 202 && r.body.event_id === null, JSON.stringify(r.body));
    if (i === 0) {
      const again = await api('POST', '/api/reports', { token: u.token, body: rep });
      check('same report_id again -> duplicate:true', again.status === 200 && again.body.duplicate === true, JSON.stringify(again.body));
    }
    await sleep(400);
  }
  await sleep(3500);
  const cs = [];
  for (let i = 0; i < 4; i++) cs.push((await api('GET', `/api/cases/${reports[i].report_id}`, { token: users[i].token })).body);
  const evId = cs[0] && cs[0].event_id;
  check('all four cases carry the same event_id', !!evId && cs.every((c) => c && c.event_id === evId), JSON.stringify(cs.map((c) => c && c.event_id)));
  check('cases start pending', cs.every((c) => c && c.status === 'pending'));
  r = await api('GET', `/api/cases/${reports[0].report_id}`, { token: users[1].token });
  check("another user cannot read someone else's case -> 404", r.status === 404, r.status);

  r = await api('POST', '/api/answers', { token: users[0].token, body: { report_id: reports[0].report_id, user_id: users[0].user_id, answer: 'safe' } });
  check('answer safe -> status safe', r.status === 200 && r.body.status === 'safe', JSON.stringify(r.body));
  r = await api('POST', '/api/answers', { token: users[1].token, body: { report_id: reports[1].report_id, user_id: users[1].user_id, answer: 'help' } });
  check('answer help -> status unsafe', r.status === 200 && r.body.status === 'unsafe', JSON.stringify(r.body));
  r = await api('POST', '/api/answers', { token: users[0].token, body: { report_id: reports[0].report_id, user_id: users[0].user_id, answer: 'nope' } });
  check('bad answer value -> 400', r.status === 400, r.status);

  let c0 = (await api('GET', `/api/cases/${reports[0].report_id}`, { token: users[0].token })).body;
  let c1 = (await api('GET', `/api/cases/${reports[1].report_id}`, { token: users[1].token })).body;
  check('case reflects safe / unsafe', c0.status === 'safe' && c1.status === 'unsafe', `${c0.status} ${c1.status}`);

  console.log('== E2E-5/7: timeout, then late answer (waiting ~65 s)');
  await sleep(65000);
  const c2 = (await api('GET', `/api/cases/${reports[2].report_id}`, { token: users[2].token })).body;
  check('unanswered case becomes no_response after the deadline', c2.status === 'no_response', c2.status);
  const stillSafe = (await api('GET', `/api/cases/${reports[0].report_id}`, { token: users[0].token })).body;
  check('answered case is not touched by the watcher', stillSafe.status === 'safe', stillSafe.status);
  r = await api('POST', '/api/answers', { token: users[2].token, body: { report_id: reports[2].report_id, user_id: users[2].user_id, answer: 'safe' } });
  const c2b = (await api('GET', `/api/cases/${reports[2].report_id}`, { token: users[2].token })).body;
  check('late answer from no_response -> safe', r.status === 200 && c2b.status === 'safe', c2b.status);

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('smoke failed:', e); process.exit(1); });
