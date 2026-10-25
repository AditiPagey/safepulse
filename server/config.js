const { query } = require('./db');

const env = {
  DEMO_MODE: String(process.env.DEMO_MODE || 'false').toLowerCase() === 'true',
  DEPT_KEY: process.env.DEPT_KEY || '',
  SIM_KEY: process.env.SIM_KEY || '',
  PORT: Number(process.env.PORT) || 8080,
  DEFAULT_CENTER: (process.env.DEFAULT_CENTER || '34.0522,-118.2437').split(',').map(Number),
};

const DEMO_TIMEOUT_S = 60;
const DEMO_COOLDOWN_S = 10;

const DEFAULT_SETTINGS = {
  timeout_seconds: 7200,
  rules: {
    // window_s = fixed collation window counted from the first report of a cluster.
    accident: { radius_m: 300, window_s: 5, min_count: 4, max_accuracy_m: 150 },
    disaster: { radius_m: 15000, window_s: 5, min_count: 15, max_accuracy_m: 30000 },
    disaster_pct: { enabled: false, pct: 0.2, min_registered: 10, window_s: 120 },
  },
  lone_retention_s: 300, // unassigned (lone) reports are deleted after this long
  auto_send_shelters: true, // safe people get shelters automatically (only "sent at" is stored)
  dedupe_user_s: 300,
  late_join_hours: 24,
  late_threshold_s: 60,
  shelters_k: 3,
  ip_accuracy_m: 25000,
  region_accuracy_m: 50000,
  min_score: 0.4,
  cooldown_seconds: 300,
  full_prompt_score: 0.6,
};

let cache = null;

async function loadSettings() {
  const { rows } = await query("SELECT value FROM settings WHERE key = 'main'");
  cache = rows[0] ? rows[0].value : DEFAULT_SETTINGS;
  return cache;
}

// Raw stored settings (what the dashboard edits).
function getSettings() {
  return cache || DEFAULT_SETTINGS;
}

// Effective settings: DEMO_MODE overrides timeout and cooldown.
function getEffective() {
  const s = getSettings();
  if (!env.DEMO_MODE) return s;
  return { ...s, timeout_seconds: DEMO_TIMEOUT_S, cooldown_seconds: DEMO_COOLDOWN_S };
}

const timeoutSeconds = () => getEffective().timeout_seconds;

module.exports = { env, DEFAULT_SETTINGS, loadSettings, getSettings, getEffective, timeoutSeconds };
