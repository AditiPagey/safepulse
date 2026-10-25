// Queue that sends reports and answers, with retries. Survives reloads.
import { api } from './api.js';
import { load, save } from './store.js';

const SCHEDULE_S = [0, 2, 5, 10, 20, 30]; // then 30, 30, ...
let queue = load('sp.outbox', []);
let acked = load('sp.acked', []); // report_ids the server has confirmed
let paused = false;
let busy = false;
let lastResponse = null;

const handlers = {
  onSent: () => {}, onRetry: () => {}, onFail: () => {}, onAuth: () => {},
};

export function setOutboxHandlers(h) { Object.assign(handlers, h); }
export const outboxLength = () => queue.length;
export const getLastResponse = () => lastResponse;

function persist() {
  save('sp.outbox', queue);
  save('sp.acked', acked.slice(-50));
}

export function enqueue(kind, payload) {
  queue.push({ kind, payload, attempts: 0, next_try_at: 0 });
  persist();
  processQueue();
}

// After re-registering, queued items must carry the new user_id
export function rewriteUser(user_id) {
  for (const item of queue) item.payload.user_id = user_id;
  persist();
}

export function resumeOutbox() {
  paused = false;
  processQueue();
}

async function processQueue() {
  if (busy || paused) return;
  busy = true;
  try {
    for (const item of [...queue]) {
      if (paused) break;
      if (Date.now() < item.next_try_at) continue;
      // an answer waits until its report has been received by the server
      if (item.kind === 'answer' && !acked.includes(item.payload.report_id)) continue;

      const path = item.kind === 'report' ? '/api/reports' : '/api/answers';
      try {
        const res = await api('POST', path, item.payload);
        lastResponse = res;
        queue = queue.filter(x => x !== item);
        if (item.kind === 'report') acked.push(item.payload.report_id);
        persist();
        handlers.onSent(item, res);
      } catch (e) {
        lastResponse = { error: e.message, status: e.status };
        const st = e.status;
        if (st === 401) {
          paused = true; // keep items; resume after re-register
          handlers.onAuth(item, e);
          break;
        }
        const retry = !st || st >= 500 || st === 408 || st === 429;
        if (retry) {
          item.attempts++;
          const wait = SCHEDULE_S[Math.min(item.attempts, SCHEDULE_S.length - 1)];
          item.next_try_at = Date.now() + wait * 1000;
          persist();
          handlers.onRetry(item, e);
        } else {
          // other 4xx: give up on this item (and answers for a dropped report)
          queue = queue.filter(x => x !== item &&
            !(item.kind === 'report' && x.payload.report_id === item.payload.report_id));
          persist();
          handlers.onFail(item, e);
        }
      }
    }
  } finally {
    busy = false;
  }
}

setInterval(processQueue, 1000);
