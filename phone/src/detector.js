// Shake detector: pure logic (no browser APIs), so it can be tested in Node.

// Look at a list of samples {t (ms), mag (m/s2)} and compute the window features.
export function evaluateWindow(samples, c) {
  let peak = 0, above = 0, best = 0, bestStart = null, runStart = null, prevAbove = null;
  for (const s of samples) {
    if (s.mag > peak) peak = s.mag;
    if (s.mag > c.T_LOW) {
      above++;
      // a new "run" starts if the gap since the last strong sample is too big
      if (prevAbove === null || s.t - prevAbove > c.MAX_GAP_MS) runStart = s.t;
      prevAbove = s.t;
      const len = s.t - runStart;
      if (bestStart === null || len > best) { best = len; bestStart = runStart; }
    }
  }
  const duty = samples.length ? above / samples.length : 0;
  const candidate = peak >= c.T_HIGH && best >= c.MIN_SUSTAIN_MS && duty >= c.MIN_DUTY;
  return { peak, duty, sustained_ms: best, runStart: bestStart, candidate };
}

export function computeScore(peak, durationMs, duty, c) {
  const s = 0.4 * Math.min(peak / c.PEAK_REF, 1)
          + 0.4 * Math.min(durationMs / c.DUR_REF_MS, 1)
          + 0.2 * duty;
  return Math.max(0, Math.min(1, s));
}

export class Detector {
  constructor(c) {
    this.c = c;
    this.buf = [];        // last 10 s of {t, mag}
    this.confirm = null;  // set while in the confirm phase
    this.lastStats = null;
  }

  push(t, mag) {
    this.buf.push({ t, mag });
    const cut = t - 10000;
    while (this.buf.length && this.buf[0].t < cut) this.buf.shift();
  }

  // Call every 100 ms. allowed = all guards pass. Returns a trigger or null.
  tick(now, allowed, visible = true) {
    const c = this.c;

    // --- confirm phase: keep measuring until calm or 4 s ---
    if (this.confirm) {
      if (!visible) { this.confirm = null; return null; } // page hidden: abort
      let lastAbove = this.confirm.start;
      for (const s of this.buf) if (s.mag > c.T_LOW && s.t > lastAbove) lastAbove = s.t;
      const quiet = now - lastAbove >= c.CONFIRM_QUIET_MS;
      const timedOut = now - this.confirm.start >= c.CONFIRM_MAX_MS;
      if (!quiet && !timedOut) return null;

      const span = this.buf.filter(s => s.t >= this.confirm.windowStart && s.t <= now);
      this.confirm = null;
      const st = evaluateWindow(span, c);
      return {
        score: computeScore(st.peak, st.sustained_ms, st.duty, c),
        peak: st.peak,                       // m/s2
        duration_ms: Math.round(st.sustained_ms),
        duty: st.duty,
        t_start: st.runStart,                // same clock as sample t
      };
    }

    // --- normal: evaluate the last 3 s ---
    const win = this.buf.filter(s => s.t > now - c.WINDOW_MS);
    const st = evaluateWindow(win, c);
    this.lastStats = st;
    if (st.candidate && allowed && visible) {
      this.confirm = { start: now, windowStart: now - c.WINDOW_MS };
    }
    return null;
  }
}
