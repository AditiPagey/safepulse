import { create } from 'zustand';
import { api } from './api';
const byId = (rows, k='event_id') => Object.fromEntries(rows.map(r => [r[k], r]));
export const useStore = create((set, get) => ({
  events: {}, cases: {}, inbox: [], settings: null, selectedId: null, selectedSignalId: null,
  showSim: import.meta.env.VITE_SHOW_SIM !== 'false', simRunning: false,
  connection: 'reconnecting', fly: null, flash: null, toasts: [],
  toast(msg, kind='info') { const id = Math.random(); set(s => ({ toasts: [...s.toasts, { id, msg, kind }] }));
    setTimeout(() => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })), 5000); },
  setShowSim: v => set({ showSim: v }), setConn: c => set({ connection: c }),
  async loadAll() { // initial load + every SSE reconnect
    try {
      const [ev, inbox, settings, sum] = await Promise.all([api('/api/dept/events?status=all'), api('/api/dept/inbox'), api('/api/dept/settings'), api('/api/dept/summary').catch(() => ({}))]);
      set({ events: byId(ev.events || ev), inbox: inbox.items || inbox, settings, simRunning: !!sum.sim_running });
      const sel = get().selectedId; if (sel && get().events[sel]) await get().selectEvent(sel, false); else if (sel) set({ selectedId: null });
    } catch (e) { get().toast(e.message, 'error'); } // keep last good data
  },
  selectSignal(id) { const w = get().inbox.find(x => x.report_id === id); set({ selectedSignalId: id, selectedId: null });
    if (w?.lat != null) set({ fly: { center: { lat: w.lat, lng: w.lng }, radius_m: 300, n: Math.random() } }); },
  async simToggle() { const run = get().simRunning; const no = e => get().toast(e.status === 404 ? 'This server has no simulation endpoint. In a terminal run: npm run sim -- mixed' : e.message, 'error');
    try { await api(`/api/dept/sim/${run ? 'stop' : 'start'}`, { method: 'POST', body: {} }); set({ simRunning: !run }); get().toast(run ? 'Simulation stopped' : 'Simulation started', 'ok'); } catch (e) { no(e); } },
  async clearSim(olderThanS) { try { const r = await api('/api/dept/sim/clear', { method: 'POST', body: { older_than_s: olderThanS } }); await get().loadAll();
      get().toast(`Cleared ${r.events} simulated incidents and ${r.signals} signals`, 'ok'); } catch (e) { get().toast(e.status === 404 ? 'This server cannot clear simulated data' : e.message, 'error'); } },
  async selectEvent(id, fly = true) {
    set({ selectedId: id, selectedSignalId: null });
    try { const d = await api(`/api/dept/events/${id}`);
      set(s => ({ events: { ...s.events, [id]: d.event }, cases: { ...s.cases, [id]: byId(d.cases, 'report_id') } }));
      if (fly) set({ fly: { center: d.event.center, radius_m: d.event.radius_m, n: Math.random() } });
    } catch (e) { get().toast(e.message, 'error'); }
  },
  // SSE handlers
  onNotification: n => set(s => ({ inbox: [n, ...s.inbox.filter(x => x.report_id !== n.report_id)] })),
  onEventCreated(ev) { set(s => ({ events: { ...s.events, [ev.event_id]: ev }, fly: { center: ev.center, radius_m: ev.radius_m, n: Math.random() },
      flash: ev.event_id, inbox: s.inbox.filter(w => !(w.lat != null && dist(w, ev.center) <= ev.radius_m)) }));
    get().toast(`New ${ev.type} incident: ${ev.counts?.total ?? '?'} people`, 'alert'); setTimeout(() => set({ flash: null }), 4000); },
  onEventUpdated: ev => set(s => ({ events: { ...s.events, [ev.event_id]: ev } })),
  onCaseUpdated: ({ event_id, case: c }) => set(s => s.cases[event_id] || s.selectedId === event_id
      ? { cases: { ...s.cases, [event_id]: { ...(s.cases[event_id] || {}), [c.report_id]: c } } } : {}),
  onSettings: settings => set({ settings }),
}));
export function dist(a, b) { const R = 6371000, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat/2)**2 + Math.cos(a.lat*r) * Math.cos(b.lat*r) * Math.sin(dLng/2)**2; return 2 * R * Math.asin(Math.sqrt(h)); }
export const useVisible = () => { const { events, inbox, showSim } = useStore();
  return { events: Object.values(events).filter(e => showSim || !e.is_sim), inbox: inbox.filter(i => showSim || !i.is_sim) }; };
