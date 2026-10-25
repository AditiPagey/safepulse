import { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Circle, CircleMarker, Tooltip, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { useStore, useVisible } from './store';
import { api, clock, exportUrl } from './api';
import { startSSE } from './sse';

const CENTER = (import.meta.env.VITE_MAP_CENTER || '37.7749,-122.4194').split(',').map(Number);
const COLOR = { pending:'#E0A100', safe:'#1E8E4E', unsafe:'#D32030', no_response:'#3B4650', found_safe:'#1F6FD1' };
const GLYPH = { pending:'…', safe:'✓', unsafe:'!', no_response:'?', found_safe:'★' };
const LABEL = { pending:'Pending', safe:'Safe', unsafe:'Needs help', no_response:'No response', found_safe:'Found safe' };
const hhmmss = iso => iso ? new Date(iso).toLocaleTimeString([], { hour12:false }) : '–';
const ago = iso => { const s = Math.max(0, Math.round((clock.now() - Date.parse(iso)) / 1000)); return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s/60)}m` : `${Math.round(s/3600)}h`; };
// Pending past its deadline counts as No response right away (server confirms via SSE shortly after).
const eff = c => c.status === 'pending' && Date.parse(c.deadline_ts) <= clock.now() ? 'no_response' : c.status;
const Status = ({ s }) => <span className={`chip st-${s}`}>{GLYPH[s]} {LABEL[s]}</span>;
const Loc = ({ c }) => <span className={`chip ${c.loc_source === 'gps' ? 'precise' : 'approx'}`}>{c.loc_source === 'gps' ? 'Precise' : 'Approx'} ±{c.accuracy_m ?? '?'} m</span>;

function useTick() { const [, t] = useState(0); useEffect(() => { const i = setInterval(() => t(x => x + 1), 1000); return () => clearInterval(i); }, []); }
function Countdown({ ts }) { useTick(); const s = Math.max(0, Math.round((Date.parse(ts) - clock.now()) / 1000));
  return <b className={s < 10 ? 'red' : ''}>{String(Math.floor(s/60)).padStart(2,'0')}:{String(s%60).padStart(2,'0')}</b>; }

function TopBar({ onSettings }) {
  const { connection, showSim, setShowSim, simRunning, simToggle, clearSim } = useStore(); const [age, setAge] = useState('0'); useTick();
  const label = { 0: 'all simulated data', 60: 'simulated data older than 1 minute', 300: 'simulated data older than 5 minutes' }[age];
  return <header className="top"><h1>SafePulse</h1><span className="demo">DEMO MODE</span>
    <span className={`conn ${connection}`}>● {connection}</span><span className="grow" />
    <button className={simRunning ? 'stop' : ''} onClick={simToggle}>{simRunning ? '■ Stop simulation' : '▶ Start simulation'}</button>
    <select aria-label="Which simulated data to clear" value={age} onChange={e => setAge(e.target.value)}><option value="0">All simulated</option><option value="60">Older than 1 min</option><option value="300">Older than 5 min</option></select>
    <button onClick={() => confirm(`Remove ${label}? This cannot be undone.`) && clearSim(+age)}>Clear</button>
    <label className="tog"><input type="checkbox" checked={showSim} onChange={e => setShowSim(e.target.checked)} /> Show simulated</label>
    <button onClick={onSettings}>Settings</button><time>{new Date(clock.now()).toLocaleTimeString([], { hour12:false })}</time></header>;
}

function EventList({ tab, setTab }) {
  const { selectedId, selectedSignalId, selectEvent, selectSignal, flash } = useStore(); const { events, inbox } = useVisible();
  const rows = events.filter(e => (tab === 'active') === (e.status === 'active')).sort((a, b) => b.opened_at.localeCompare(a.opened_at));
  const roots = rows.filter(e => !e.parent_event_id || !rows.some(r => r.event_id === e.parent_event_id));
  const sigs = [...inbox].sort((a, b) => b.event_ts.localeCompare(a.event_ts));
  const card = (e, nested) => <button key={e.event_id} className={`card ${selectedId === e.event_id ? 'sel' : ''} ${flash === e.event_id ? 'flash' : ''} ${nested ? 'nested' : ''}`} onClick={() => selectEvent(e.event_id)}>
      <b>{e.type === 'disaster' ? '▲ Disaster' : '■ Accident'}</b> <span className="muted">{e.short_name || e.event_id.slice(-6)} · {ago(e.opened_at)}</span>{e.is_sim && <span className="chip sim">SIM</span>}
      <div className="counts"><span>{e.counts.total} total</span><span className="g">{e.counts.safe} safe</span><span className="r">{e.counts.unsafe} help</span><span>{e.counts.no_response} none</span></div></button>;
  return <aside className="left"><div className="tabs"><button className={tab==='active'?'on':''} onClick={() => setTab('active')}>Active</button>
    <button className={tab==='signals'?'on':''} onClick={() => setTab('signals')}>Signals {inbox.length}</button>
    <button className={tab==='resolved'?'on':''} onClick={() => setTab('resolved')}>History</button></div>
    {tab === 'signals' ? <>
      <p className="muted">Single phones that reported a shake. Not incidents unless more people report nearby.</p>
      {sigs.length === 0 && <p className="empty">No isolated signals.</p>}
      {sigs.map(w => <button key={w.report_id} className={`card ${selectedSignalId === w.report_id ? 'sel' : ''}`} onClick={() => selectSignal(w.report_id)}>
        <b>○ {w.report_id.slice(0, 6)}</b> <span className="muted">{hhmmss(w.event_ts)} · {ago(w.event_ts)} ago</span>
        <div className="counts"><Loc c={w} />{w.is_sim && <span className="chip sim">SIM</span>}{w.lat == null && <span className="chip">No location</span>}</div></button>)}</> : <>
      <button className="inboxcard" onClick={() => setTab('signals')}>Isolated signals: <b>{inbox.length}</b> (view)</button>
      {roots.length === 0 && <p className="empty">No incidents. Watching for signals.</p>}
      {roots.map(e => [card(e), ...rows.filter(c => c.parent_event_id === e.event_id).map(c => card(c, true))])}</>}</aside>;
}

function Fly() { const map = useMap(); const fly = useStore(s => s.fly);
  useEffect(() => { if (!fly) return; const z = Math.min(17, Math.max(4, Math.round(15.5 - Math.log2(fly.radius_m / 300))));
    map.flyTo([fly.center.lat, fly.center.lng], z, { duration: 1.2 }); }, [fly]); return null; }

function MapView() {
  const { selectedId, selectedSignalId, cases, flash, selectEvent, selectSignal } = useStore(); const { events: all, inbox } = useVisible();
  const events = all.filter(e => e.status === 'active' || e.event_id === selectedId);
  useTick(); const list = Object.values(cases[selectedId] || {}).map(c => ({ ...c, status: eff(c) }));
  return <main className="map"><MapContainer center={CENTER} zoom={Number(import.meta.env.VITE_MAP_ZOOM || 12)} style={{ height:'100%' }}>
    <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="© OpenStreetMap" /><Fly />
    {inbox.filter(w => w.lat != null).map(w => { const sel = w.report_id === selectedSignalId;
      return <CircleMarker key={w.report_id} center={[w.lat, w.lng]} radius={sel ? 10 : 5} eventHandlers={{ click: () => selectSignal(w.report_id) }}
        pathOptions={{ color: sel ? '#14202B' : '#6b7680', weight: sel ? 3 : 2, fillColor: '#6b7680', fillOpacity: sel ? .6 : 0 }}>
        <Tooltip>Watch signal · {hhmmss(w.event_ts)} · {w.loc_source} ±{w.accuracy_m} m</Tooltip></CircleMarker>; })}
    {events.map(e => <Circle key={e.event_id} center={[e.center.lat, e.center.lng]} radius={e.radius_m}
      eventHandlers={{ click: () => selectEvent(e.event_id) }}
      pathOptions={{ color: e.type === 'disaster' ? '#D32030' : '#E8710A', weight: selectedId === e.event_id ? 3 : 1.5, fillOpacity: .12, className: flash === e.event_id ? 'pulse' : '' }} />)}
    {list.map(c => { const approx = c.loc_source !== 'gps'; return <span key={c.report_id}>
      {approx && c.accuracy_m > 0 && <Circle center={[c.lat, c.lng]} radius={c.accuracy_m} pathOptions={{ color: COLOR[c.status], weight: 1, dashArray: '6 6', fillOpacity: .04 }}><Tooltip>approx</Tooltip></Circle>}
      <CircleMarker center={[c.lat, c.lng]} radius={c.status === 'unsafe' ? 9 : 7} pathOptions={{ color: c.status === 'no_response' ? '#fff' : '#fff', weight: c.status === 'no_response' ? 3 : 1.5, fillColor: COLOR[c.status], fillOpacity: 1 }}>
        <Tooltip>{c.user_short} · {hhmmss(c.event_ts)} · {LABEL[c.status]} · {c.loc_source} ±{c.accuracy_m} m</Tooltip></CircleMarker></span>; })}
  </MapContainer></main>;
}

const post = async (path, body) => { const { toast } = useStore.getState(); try { return await api(path, { method:'POST', body }); } catch (e) { if (e.status !== 409) toast(e.message, 'error'); throw e; } };

function SignalDetail({ w }) { const { toast } = useStore();
  return <aside className="right"><h2>○ Watch signal {w.is_sim && <span className="chip sim">SIMULATED</span>}</h2>
    <p className="muted">One phone reported a shake at {hhmmss(w.event_ts)}. It is not an incident yet: it needs more people nearby.</p>
    <div className="row"><code>{w.report_id.slice(0, 6)}</code><Loc c={w} /><span>score {w.score}</span></div>
    {w.lat != null ? <><p className="coords">{w.lat.toFixed(5)}, {w.lng.toFixed(5)}</p><footer>
      <button onClick={() => navigator.clipboard.writeText(`${w.lat}, ${w.lng}`).then(() => toast('Coordinates copied', 'ok'))}>Copy coordinates</button>
      <a className="btn" href={`https://www.google.com/maps?q=${w.lat},${w.lng}`} target="_blank" rel="noreferrer">Open in Maps</a></footer></> : <p className="empty">No location reading for this signal.</p>}</aside>; }

function Detail() {
  const { selectedId, events, cases, selectEvent, toast } = useStore(); const [tab, setTab] = useState('safe'); useTick();
  const sig = useStore(s => s.inbox.find(w => w.report_id === s.selectedSignalId)); if (sig) return <SignalDetail w={sig} />;
  const ev = events[selectedId]; if (!ev) return <aside className="right"><p className="empty">Select an incident.</p></aside>;
  const all = Object.values(cases[selectedId] || {}).map(c => ({ ...c, status: eff(c) })); const resolved = ev.status === 'resolved';
  const safe = all.filter(c => c.status === 'safe' || c.status === 'found_safe');
  const pend = all.filter(c => c.status === 'pending');
  const miss = all.filter(c => c.status === 'no_response' || c.status === 'unsafe')
    .sort((a, b) => (b.status === 'unsafe') - (a.status === 'unsafe') || a.event_ts.localeCompare(b.event_ts));
  const unsent = safe.filter(c => !c.shelters_sent_at).length;
  const sendShelters = async () => { if (!confirm(`Send shelters to ${unsent} safe users?`)) return;
    try { const r = await post(`/api/dept/events/${selectedId}/send-shelters`); toast(`Shelters sent to ${r.sent_count}`, 'ok'); } catch {} };
  const foundSafe = async c => { if (!confirm(`Mark ${c.user_short} as found safe?`)) return; try { await post(`/api/dept/events/${selectedId}/cases/${c.report_id}/found-safe`); } catch {} };
  const resolve = async () => { if (!confirm(`Resolve this incident? ${ev.counts.pending} pending.`)) return;
    try { await post(`/api/dept/events/${selectedId}/resolve`, {}); } catch (e) {
      if (e.status === 409 && confirm(`${ev.counts.pending} people are still pending. Resolve anyway?`)) { try { await post(`/api/dept/events/${selectedId}/resolve`, { force: true }); } catch {} } }
    selectEvent(selectedId); };
  const T = ({ id, n, children }) => <button className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{children} <b>{n}</b></button>;
  return <aside className="right">
    {resolved && <div className="frozen">Frozen record · resolved {hhmmss(ev.resolved_at)}</div>}
    <h2>{ev.type === 'disaster' ? '▲ Disaster' : '■ Accident'} <span className={`chip ${ev.is_sim ? 'sim' : ''}`}>{ev.is_sim ? 'SIMULATED' : ev.status}</span></h2>
    <p className="muted">Opened {hhmmss(ev.opened_at)} · first signal {hhmmss(ev.first_signal_ts)} · radius {ev.radius_m} m</p>
    <div className="tabs"><T id="safe" n={safe.length}>Safe</T><T id="pending" n={pend.length}>Pending</T><T id="miss" n={miss.length}>No response</T></div>
    <div className="rows">
      {tab === 'safe' && safe.map(c => <div className="row" key={c.report_id}><code>{c.user_short}</code><span>{hhmmss(c.answer_ts)}</span><Loc c={c} />
        <span>{c.status === 'found_safe' ? <Status s="found_safe" /> : c.shelters_sent_at ? `sent ${hhmmss(c.shelters_sent_at)}` : 'not sent'}</span></div>)}
      {tab === 'pending' && pend.map(c => <div className="row" key={c.report_id}><code>{c.user_short}</code><Countdown ts={c.deadline_ts} /><span>score {c.score}</span><Loc c={c} /></div>)}
      {tab === 'miss' && miss.map(c => <div className="row" key={c.report_id}>
        <code>{c.user_short}</code><span>{hhmmss(c.event_ts)}</span><Status s={c.status} />{c.late && <span className="chip">Late</span>}
        <span className="coords">{c.lat?.toFixed(5)}, {c.lng?.toFixed(5)}</span><Loc c={c} />
        <span className="acts"><button disabled={c.status === 'found_safe'} onClick={() => foundSafe(c)}>Found safe</button>
          <button onClick={() => navigator.clipboard.writeText(`${c.lat}, ${c.lng}`).then(() => toast('Coordinates copied', 'ok'))}>Copy</button>
          <a href={`https://www.google.com/maps?q=${c.lat},${c.lng}`} target="_blank" rel="noreferrer">Maps</a></span></div>)}
    </div>
    <footer>
      {tab === 'safe' && <button className="primary" disabled={!unsent} onClick={sendShelters}>Send shelters to safe users ({unsent})</button>}
      {tab === 'miss' && <a className="btn" href={exportUrl(selectedId)}>Export CSV</a>}
      {!resolved && <button className="danger" onClick={resolve}>Resolve incident</button>}
      {resolved && <a className="btn" href={exportUrl(selectedId)}>Export CSV</a>}
    </footer></aside>;
}

function Settings({ onClose }) {
  const { settings, toast } = useStore(); const [f, setF] = useState(() => JSON.parse(JSON.stringify(settings || {})));
  const num = (path, v) => setF(s => { const n = structuredClone(s); const k = path.split('.'); let o = n; k.slice(0, -1).forEach(p => o = o[p] ||= {}); o[k.at(-1)] = Number(v); return n; });
  const save = async () => { try { await api('/api/dept/settings', { method:'PUT', body: f }); toast('Settings saved', 'ok'); onClose(); } catch (e) { toast(e.message, 'error'); } };
  const fields = [['radius_m', 'Radius (m)'], ['window_s', 'Window (s)'], ['min_count', 'Min people'], ['max_accuracy_m', 'Max accuracy (m)']];
  return <div className="drawer"><h2>Rules</h2><p className="muted">Changes apply to future reports only.</p>
    {['accident', 'disaster'].map(t => <fieldset key={t}><legend>{t}</legend>{fields.map(([k, l]) => <label key={k}>{l}<input type="number" value={f[t]?.[k] ?? ''} onChange={e => num(`${t}.${k}`, e.target.value)} /></label>)}</fieldset>)}
    <label>Answer timeout (s)<input type="number" value={f.timeout_seconds ?? ''} onChange={e => num('timeout_seconds', e.target.value)} /></label>
    <div className="acts"><button className="primary" onClick={save}>Save</button><button onClick={onClose}>Close</button></div></div>;
}

export default function App() {
  const loadAll = useStore(s => s.loadAll); const toasts = useStore(s => s.toasts); const [tab, setTab] = useState('active'); const [drawer, setDrawer] = useState(false);
  useEffect(() => { loadAll(); return startSSE(); }, []);
  return <div className="app"><TopBar onSettings={() => setDrawer(true)} /><div className="body"><EventList tab={tab} setTab={setTab} /><MapView /><Detail /></div>
    {drawer && <Settings onClose={() => setDrawer(false)} />}
    <div className="toasts">{toasts.map(t => <div key={t.id} className={`toast ${t.kind}`}>{t.msg}</div>)}</div></div>;
}
