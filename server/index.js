require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { z } = require('zod');

const { query } = require('./db');
const { env, loadSettings, getEffective } = require('./config');
const { seed } = require('./seed');
const { errorHandler, badRequest } = require('./errors');
const sse = require('./sse');
const bridge = require('./bridge');
const watcher = require('./watcher');

const VERSION = '1.0.0';
const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

// Every response carries X-Server-Time; CORS for tunnels / separate dev servers.
app.use((req, res, next) => {
  res.set('X-Server-Time', new Date().toISOString());
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Dept-Key, X-Sim-Key');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.set('Access-Control-Expose-Headers', 'X-Server-Time');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- Small endpoints -------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: VERSION, time: new Date().toISOString() });
});

app.get('/api/config', (req, res) => {
  const s = getEffective();
  res.json({
    timeout_seconds: s.timeout_seconds,
    cooldown_seconds: s.cooldown_seconds,
    demo_mode: env.DEMO_MODE,
    full_prompt_score: s.full_prompt_score,
    min_score_report: s.min_score,
    server_time: new Date().toISOString(),
  });
});

app.get('/api/regions', wrap(async (req, res) => {
  const { rows } = await query('SELECT code, name, lat, lng FROM regions ORDER BY code');
  res.json(rows);
}));

const userSchema = z.object({ home_region: z.string().min(1) });

app.post('/api/users', wrap(async (req, res) => {
  const { home_region } = userSchema.parse(req.body);
  const { rows } = await query('SELECT 1 FROM regions WHERE code = $1', [home_region]);
  if (!rows[0]) throw badRequest(`unknown home_region: ${home_region}`);
  const user_id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  await query('INSERT INTO users (user_id, token, home_region) VALUES ($1,$2,$3)', [user_id, token, home_region]);
  res.status(201).json({ user_id, token });
}));

// ---- Reports, answers, cases, live stream ----------------------------------

app.use(require('./intake'));
app.use(require('./answers'));
app.use(require('./cases'));
app.use(require('./dept'));

// ---- Static hosting (built phone + dashboard apps) -------------------------

const publicDir = path.join(__dirname, 'public');
for (const app_name of ['phone', 'dashboard']) {
  const dir = path.join(publicDir, app_name);
  if (!fs.existsSync(dir)) continue;
  app.use(`/${app_name}`, express.static(dir));
  app.get(`/${app_name}/*splat`, (req, res) => res.sendFile(path.join(dir, 'index.html')));
}

// Unknown API route -> contract error envelope
app.use('/api', (req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: 'unknown endpoint' } });
});

app.use(errorHandler);

// ---- Boot ------------------------------------------------------------------

async function boot() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await query(schema);
  await seed();
  await loadSettings();
  app.listen(env.PORT, () => {
    console.log(`SafePulse server on :${env.PORT} (demo_mode=${env.DEMO_MODE})`);
  });
  sse.startPing();
  bridge.start();
  watcher.start();
}

if (require.main === module) {
  boot().catch((e) => {
    console.error('boot failed:', e.message);
    process.exit(1);
  });
}

module.exports = { app, boot };
