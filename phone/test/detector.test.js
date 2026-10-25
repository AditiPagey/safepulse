// Run: node test/detector.test.js
// Feeds synthetic 60 Hz signals (from the plan, section 7) through the detector.
import { Detector } from '../src/detector.js';

const C = {
  T_LOW: 4, T_HIGH: 7.5, WINDOW_MS: 3000, EVAL_EVERY_MS: 100, MIN_SUSTAIN_MS: 1200,
  MAX_GAP_MS: 400, MIN_DUTY: 0.35, CONFIRM_MAX_MS: 4000, CONFIRM_QUIET_MS: 800,
  PEAK_REF: 20, DUR_REF_MS: 6000,
};
const HZ = 60, DT = 1000 / HZ;

// gen(tSeconds) -> magnitude. Runs for `seconds`, then 3 s of calm.
function run(gen, seconds, { touching = false } = {}) {
  const d = new Detector(C);
  let nextEval = 0, trigger = null;
  const total = (seconds + 3) * 1000;
  for (let t = 0; t <= total; t += DT) {
    const mag = t <= seconds * 1000 ? Math.abs(gen(t / 1000)) : 0.1 * Math.random();
    d.push(t, mag);
    if (t >= nextEval) {
      nextEval += C.EVAL_EVERY_MS;
      const r = d.tick(t, !touching, true);
      if (r && !trigger) trigger = r;
    }
  }
  return trigger;
}

const noise = () => (Math.random() * 2 - 1);
const cases = [
  ['drop',         () => run(t => (t < 0.08 ? 60 : 0.1 * noise()), 2),           'none'],
  ['walking',      () => run(t => 3 * Math.sin(2 * Math.PI * 2 * t), 10),        'none'],
  ['vehicle',      () => run(t => 1.5 * noise(), 30),                             'none'],
  ['strong shake', () => run(t => 10 * Math.sin(2 * Math.PI * 4 * t), 5),        'full'],
  ['quake',        () => run(t => (5 + 3 * (t / 15)) * Math.sin(2 * Math.PI * 2 * t), 15), 'trigger'],
  ['crash',        () => run(t => (t < 0.1 ? 25 : 12 * Math.max(0, 1 - t / 2) * Math.sin(2 * Math.PI * 8 * t)), 2), 'trigger'],
  ['handling',     () => run(t => 10 * Math.sin(2 * Math.PI * 4 * t), 5, { touching: true }), 'none'],
];

let fails = 0;
for (const [name, fn, expected] of cases) {
  const r = fn();
  const got = r ? `TRIGGER score=${r.score.toFixed(2)} peak=${r.peak.toFixed(1)} dur=${r.duration_ms}ms` : 'no trigger';
  let pass;
  if (expected === 'none') pass = !r;
  else if (expected === 'full') pass = r && r.score >= 0.6;
  else if (expected === 'trigger') pass = !!r;
  else pass = null; // informational
  if (pass === false) fails++;
  console.log(`${pass === null ? 'INFO' : pass ? 'PASS' : 'FAIL'}  ${name.padEnd(13)} expected ${expected.padEnd(22)} got ${got}`);
}
process.exit(fails ? 1 : 0);
