// Mock department API: same routes/shapes as contract v1. Run: node mock/mock-dept-api.js  (PORT default 8081)
import express from 'express'; import cors from 'cors'; import { randomUUID } from 'node:crypto';
const KEY = process.env.DEPT_KEY || 'dev-dept-key', PORT = process.env.PORT || 8081;
const [C0, C1] = (process.env.DEFAULT_CENTER || '37.7749,-122.4194').split(',').map(Number);
const id = () => randomUUID(), now = () => new Date().toISOString(), rnd = (a, b) => a + Math.random() * (b - a);
const jit = (m) => ({ lat: C0 + rnd(-m, m) / 111320, lng: C1 + rnd(-m, m) / (111320 * Math.cos(C0 * Math.PI / 180)) });
const events = {}, cases = {}, inbox = [], clients = new Set();
let settings = { timeout_seconds: 60, accident: { radius_m: 300, window_s: 60, min_count: 3, max_accuracy_m: 150 }, disaster: { radius_m: 15000, window_s: 120, min_count: 15, max_accuracy_m: 30000 } };
const shelters = Array.from({ length: 8 }, (_, i) => ({ shelter_id: 's' + i, name: `Shelter ${i + 1}`, address: `${100 + i} Main St`, ...jit(4000), distance_m: 0, capacity: 100 }));
const counts = id => { const l = Object.values(cases[id]), n = s => l.filter(c => c.status === s).length;
  return { total: l.length, pending: n('pending'), safe: n('safe'), unsafe: n('unsafe'), no_response: n('no_response'), found_safe: n('found_safe') }; };
const send = (name, data) => clients.forEach(r => r.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
const mkCase = (center, spread, status, deadlineOffset = 60000) => { const p = { lat: center.lat + rnd(-spread, spread) / 111320, lng: center.lng + rnd(-spread, spread) / 111320 }; const gps = Math.random() < .75;
  return { report_id: id(), user_short: id().slice(0, 6), event_ts: now(), joined_at: now(), ...p, accuracy_m: gps ? Math.round(rnd(10, 60)) : 25000, loc_source: gps ? 'gps' : 'ip', score: +rnd(.6, .95).toFixed(2),
    status, answer: status === 'safe' ? 'safe' : status === 'unsafe' ? 'help' : null, answer_ts: ['safe', 'unsafe'].includes(status) ? now() : null,
    deadline_ts: new Date(Date.now() + deadlineOffset).toISOString(), late: false, shelters_sent_at: null, found_safe_at: null }; };
function mkEvent(type, n, mix, resolved = false, sim = true, at = null) {
  const center = at || jit(type === 'disaster' ? 3000 : 200), eid = `ev${sim ? 'sim' : ''}_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 8)}`;
  cases[eid] = {}; for (let i = 0; i < n; i++) { const st = mix[i % mix.length], c = mkCase(center, type === 'disaster' ? 6000 : 25, st, st === 'pending' ? rnd(30000, 90000) : -5000); cases[eid][c.report_id] = c; }
  events[eid] = { event_id: eid, type, status: resolved ? 'resolved' : 'active', center, radius_m: type === 'disaster' ? 15000 : 300, opened_at: now(), first_signal_ts: now(),
    resolved_at: resolved ? now() : null, parent_event_id: null, is_sim: sim, shelters_sent_at: null, counts: counts(eid) }; return events[eid]; }
const refresh = eid => { events[eid].counts = counts(eid); send('event_updated', events[eid]); };
mkEvent('accident', 4, ['pending', 'safe', 'unsafe', 'pending']);
mkEvent('disaster', 40, ['pending', 'safe', 'safe', 'no_response', 'unsafe', 'pending', 'no_response']);
mkEvent('accident', 6, ['safe', 'found_safe', 'no_response'], true);
for (let i = 0; i < 12; i++) inbox.push({ report_id: id(), event_ts: now(), ...jit(8000), accuracy_m: 30, loc_source: 'gps', score: .7, is_sim: true });

const app = express(); app.use(cors({ exposedHeaders: ['X-Server-Time'] })); app.use(express.json());
app.use((req, res, next) => { res.set('X-Server-Time', now()); if (req.query.key === KEY || req.get('X-Dept-Key') === KEY) return next();
  res.status(401).json({ error: { code: 'unauthorized', message: 'Bad department key' } }); });
const err = (res, s, code, message, extra = {}) => res.status(s).json({ error: { code, message }, ...extra });
const get = (req, res) => { const e = events[req.params.eid]; if (!e) err(res, 404, 'not_found', 'No such event'); return e; };
app.get('/api/dept/summary', (q, r) => r.json({ active_events: Object.values(events).filter(e => e.status === 'active').length, inbox_size: inbox.length, totals: {}, sim_running: !!simTimer }));
app.get('/api/dept/events', (q, r) => r.json({ events: Object.values(events).filter(e => !q.query.status || q.query.status === 'all' || e.status === q.query.status), server_time: now() }));
app.get('/api/dept/events/:eid', (q, r) => { const e = get(q, r); if (e) r.json({ event: e, cases: Object.values(cases[e.event_id]), server_time: now() }); });
app.get('/api/dept/inbox', (q, r) => r.json({ items: inbox.slice(0, +q.query.limit || 200) }));
app.get('/api/dept/shelters', (q, r) => r.json(shelters));
app.get('/api/dept/settings', (q, r) => r.json(settings));
app.put('/api/dept/settings', (q, r) => { settings = q.body; send('settings_updated', settings); r.json(settings); });
app.get('/api/dept/events/:eid/export.csv', (q, r) => { const e = get(q, r); if (!e) return; const l = Object.values(cases[e.event_id]);
  r.type('text/csv').send(['user_short,status,event_ts,lat,lng,accuracy_m,loc_source,late', ...l.map(c => [c.user_short, c.status, c.event_ts, c.lat, c.lng, c.accuracy_m, c.loc_source, c.late].join(','))].join('\n')); });
app.post('/api/dept/events/:eid/send-shelters', (q, r) => { const e = get(q, r); if (!e) return; let n = 0;
  Object.values(cases[e.event_id]).filter(c => c.status === 'safe' && !c.shelters_sent_at).forEach(c => { c.shelters_sent_at = now(); n++; send('case_updated', { event_id: e.event_id, case: c }); });
  e.shelters_sent_at = now(); refresh(e.event_id); r.json({ sent_count: n }); });
app.post('/api/dept/events/:eid/cases/:rid/found-safe', (q, r) => { const e = get(q, r); const c = e && cases[e.event_id][q.params.rid]; if (!c) return err(r, 404, 'not_found', 'No such case');
  c.status = 'found_safe'; c.found_safe_at = now(); send('case_updated', { event_id: e.event_id, case: c }); refresh(e.event_id); r.json(c); });
app.post('/api/dept/events/:eid/resolve', (q, r) => { const e = get(q, r); if (!e) return; const p = counts(e.event_id).pending;
  if (p && !q.body?.force) return err(r, 409, 'conflict', `${p} people are still pending`);
  Object.values(cases[e.event_id]).filter(c => c.status === 'pending').forEach(c => c.status = 'no_response'); e.status = 'resolved'; e.resolved_at = now(); refresh(e.event_id); r.json(e); });
app.get('/api/dept/stream', (q, r) => { r.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); r.flushHeaders(); clients.add(r); q.on('close', () => clients.delete(r)); });

// Deadline watcher: pending past its deadline becomes no_response (what the real server does).
setInterval(() => { for (const e of Object.values(events)) { if (e.status !== 'active') continue; let hit = false;
  for (const c of Object.values(cases[e.event_id])) if (c.status === 'pending' && Date.parse(c.deadline_ts) <= Date.now()) { c.status = 'no_response'; hit = true; send('case_updated', { event_id: e.event_id, case: c }); }
  if (hit) refresh(e.event_id); } }, 1000);
// Simulation: each cycle adds 1 accident incident (4 people) + 1 isolated signal, so both kinds are equally represented.
setInterval(() => send('ping', {}), 15000);
let simTimer = null;
const simCycle = () => {
  const mix = ['safe', 'safe', 'unsafe', 'pending'].sort(() => Math.random() - .5);
  send('event_created', mkEvent('accident', 4, mix, false, true, jit(6000)));
  const n = { report_id: id(), event_ts: now(), ...jit(9000), accuracy_m: 30, loc_source: 'gps', score: .7, is_sim: true }; inbox.unshift(n); send('notification', n); };
app.post('/api/dept/sim/start', (q, r) => { if (!simTimer) { simCycle(); simTimer = setInterval(simCycle, +q.body?.every_ms || 6000); } r.json({ running: true }); });
app.post('/api/dept/sim/stop', (q, r) => { clearInterval(simTimer); simTimer = null; r.json({ running: false }); });
app.post('/api/dept/sim/clear', (q, r) => { const cut = Date.now() - (+q.body?.older_than_s || 0) * 1000; let ne = 0, ns = 0;
  for (const e of Object.values(events)) if (e.is_sim && Date.parse(e.opened_at) <= cut) { delete events[e.event_id]; delete cases[e.event_id]; ne++; }
  for (let i = inbox.length - 1; i >= 0; i--) if (inbox[i].is_sim && Date.parse(inbox[i].event_ts) <= cut) { inbox.splice(i, 1); ns++; }
  r.json({ events: ne, signals: ns }); });
app.listen(PORT, () => console.log(`mock-dept-api on :${PORT}  key=${KEY}`));
