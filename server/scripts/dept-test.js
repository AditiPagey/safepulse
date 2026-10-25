#!/usr/bin/env node
// Department API test (E2E-6/8/9/10, settings, CSV). Needs server AND manager running.
// node scripts/dept-test.js   (about 15 s)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const crypto = require('crypto');

const BASE = process.env.BASE_URL || `http://localhost:${process.env.PORT || 8080}`;
const DEPT = process.env.DEPT_KEY;
const SIM = process.env.SIM_KEY;
const [clat, clng] = (process.env.DEFAULT_CENTER || '34.0522,-118.2437').split(',').map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : extra}`);
  if (!ok) failed++;
};

async function call(method, path, { body, dept = true, sim = false, raw = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (dept) headers['X-Dept-Key'] = DEPT;
  if (sim) headers['X-Sim-Key'] = SIM;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: raw ? await res.text() : await res.json().catch(() => null), res };
}
const jitter = (m) => (Math.random() - 0.5) * 2 * (m / 111000);

function rep(over = {}) {
  return {
    report_id: crypto.randomUUID(), user_id: crypto.randomUUID(), event_ts: new Date().toISOString(),
    lat: clat + 0.02 + jitter(15), lng: clng + 0.02 + jitter(15), accuracy_m: 12, loc_source: 'gps',
    score: 0.9, home_region: 'sim-region', ...over,
  };
}

(async () => {
  console.log('== auth');
  let r = await call('GET', '/api/dept/summary', { dept: false });
  check('no dept key -> 401', r.status === 401, r.status);
  r = await call('GET', '/api/dept/summary');
  check('summary ok', r.status === 200 && 'active_events' in r.body && 'inbox_size' in r.body && r.body.totals, JSON.stringify(r.body));
  r = await call('GET', '/api/dept/shelters');
  check('shelters list has 8', r.status === 200 && r.body.length === 8, JSON.stringify(r.body).slice(0, 80));

  console.log('== create an incident (4 sim reports)');
  const reports = [];
  for (let i = 0; i < 4; i++) {
    const x = rep();
    reports.push(x);
    await call('POST', '/api/reports', { body: x, dept: false, sim: true });
    await sleep(300);
  }
  await sleep(3500);
  const list = await call('GET', '/api/dept/events?status=active');
  const ev = list.body && list.body.find((e) => e.counts.total >= 4);
  check('events?status=active lists the new accident', !!ev && ev.type === 'accident', JSON.stringify(list.body));
  if (!ev) process.exit(1);
  const id = ev.event_id;
  r = await call('GET', '/api/dept/events?status=bogus');
  check('events?status=bogus -> 400', r.status === 400, r.status);
  r = await call('GET', `/api/dept/events/${id}`);
  check('event detail has event + 4 cases + server_time', r.status === 200 && r.body.cases.length === 4 && r.body.server_time && r.body.event.event_id === id, r.status);
  r = await call('GET', '/api/dept/events/ev_nope');
  check('unknown event -> 404', r.status === 404, r.status);
  r = await call('GET', '/api/dept/inbox?limit=5');
  check('inbox ok (array)', r.status === 200 && Array.isArray(r.body), r.status);

  console.log('== E2E-6 shelters are sent automatically when safe');
  let c0 = (await call('GET', `/api/cases/${reports[0].report_id}`, { dept: false, sim: true })).body;
  check('before answering: shelters null', c0.shelters === null && c0.shelters_sent_at === null, JSON.stringify(c0));
  await call('POST', '/api/answers', { body: { report_id: reports[0].report_id, user_id: reports[0].user_id, answer: 'safe' }, dept: false, sim: true });
  await call('POST', '/api/answers', { body: { report_id: reports[1].report_id, user_id: reports[1].user_id, answer: 'help' }, dept: false, sim: true });
  c0 = (await call('GET', `/api/cases/${reports[0].report_id}`, { dept: false, sim: true })).body;
  check('safe person: 3 nearest shelters, sorted by distance', Array.isArray(c0.shelters) && c0.shelters.length === 3 &&
    c0.shelters[0].distance_m <= c0.shelters[1].distance_m && c0.shelters[1].distance_m <= c0.shelters[2].distance_m && !!c0.shelters_sent_at, JSON.stringify(c0));
  const c1 = (await call('GET', `/api/cases/${reports[1].report_id}`, { dept: false, sim: true })).body;
  check('help person: no shelters', c1.status === 'unsafe' && c1.shelters === null, JSON.stringify(c1));
  r = await call('GET', `/api/dept/events/${id}`);
  const row0 = r.body.cases.find((c) => c.report_id === reports[0].report_id);
  check('dashboard sees shelters_sent_at (case + event)', !!row0.shelters_sent_at && !!r.body.event.shelters_sent_at, JSON.stringify(row0));

  console.log('== found-safe');
  r = await call('POST', `/api/dept/events/${id}/cases/${reports[1].report_id}/found-safe`);
  check('unsafe -> found_safe', r.status === 200 && r.body.case.status === 'found_safe' && !!r.body.case.found_safe_at, JSON.stringify(r.body));
  r = await call('POST', `/api/dept/events/${id}/cases/${reports[1].report_id}/found-safe`);
  check('found-safe again is idempotent (200)', r.status === 200, r.status);
  r = await call('POST', `/api/dept/events/${id}/cases/${reports[0].report_id}/found-safe`);
  check('safe -> found-safe is refused (409)', r.status === 409, r.status);
  r = await call('POST', `/api/dept/events/${id}/cases/${crypto.randomUUID()}/found-safe`);
  check('unknown case -> 404', r.status === 404, r.status);
  await call('POST', '/api/answers', { body: { report_id: reports[1].report_id, user_id: reports[1].user_id, answer: 'help' }, dept: false, sim: true });
  r = await call('GET', `/api/dept/events/${id}`);
  check('found_safe is terminal (later answer does not change it)', r.body.cases.find((c) => c.report_id === reports[1].report_id).status === 'found_safe');
  check('counts recomputed (found_safe=1, safe=1, pending=2)', r.body.event.counts.found_safe === 1 && r.body.event.counts.safe === 1 && r.body.event.counts.pending === 2, JSON.stringify(r.body.event.counts));

  console.log('== E2E-8 resolve');
  r = await call('POST', `/api/dept/events/${id}/resolve`, { body: {} });
  check('resolve with pending -> 409 {pending:2}', r.status === 409 && r.body.error.pending === 2, JSON.stringify(r.body));
  r = await call('GET', `/api/dept/events/${id}`);
  check('event still active after 409', r.body.event.status === 'active');
  r = await call('POST', `/api/dept/events/${id}/resolve`, { body: { force: true } });
  check('resolve force -> 200, resolved', r.status === 200 && r.body.event.status === 'resolved' && r.body.event.counts.pending === 0 && r.body.event.counts.no_response === 2, JSON.stringify(r.body));
  r = await call('POST', `/api/dept/events/${id}/resolve`, { body: { force: true } });
  check('resolve twice -> 409', r.status === 409, r.status);
  r = await call('GET', '/api/dept/events?status=resolved');
  check('events?status=resolved includes it', r.body.some((e) => e.event_id === id));

  console.log('== E2E-9 report arriving after resolve');
  const firstTs = new Date(reports[0].event_ts).getTime();
  const late = rep({ lat: reports[0].lat + jitter(10), lng: reports[0].lng + jitter(10), event_ts: new Date(firstTs + 1500).toISOString() });
  r = await call('POST', '/api/reports', { body: late, dept: false, sim: true });
  await sleep(3000);
  r = await call('GET', `/api/dept/events/${id}`);
  const lateCase = r.body.cases.find((c) => c.report_id === late.report_id);
  check('late report attached to the resolved event with late=true', !!lateCase && lateCase.late === true && r.body.event.status === 'resolved', JSON.stringify(lateCase));
  check('event total is now 5', r.body.event.counts.total === 5, JSON.stringify(r.body.event.counts));

  console.log('== E2E-10 duplicate report_id');
  r = await call('POST', '/api/reports', { body: late, dept: false, sim: true });
  await sleep(1500);
  const after = await call('GET', `/api/dept/events/${id}`);
  check('duplicate -> duplicate:true, counts unchanged', r.body.duplicate === true && after.body.event.counts.total === 5, JSON.stringify(r.body));

  console.log('== CSV export');
  r = await call('GET', `/api/dept/events/${id}/export.csv?key=${encodeURIComponent(DEPT)}`, { dept: false, raw: true });
  const lines = r.body.trim().split(/\r?\n/);
  check('CSV: header + 5 rows, content-type csv', r.status === 200 && lines.length === 6 && /text\/csv/.test(r.res.headers.get('content-type')) &&
    lines[0].startsWith('report_id,user_id,event_ts') && lines[0].includes('shelters_sent_at'), lines[0]);

  console.log('== settings');
  r = await call('GET', '/api/dept/settings');
  const orig = r.body.rules.accident.min_count;
  check('GET settings returns rules', r.status === 200 && orig >= 1, JSON.stringify(r.body).slice(0, 80));
  r = await call('PUT', '/api/dept/settings', { body: { rules: { accident: { min_count: 0 } } } });
  check('invalid min_count 0 -> 400', r.status === 400, r.status);
  r = await call('PUT', '/api/dept/settings', { body: { not_a_setting: 1 } });
  check('unknown key -> 400', r.status === 400, r.status);
  r = await call('PUT', '/api/dept/settings', { body: { rules: { accident: { min_count: 5 } } } });
  check('partial PUT merges (min_count 5, radius kept)', r.status === 200 && r.body.rules.accident.min_count === 5 && r.body.rules.accident.radius_m === 300, JSON.stringify(r.body.rules && r.body.rules.accident));
  r = await call('PUT', '/api/dept/settings', { body: { rules: { accident: { min_count: orig } } } });
  check('restored', r.status === 200 && r.body.rules.accident.min_count === orig);

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('test failed:', e); process.exit(1); });
