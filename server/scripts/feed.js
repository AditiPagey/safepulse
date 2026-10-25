#!/usr/bin/env node
// Scenario feeder: node scripts/feed.js <bus|quake|noise|dup|late|nolocation|answer> [args]
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const crypto = require('crypto');

const BASE = process.env.BASE_URL || `http://localhost:${process.env.PORT || 8080}`;
const SIM_KEY = process.env.SIM_KEY;
const [clat, clng] = (process.env.DEFAULT_CENTER || '34.0522,-118.2437').split(',').map(Number);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();

// random point within radius_m of (lat,lng), uniform over the disc
function around(lat, lng, radius_m) {
  const r = radius_m * Math.sqrt(Math.random());
  const t = Math.random() * 2 * Math.PI;
  const dN = (r * Math.cos(t)) / 111000;
  const dE = (r * Math.sin(t)) / (111000 * Math.cos((lat * Math.PI) / 180));
  return [lat + dN, lng + dE];
}

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sim-Key': SIM_KEY },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function report(over = {}) {
  return {
    report_id: uuid(),
    user_id: uuid(),
    event_ts: new Date().toISOString(),
    lat: clat, lng: clng, accuracy_m: 15, loc_source: 'gps',
    score: 0.8, peak_g: 1.9, duration_ms: 4000, home_region: 'sim-region',
    ...over,
  };
}

const summarize = (r) => `${r.status} counted=${r.body && r.body.counted} dup=${r.body && r.body.duplicate}`;

const scenarios = {
  // 5 reports within ~20 m, 0.6 s apart: 4th creates an accident, 5th joins it
  async bus(n = 5) {
    const [blat, blng] = [clat + 0.004, clng + 0.003];
    for (let i = 0; i < Number(n); i++) {
      const [lat, lng] = around(blat, blng, 20);
      const r = await post('/api/reports', report({ lat, lng }));
      console.log(`bus ${i + 1}/${n}:`, summarize(r));
      await sleep(600);
    }
  },

  // many reports spread over ~6 km, sent in a burst (all inside the 5 s window)
  async quake(n = 120) {
    const total = Number(n);
    let ok = 0;
    const started = Date.now();
    for (let i = 0; i < total; i += 20) {
      const batch = [];
      for (let j = i; j < Math.min(i + 20, total); j++) {
        const [lat, lng] = around(clat, clng, 6000);
        batch.push(post('/api/reports', report({ lat, lng, accuracy_m: 20 + Math.random() * 40 })));
      }
      const res = await Promise.all(batch);
      ok += res.filter((r) => r.status === 202).length;
    }
    console.log(`quake: ${ok}/${total} accepted in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  },

  // two far-apart reports: must NOT become an event
  async noise() {
    const a = around(clat, clng, 4000);
    const b = around(clat - 0.05, clng + 0.05, 1000);
    console.log('noise 1:', summarize(await post('/api/reports', report({ lat: a[0], lng: a[1] }))));
    console.log('noise 2:', summarize(await post('/api/reports', report({ lat: b[0], lng: b[1] }))));
  },

  // same report_id twice, then same user twice within 300 s
  async dup() {
    const r = report();
    console.log('dup same report_id #1:', summarize(await post('/api/reports', r)));
    console.log('dup same report_id #2:', summarize(await post('/api/reports', r)));
    const uid = uuid();
    console.log('same user #1:', summarize(await post('/api/reports', report({ user_id: uid }))));
    console.log('same user #2:', summarize(await post('/api/reports', report({ user_id: uid }))));
  },

  // report whose phone timestamp is 65 s old (late if it joins an event that old)
  async late() {
    const [lat, lng] = around(clat + 0.004, clng + 0.003, 20);
    const ts = new Date(Date.now() - 65000).toISOString();
    console.log('late:', summarize(await post('/api/reports', report({ lat, lng, event_ts: ts }))));
  },

  // no coordinates, no IP: server falls back to the home region centroid
  async nolocation() {
    const r = await post('/api/reports', report({ lat: null, lng: null, accuracy_m: null, loc_source: 'none' }));
    console.log('nolocation:', summarize(r));
  },

  // answer a report: feed.js answer <report_id> <user_id> <safe|help>
  async answer(report_id, user_id, answer = 'safe') {
    const r = await post('/api/answers', { report_id, user_id, answer });
    console.log('answer:', r.status, JSON.stringify(r.body));
  },
};

(async () => {
  const [name, ...args] = process.argv.slice(2);
  if (!SIM_KEY) { console.error('SIM_KEY missing (server/.env)'); process.exit(1); }
  if (!scenarios[name]) {
    console.error(`usage: node scripts/feed.js <${Object.keys(scenarios).join('|')}>`);
    process.exit(1);
  }
  console.log(`-> ${BASE}  center=${clat},${clng}`);
  await scenarios[name](...args);
})().catch((e) => { console.error('feed failed:', e.message); process.exit(1); });
