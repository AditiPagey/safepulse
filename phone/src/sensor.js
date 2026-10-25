// Connects the phone's motion sensor to the detector.
import { C } from './config.js';
import { Detector } from './detector.js';

export const detector = new Detector(C);
let gravity = null;
let lastMag = 0;
let sampleCount = 0;
let lastInputAt = -Infinity;

export const getLastMag = () => lastMag;
export const getSampleCount = () => sampleCount;

// Input guard: remember when the user last touched the screen
for (const ev of ['pointerdown', 'touchstart', 'keydown']) {
  window.addEventListener(ev, () => { lastInputAt = performance.now(); }, { passive: true });
}

let started = false;
export function startSensor({ canTrigger, onTrigger }) {
  if (started) return;
  started = true;

  window.addEventListener('devicemotion', e => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    const raw = [a.x, a.y, a.z];
    if (!gravity) gravity = raw.slice();
    const A = C.GRAVITY_ALPHA;
    for (let i = 0; i < 3; i++) gravity[i] = A * gravity[i] + (1 - A) * raw[i];
    const lin = raw.map((v, i) => v - gravity[i]);
    lastMag = Math.hypot(lin[0], lin[1], lin[2]);
    sampleCount++;
    // event timestamp (same clock as performance.now in modern browsers)
    const now = performance.now();
    const t = e.timeStamp > 0 && e.timeStamp <= now + 1000 ? e.timeStamp : now;
    detector.push(t, lastMag);
  });

  setInterval(() => {
    const now = performance.now();
    const visible = document.visibilityState === 'visible';
    const allowed = visible && now - lastInputAt > C.INPUT_GUARD_MS && canTrigger();
    const trig = detector.tick(now, allowed, visible);
    if (trig) {
      const tStart = trig.t_start ?? now;
      const ts_start = new Date(Date.now() - (now - tStart)).toISOString();
      onTrigger({ ...trig, ts_start });
    }
  }, C.EVAL_EVERY_MS);
}
