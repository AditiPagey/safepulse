// The app: screens, trigger flow, answers, polling, shelters, demo tools.
import { C, DEMO, FAKE, serverConfig, setServerConfig } from './config.js';
import { api } from './api.js';
import { load, save, remove } from './store.js';
import { startSensor, detector, getLastMag, getSampleCount } from './sensor.js';
import { getLocationOnce } from './location.js';
import { enqueue, setOutboxHandlers, outboxLength, getLastResponse,
         resumeOutbox, rewriteUser } from './outbox.js';

const $ = id => document.getElementById(id);
let screen = null;
let activeCase = load('sp.active_case'); // the current shake "case"
let motionAsked = false;
let motionDenied = false;

function show(name) {
  screen = name;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('screen-' + name).classList.add('active');
  if (name === 'home') {
    $('btn-view-case').style.display = activeCase ? 'block' : 'none';
  }
}

function saveCase() { save('sp.active_case', activeCase); }

function setSend(text, cls = '') {
  if (activeCase) { activeCase.send = text; activeCase.sendCls = cls; saveCase(); }
  document.querySelectorAll('.send-status').forEach(el => {
    el.textContent = text;
    el.className = 'send-status ' + (cls || 'muted');
  });
}

const iso = ms => new Date(ms).toISOString();
const round2 = x => Math.round(x * 100) / 100;

// =============== START ===============
async function boot() {
  wireButtons();
  try {
    const cfg = await api('GET', '/api/config');
    setServerConfig(cfg);
    save('sp.config_cache', cfg);
  } catch (e) {
    console.warn('Config failed, using cached/defaults', e);
    setServerConfig(load('sp.config_cache'));
  }
  if (!load('sp.user')) return startOnboarding();
  startMonitoring();
  if (activeCase) resumeCase();
  else show('home');
}

// =============== ONBOARDING ===============
async function startOnboarding(reregister = false) {
  show('onboarding');
  $('reregister-msg').style.display = reregister ? 'block' : 'none';
  try {
    const regions = await api('GET', '/api/regions');
    $('region-select').innerHTML = regions
      .map(r => `<option value="${r.code}">${r.name}</option>`)
      .join('');
  } catch (e) {
    $('onboard-msg').textContent = 'Could not load regions: ' + e.message;
  }
}

// iOS needs this called directly from a button tap
async function askMotionPermission() {
  if (typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function') {
    const r = await DeviceMotionEvent.requestPermission();
    motionAsked = true;
    return r === 'granted';
  }
  return true; // Android / desktop: no prompt needed (HTTPS is enough)
}

async function onStartTapped() {
  const msg = $('onboard-msg');
  // 1. Motion permission FIRST (iOS user-gesture rule)
  // (If denied we continue anyway; Home shows an "Enable motion sensor" button
  //  when no sensor data arrives, and Simulate still works for the demo.)
  try {
    if (!(await askMotionPermission())) {
      console.warn('Motion permission not granted');
      motionDenied = true;
    }
  } catch (e) {
    console.warn('Motion permission error', e);
  }
  // 2. Location warm-up (result thrown away)
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(() => {}, () => {}, { timeout: 6000 });
  }
  // 3. Sign up
  msg.textContent = 'Signing up...';
  try {
    const home_region = $('region-select').value;
    const res = await api('POST', '/api/users', { home_region });
    save('sp.user', { user_id: res.user_id, token: res.token, home_region });
    msg.textContent = '';
    rewriteUser(res.user_id); // in case we were re-registering
    resumeOutbox();
    startMonitoring();
    if (activeCase) resumeCase();
    else show('home');
  } catch (e) {
    msg.innerHTML = '<span class="err">Sign-up failed: ' + e.message + '</span>';
  }
}

// =============== MONITORING ===============
let monitoring = false;
function startMonitoring() {
  if (monitoring) return;
  monitoring = true;
  keepScreenOn();
  startSensor({ canTrigger, onTrigger: onDetectorTrigger });
  setInterval(tickUi, 1000);
  if (DEMO) startDemoTools();
  // If no sensor data after 3 s, offer a button (iOS may need the tap again)
  setTimeout(() => {
    if (getSampleCount() === 0 && screen === 'home') {
      $('btn-enable-motion').style.display = 'block';
      if (motionDenied) $('btn-enable-motion').textContent = 'Motion access denied. Tap to try again';
    }
  }, 3000);
}

function canTrigger() {
  if (screen === 'prompt' || screen === 'onboarding') return false;
  if (Date.now() < load('sp.cooldown_until', 0)) return false;
  return getSampleCount() > 0;
}

async function keepScreenOn() {
  try {
    if (navigator.wakeLock && document.visibilityState === 'visible') {
      await navigator.wakeLock.request('screen');
    }
  } catch (e) {
    console.warn('Wake lock failed', e);
  }
}

document.addEventListener('visibilitychange', () => {
  const visible = document.visibilityState === 'visible';
  if (visible) { keepScreenOn(); poll(); }
  const chip = $('monitor-chip');
  chip.textContent = visible ? 'Monitoring active' : 'Paused: screen hidden';
  chip.classList.toggle('paused', !visible);
});

// =============== TRIGGER FLOW ===============
function onDetectorTrigger(t) {
  console.log('Detector trigger', t);
  if (t.score < serverConfig.min_score_report) {
    console.log('Weak shake (score ' + t.score.toFixed(2) + '), logged only, no prompt');
    logLocal('weak shake ignored, score ' + t.score.toFixed(2));
    return;
  }
  triggerCase({ score: t.score, peak_g: t.peak / 9.81, duration_ms: t.duration_ms,
                ts_start: t.ts_start });
}

async function triggerCase(info, offsetM = 0) {
  const report_id = crypto.randomUUID();
  const event_ts = info.ts_start;
  activeCase = {
    report_id,
    event_ts,
    deadline_ts: iso(Date.parse(event_ts) + serverConfig.timeout_seconds * 1000),
    status: 'pending',
    soft: info.score < serverConfig.full_prompt_score,
    answer: null,
    acked: false,
    server: null,
    sheltersSeen: false,
  };
  saveCase();
  save('sp.cooldown_until', Date.now() + serverConfig.cooldown_seconds * 1000);

  showPrompt();
  if (navigator.vibrate) navigator.vibrate([300, 100, 300]);
  setSend('Getting location...');

  const loc = await getLocationOnce();
  if (offsetM > 0 && loc.lat != null) {
    const ang = Math.random() * 2 * Math.PI;
    loc.lat += (offsetM * Math.sin(ang)) / 111320;
    loc.lng += (offsetM * Math.cos(ang)) / (111320 * Math.cos((loc.lat * Math.PI) / 180));
  }

  const user = load('sp.user');
  const report = {
    report_id,
    user_id: user.user_id,
    event_ts,
    lat: loc.lat,
    lng: loc.lng,
    accuracy_m: loc.accuracy_m,
    loc_source: loc.loc_source,
    score: round2(info.score),
    peak_g: round2(info.peak_g),
    duration_ms: Math.round(info.duration_ms),
    home_region: user.home_region,
  };
  console.log('REPORT JSON (send this to Dev B):', JSON.stringify(report));
  setSend('Sending report...');
  enqueue('report', report);
}

function showPrompt() {
  $('prompt-title').textContent = activeCase.soft
    ? 'Did you feel a strong shake? Are you OK?'
    : 'Strong shaking detected. Are you safe?';
  show('prompt');
  setSend(activeCase.send || '', activeCase.sendCls || '');
  tickUi();
}

// =============== OUTBOX EVENTS ===============
setOutboxHandlers({
  onSent(item, res) {
    if (!activeCase || item.payload.report_id !== activeCase.report_id) return;
    if (item.kind === 'report') {
      activeCase.acked = true;
      if (res && res.deadline_ts) activeCase.deadline_ts = res.deadline_ts; // server value wins
      if (res && res.event_id) activeCase.event_id = res.event_id;
      saveCase();
      setSend('Report received', 'ok');
      startPolling();
    } else {
      setSend('Answer received', 'ok');
      poll();
    }
  },
  onRetry(item, e) {
    if (activeCase && item.payload.report_id === activeCase.report_id) {
      setSend((item.kind === 'report' ? 'Report' : 'Answer') + ' not sent, retrying...', 'err');
    }
  },
  onFail(item, e) {
    if (activeCase && item.payload.report_id === activeCase.report_id) {
      setSend('Could not send: ' + e.message, 'err');
    }
  },
  onAuth() {
    // token invalid: re-register, keep the active case
    remove('sp.user');
    startOnboarding(true);
  },
});

// =============== ANSWERS ===============
function answer(ans) {
  if (!activeCase) return;
  const user = load('sp.user');
  activeCase.answer = ans;
  saveCase();
  enqueue('answer', {
    report_id: activeCase.report_id,
    user_id: user.user_id,
    answer: ans,
    answer_ts: new Date().toISOString(),
  });
  setSend('Saved, sending...');
  showStatus();
}

// =============== STATUS + POLLING ===============
let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(poll, C.POLL_MS);
  poll();
}
function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

async function poll() {
  if (!activeCase || !activeCase.acked) return;
  if (document.visibilityState !== 'visible') return;
  try {
    const cs = await api('GET', '/api/cases/' + activeCase.report_id);
    activeCase.server = cs;
    activeCase.status = cs.status;
    if (cs.deadline_ts) activeCase.deadline_ts = cs.deadline_ts;
    if (cs.shelters && cs.shelters.length && !activeCase.sheltersSeen) {
      activeCase.sheltersSeen = true;
      activeCase.showBanner = true;
      if (navigator.vibrate) navigator.vibrate(200);
      if (screen !== 'prompt') show('status');
    }
    saveCase();
    renderStatus();
    if (cs.status === 'found_safe') stopPolling();
  } catch (e) {
    console.warn('Poll failed', e);
  }
}

function showStatus() {
  show('status');
  setSend(activeCase.send || '', activeCase.sendCls || '');
  renderStatus();
  if (activeCase.acked) startPolling();
}

const STATUS_TEXT = {
  pending: 'Waiting for your answer.',
  safe: 'You reported: <b class="ok">SAFE</b>',
  unsafe: 'You asked for <b class="err">HELP</b>. The department has your location.',
  no_response: "We haven't heard from you. If you're safe, tap below.",
  found_safe: 'The department marked you found safe.',
};

function renderStatus() {
  if (!activeCase) return;
  let st = activeCase.status;
  let text = STATUS_TEXT[st] || st;
  if (st === 'pending' && activeCase.answer) {
    text = `Your answer (<b>${activeCase.answer === 'safe' ? 'safe' : 'help'}</b>) is saved and being sent.`;
  }
  const cs = activeCase.server || {};
  if (cs.event_id || activeCase.event_id) text += '<br/><span class="muted">You are part of a reported incident.</span>';
  $('case-status').innerHTML = text;
  $('late-buttons').style.display = st === 'found_safe' ? 'none' : 'block';
  $('shelter-banner').style.display = activeCase.showBanner ? 'block' : 'none';

  const sh = cs.shelters;
  $('shelters').innerHTML = sh && sh.length
    ? '<h3>Nearby shelters</h3>' + sh.map(s => `
        <div class="card">
          <b>${s.name}</b><br/>
          ${s.address || ''}<br/>
          <span class="muted">${(s.distance_m / 1000).toFixed(1)} km away · capacity ${s.capacity ?? '?'}</span><br/>
          <a href="https://maps.google.com/?q=${s.lat},${s.lng}" target="_blank" rel="noopener">Open in Maps</a>
        </div>`).join('')
    : '';
}

function resumeCase() {
  const notExpired = Date.now() < Date.parse(activeCase.deadline_ts);
  if (!activeCase.answer && notExpired) showPrompt();
  else showStatus();
  if (activeCase.acked) startPolling();
}

// =============== COUNTDOWNS (every second) ===============
function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

function tickUi() {
  if (activeCase) {
    const left = Date.parse(activeCase.deadline_ts) - Date.now();
    let text = '';
    if (!activeCase.answer) {
      text = left > 0 ? 'Time to answer: ' + fmt(left) : "No answer recorded; tap if you're safe.";
    }
    $('prompt-countdown').textContent = text;
    $('status-countdown').textContent = text;
    // prompt timed out without answer -> move to status screen
    if (screen === 'prompt' && left <= 0 && !activeCase.answer) {
      activeCase.status = activeCase.status === 'pending' ? 'no_response' : activeCase.status;
      showStatus();
    }
  }
  if (DEMO) renderDebug();
}

// =============== BUTTONS ===============
function wireButtons() {
  $('btn-start').onclick = onStartTapped;
  $('btn-safe').onclick = () => answer('safe');
  $('btn-help').onclick = () => answer('help');
  $('btn-late-safe').onclick = () => answer('safe');
  $('btn-late-help').onclick = () => answer('help');
  $('btn-done').onclick = () => {
    if (activeCase) { activeCase.showBanner = false; saveCase(); }
    show('home');
  };
  $('btn-view-case').onclick = () => showStatus();
  $('btn-enable-motion').onclick = async () => {
    try {
      if (await askMotionPermission()) $('btn-enable-motion').style.display = 'none';
    } catch (e) { alert('Motion permission error: ' + e.message); }
  };
}

// =============== DEMO TOOLS (?demo=1) ===============
const localLog = [];
function logLocal(s) {
  localLog.unshift(new Date().toLocaleTimeString() + ' ' + s);
  localLog.length = Math.min(localLog.length, 5);
}

function startDemoTools() {
  $('demo-tools').style.display = 'block';
  $('sim-score').oninput = e => ($('sim-score-val').textContent = Number(e.target.value).toFixed(2));
  $('sim-offset').oninput = e => ($('sim-offset-val').textContent = e.target.value);
  $('btn-simulate').onclick = () => {
    const score = Number($('sim-score').value);
    if (score < serverConfig.min_score_report) {
      logLocal('simulated weak shake (score ' + score + '), no prompt');
      return;
    }
    // Simulate bypasses the detector and the cooldown
    triggerCase({
      score,
      peak_g: (score * 20) / 9.81,
      duration_ms: score * 6000,
      ts_start: new Date().toISOString(),
    }, Number($('sim-offset').value));
  };
  $('btn-reset').onclick = () => {
    if (confirm('Clear everything and sign out?')) { localStorage.clear(); location.reload(); }
  };
  drawGraph();
}

function drawGraph() {
  const cv = $('graph');
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height, MAX = 25;
  const y = v => H - (Math.min(v, MAX) / MAX) * H;
  function frame() {
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#eab308'; ctx.beginPath(); ctx.moveTo(0, y(C.T_LOW)); ctx.lineTo(W, y(C.T_LOW)); ctx.stroke();
    ctx.strokeStyle = '#ef4444'; ctx.beginPath(); ctx.moveTo(0, y(C.T_HIGH)); ctx.lineTo(W, y(C.T_HIGH)); ctx.stroke();
    const now = performance.now();
    ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 2; ctx.beginPath();
    let first = true;
    for (const s of detector.buf) {
      const x = W - ((now - s.t) / 10000) * W;
      if (first) { ctx.moveTo(x, y(s.mag)); first = false; } else ctx.lineTo(x, y(s.mag));
    }
    ctx.stroke(); ctx.lineWidth = 1;
    const st = detector.lastStats;
    $('live-stats').textContent = getSampleCount() === 0
      ? 'No sensor data (laptops have no motion sensor; use the phone).'
      : `mag ${getLastMag().toFixed(1)} | peak ${st ? st.peak.toFixed(1) : '-'} | ` +
        `sustained ${st ? (st.sustained_ms / 1000).toFixed(1) : '-'}s | duty ${st ? st.duty.toFixed(2) : '-'}` +
        (detector.confirm ? ' | CONFIRMING...' : '');
    requestAnimationFrame(frame);
  }
  frame();
}

function renderDebug() {
  const cd = load('sp.cooldown_until', 0) - Date.now();
  $('debug').textContent =
    `mode: ${FAKE ? 'FAKE (no server)' : 'REAL server'}\n` +
    `screen: ${screen}\n` +
    `case: ${activeCase ? activeCase.report_id.slice(0, 8) + ' ' + activeCase.status : 'none'}\n` +
    `cooldown: ${cd > 0 ? Math.ceil(cd / 1000) + 's' : 'no'}\n` +
    `outbox: ${outboxLength()}\n` +
    `last response: ${JSON.stringify(getLastResponse())}\n` +
    (localLog.length ? 'log:\n' + localLog.join('\n') : '');
}

boot();
