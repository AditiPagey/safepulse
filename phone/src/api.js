// The ONLY file that talks to the server. Has a fake mode built in.
import { FAKE, FAKE_FAIL_RATE, API_BASE } from './config.js';
import { load, save } from './store.js';

// ---------- FAKE MODE: pretends to be Dev B's server ----------
function fakeError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function fakeApi(method, path, body) {
  await new Promise(r => setTimeout(r, 300)); // pretend network delay
  const db = load('sp.fake_db', { reports: {}, answers: {} });
  const now = new Date().toISOString();

  if ((path === '/api/reports' || path === '/api/answers') && Math.random() < FAKE_FAIL_RATE) {
    throw fakeError(503, 'Fake failure (FAKE_FAIL_RATE)');
  }

  if (path === '/api/config') {
    return { timeout_seconds: 60, cooldown_seconds: 10, demo_mode: true,
             full_prompt_score: 0.6, min_score_report: 0.4, server_time: now };
  }
  if (path === '/api/regions') {
    return [
      { code: 'sim-region', name: 'Test Region', lat: 32.88, lng: -117.23 },
      { code: 'north', name: 'North', lat: 32.95, lng: -117.2 },
      { code: 'south', name: 'South', lat: 32.7, lng: -117.15 },
    ];
  }
  if (path === '/api/users') {
    return { user_id: crypto.randomUUID(), token: 'fake-token' };
  }
  if (path === '/api/reports') {
    console.log('[FAKE SERVER] report received:', JSON.stringify(body));
    const duplicate = !!db.reports[body.report_id];
    db.reports[body.report_id] = body;
    save('sp.fake_db', db);
    return { report_id: body.report_id, received_at: now,
             deadline_ts: new Date(Date.parse(body.event_ts) + 60000).toISOString(),
             event_id: null, duplicate, counted: body.score >= 0.4 };
  }
  if (path === '/api/answers') {
    console.log('[FAKE SERVER] answer received:', JSON.stringify(body));
    if (!db.reports[body.report_id]) throw fakeError(404, 'Unknown report');
    db.answers[body.report_id] = { answer: body.answer, at: Date.now() };
    save('sp.fake_db', db);
    return { report_id: body.report_id, status: body.answer === 'safe' ? 'safe' : 'unsafe' };
  }
  if (path.startsWith('/api/cases/')) {
    const id = path.split('/').pop();
    const r = db.reports[id];
    if (!r) throw fakeError(404, 'Unknown report');
    const deadlineMs = Date.parse(r.event_ts) + 60000;
    const a = db.answers[id];
    let status = 'pending';
    if (a) status = a.answer === 'safe' ? 'safe' : 'unsafe';
    else if (Date.now() > deadlineMs) status = 'no_response';

    // 15 s after a "safe" answer, pretend the department sent shelters
    let shelters = null;
    if (a && a.answer === 'safe' && Date.now() - a.at > 15000) {
      shelters = [
        { shelter_id: 1, name: 'Community Center', address: '123 Main St',
          lat: 32.881, lng: -117.234, distance_m: 850, capacity: 200 },
        { shelter_id: 2, name: 'High School Gym', address: '45 Oak Ave',
          lat: 32.875, lng: -117.22, distance_m: 1900, capacity: 500 },
      ];
    }
    return { report_id: id, status, event_id: null,
             deadline_ts: new Date(deadlineMs).toISOString(),
             answer: a ? a.answer : null, shelters,
             shelters_sent_at: shelters ? now : null, found_safe_at: null };
  }
  throw fakeError(404, 'Fake server has no route for ' + path);
}

// ---------- REAL MODE ----------
async function realApi(method, path, body) {
  const user = load('sp.user');
  const headers = { 'Content-Type': 'application/json' };
  if (user && user.token) headers.Authorization = 'Bearer ' + user.token;

  const res = await fetch(API_BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = new Error((data && data.error && data.error.message) || 'HTTP ' + res.status);
    e.status = res.status;
    throw e;
  }
  return data;
}

// Everything else in the app calls this one function
export function api(method, path, body) {
  return FAKE ? fakeApi(method, path, body) : realApi(method, path, body);
}
