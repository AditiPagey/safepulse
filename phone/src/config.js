// ============ THE SWITCH ============
// true  = the app makes up server replies itself (no server needed)
// false = talk to Dev B's real server (also set REAL_SERVER in server.js)
export const FAKE = false;

// In FAKE mode, fraction of sends that fail on purpose (to see retries). 0 = never.
export const FAKE_FAIL_RATE = 0;

export const API_BASE = ''; // same origin; server.js forwards /api

// Open the page with ?demo=1 to see demo tools (simulate button, live graph, debug)
export const DEMO = new URLSearchParams(location.search).has('demo');

// ============ SHAKE DETECTOR SETTINGS (tune these on a real phone) ============
export const C = {
  GRAVITY_ALPHA: 0.9,    // low-pass filter for gravity
  T_LOW: 4,              // m/s2: counts as "shaking"
  T_HIGH: 7.5,           // m/s2: peak needed (plan said 8; 7.5 passes the quake test)
  WINDOW_MS: 3000,       // look at the last 3 s
  EVAL_EVERY_MS: 100,    // check 10x per second
  MIN_SUSTAIN_MS: 1200,  // shaking must last this long (plan said 1500; 1200 catches crashes, still rejects drops)
  MAX_GAP_MS: 400,       // small pauses allowed inside "sustained"
  MIN_DUTY: 0.35,        // fraction of samples above T_LOW
  CONFIRM_MAX_MS: 4000,  // after detection, keep measuring up to 4 s
  CONFIRM_QUIET_MS: 800, // ...or until 0.8 s of calm
  INPUT_GUARD_MS: 2000,  // ignore shakes right after the user touched the screen
  PEAK_REF: 20,          // score normalisation
  DUR_REF_MS: 6000,      // score normalisation
  GPS_TIMEOUT_MS: 6000,
  GPS_MAX_AGE_MS: 5000,
  POLL_MS: 5000,
};

// From the server's /api/config (these defaults are used if it fails)
export const serverConfig = {
  timeout_seconds: 60,
  cooldown_seconds: 10,
  full_prompt_score: 0.6,
  min_score_report: 0.4,
};
export function setServerConfig(c) {
  if (c) Object.assign(serverConfig, c);
}
