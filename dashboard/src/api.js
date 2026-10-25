const BASE = import.meta.env.VITE_API_BASE || '';
const KEY = import.meta.env.VITE_DEPT_KEY || 'dev-dept-key';
// Server-time offset: every countdown uses clock.now(), never Date.now().
export const clock = { offset: 0, now: () => Date.now() + clock.offset,
  sync(iso){ const t = Date.parse(iso); if (t) clock.offset = t - Date.now(); } };
export async function api(path, { method='GET', body } = {}) {
  const r = await fetch(BASE + path, { method, body: body ? JSON.stringify(body) : undefined,
    headers: { 'X-Dept-Key': KEY, 'Content-Type': 'application/json' } });
  const st = r.headers.get('X-Server-Time'); if (st) clock.sync(st);
  const j = await r.json().catch(() => null);
  if (!r.ok) { const e = new Error(j?.error?.message || r.statusText); e.status = r.status; e.code = j?.error?.code; e.body = j; throw e; }
  if (j?.server_time) clock.sync(j.server_time);
  return j;
}
export const streamUrl = () => `${BASE}/api/dept/stream?key=${encodeURIComponent(KEY)}`; // EventSource can't set headers
export const exportUrl = id => `${BASE}/api/dept/events/${id}/export.csv?key=${encodeURIComponent(KEY)}`;
