// ONE location reading. Never watchPosition (privacy promise).
import { C } from './config.js';

export function getLocationOnce() {
  const none = { lat: null, lng: null, accuracy_m: null, loc_source: 'none' };
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve(none);
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    navigator.geolocation.getCurrentPosition(
      p => finish({
        lat: p.coords.latitude,
        lng: p.coords.longitude,
        accuracy_m: Math.round(p.coords.accuracy),
        loc_source: 'gps',
      }),
      () => finish(none),
      { enableHighAccuracy: true, timeout: C.GPS_TIMEOUT_MS, maximumAge: C.GPS_MAX_AGE_MS }
    );
    setTimeout(() => finish(none), C.GPS_TIMEOUT_MS + 1000); // safety net
  });
}
