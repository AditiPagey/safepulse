import { gauss, jitterMeters } from './util.js';
// Each scenario returns a list of users: { at: ms offset, rpt: {...report fields}, answer: 'safe'|'help'|null, answerAt: ms offset }
const U = (r, a, b) => a + r() * (b - a);
const gps = (p, acc) => ({ ...p, accuracy_m: Math.round(acc), loc_source: 'gps' });
const none = (r, ip = true) => ({ loc_source: 'none', ...(ip ? { sim_ip: `203.0.113.${Math.floor(U(r, 1, 250))}` } : {}) });
export const scenarios = {
  quake: ({ r, center, n = 120 }) => Array.from({ length: n }, () => { const p = jitterMeters(center, gauss(r) * 6000, gauss(r) * 6000), x = r(), a = r();
    return { at: U(r, 0, 40000), rpt: x < .7 ? gps(p, U(r, 10, 60)) : x < .8 ? gps(p, U(r, 80, 140)) : none(r, r() < .5),
      answer: a < .25 ? 'safe' : a < .30 ? 'help' : null, answerAt: U(r, 3000, 20000) }; }),
  bus: ({ r, center }) => ['safe', 'safe', 'help', null].map(answer => ({ at: U(r, 0, 10000), rpt: gps(jitterMeters(center, U(r, -25, 25), U(r, -25, 25)), U(r, 8, 25)), answer, answerAt: U(r, 3000, 12000) })),
  noise: ({ r, center, n = 10 }) => Array.from({ length: n }, (_, i) => ({ at: i * 6000, rpt: gps(jitterMeters(center, U(r, -10000, 10000), U(r, -10000, 10000)), 20), answer: null })),
  late: ({ r, center }) => [{ at: 0, ageMs: 180000, rpt: gps(jitterMeters(center, 5, 5), 15), answer: null }],
  // 'mixed': every cycle = 1 accident (4 people within 25 m) + 1 lone signal. Equal counts of each. --n cycles (default 6), --every seconds per cycle (default 60).
  mixed: ({ r, center, n = 6, every = 60 }) => Array.from({ length: n }, (_, i) => { const base = i * every * 1000;
    const c = jitterMeters(center, U(r, -6000, 6000), U(r, -6000, 6000)), ans = ['safe', 'safe', 'help', null].sort(() => r() - .5);
    const crash = ans.map(answer => ({ at: base + U(r, 0, 10000), rpt: gps(jitterMeters(c, U(r, -25, 25), U(r, -25, 25)), U(r, 8, 25)), answer, answerAt: U(r, 3000, 12000) }));
    const lone = { at: base + every * 500, rpt: gps(jitterMeters(center, U(r, -9000, 9000), U(r, -9000, 9000)), 20), answer: null };
    return [...crash, lone]; }).flat(),
  nolocation: ({ r }) => Array.from({ length: 6 }, (_, i) => ({ at: i * 1000, rpt: none(r, i % 2 === 0), answer: null })),
};
