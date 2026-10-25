import { streamUrl } from './api'; import { useStore } from './store';
let es, retry = 1;
export function startSSE() {
  const S = () => useStore.getState(); let first = true;
  const open = () => {
    S().setConn('reconnecting'); es = new EventSource(streamUrl());
    es.onopen = () => { S().setConn('connected'); retry = 1; if (!first) S().loadAll(); first = false; };
    const on = (n, f) => es.addEventListener(n, e => f(JSON.parse(e.data)));
    on('notification', d => S().onNotification(d)); on('event_created', d => S().onEventCreated(d));
    on('event_updated', d => S().onEventUpdated(d)); on('case_updated', d => S().onCaseUpdated(d));
    on('settings_updated', d => S().onSettings(d)); es.addEventListener('ping', () => {});
    es.onerror = () => { es.close(); S().setConn('offline'); setTimeout(open, Math.min(retry, 10) * 1000); retry *= 2; };
  };
  open(); return () => es?.close();
}
