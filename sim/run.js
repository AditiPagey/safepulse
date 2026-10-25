#!/usr/bin/env node
// optional: --mix 50,20,30 (safe,help,silent weights)
// node sim/run.js <quake|bus|noise|late|nolocation> --base http://localhost:8080 --center lat,lng --n 120 --speed 1 --seed 1   (env SIM_KEY)
import { rng, sleep, uuid } from './util.js'; import { scenarios } from './scenarios.js';
const [name, ...rest] = process.argv.slice(2); const o = {};
for (let i = 0; i < rest.length; i += 2) o[rest[i].replace(/^--/, '')] = rest[i + 1];
if (!scenarios[name]) { console.error('Scenarios:', Object.keys(scenarios).join(', ')); process.exit(1); }
const base = (o.base || 'http://localhost:8080').replace(/\/$/, ''), speed = +o.speed || 1, key = process.env.SIM_KEY || 'dev-sim-key';
const [lat, lng] = (o.center || process.env.DEFAULT_CENTER || '37.7749,-122.4194').split(',').map(Number);
const r = rng(+o.seed || Date.now()); const users = scenarios[name]({ r, center: { lat, lng }, n: o.n ? +o.n : undefined, every: o.every ? +o.every : undefined });
// --mix safe,help,silent  (weights, e.g. 50,20,30): randomly overrides every user's answer. Seeded, so --seed repeats it.
if (o.mix) { const w = o.mix.split(',').map(Number); if (w.length !== 3 || w.some(x => !(x >= 0)) || !w.some(x => x > 0)) { console.error('--mix needs 3 weights: safe,help,silent'); process.exit(1); }
  const tot = w[0] + w[1] + w[2];
  for (const u of users) { const x = r() * tot; u.answer = x < w[0] ? 'safe' : x < w[0] + w[1] ? 'help' : null; u.answerAt = u.answerAt ?? 3000 + r() * 17000; }
  console.log(`answer mix: ${w[0]} safe / ${w[1]} help / ${w[2]} silent`); }
const post = async (path, body) => { try { const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sim-Key': key }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) }; } catch (e) { return { status: 0, body: { error: { message: 'unreachable: ' + base } } }; } };
const c = { sent: 0, failed: 0, answers: 0, events: new Set() }; const jobs = [];
console.log(`${name}: ${users.length} users, speed x${speed}, base ${base}`);
for (const u of users) jobs.push((async () => {
  await sleep(u.at / speed); const rid = uuid(), uid = uuid(), now = Date.now();
  const rpt = { report_id: rid, user_id: uid, event_ts: new Date(now - (u.ageMs || 0)).toISOString(), score: +(0.6 + r() * .35).toFixed(2), peak_g: +(1.4 + r()).toFixed(1), duration_ms: 3000 + Math.floor(r() * 3000), home_region: 'sim-region', ...u.rpt };
  const res = await post('/api/reports', rpt);
  if (res.status !== 202) { c.failed++; return console.log(`  report FAIL ${res.status}`, res.body?.error?.message || ''); }
  c.sent++; if (res.body.event_id) c.events.add(res.body.event_id);
  console.log(`  report ${rid.slice(0, 6)} ${rpt.loc_source}${rpt.accuracy_m ? ' ±' + rpt.accuracy_m : ''} → ${res.body.event_id ? 'event ' + res.body.event_id.slice(-6) : 'watch'}  [${c.sent}/${users.length}]`);
  if (u.answer) { await sleep(u.answerAt / speed); const a = await post('/api/answers', { report_id: rid, user_id: uid, answer: u.answer, answer_ts: new Date().toISOString() });
    if (a.status === 200) { c.answers++; console.log(`  answer ${rid.slice(0, 6)} ${u.answer}`); } else console.log(`  answer FAIL ${a.status}`); }
})());
process.on('SIGINT', () => { console.log('\nstopped', summary()); process.exit(0); });
const summary = () => `sent=${c.sent} failed=${c.failed} answers=${c.answers} events=${c.events.size}`;
await Promise.all(jobs); console.log('done', summary());
