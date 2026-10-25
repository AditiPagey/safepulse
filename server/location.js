const net = require('net');
const geoip = require('geoip-lite');
const { query } = require('./db');

function cleanIp(ip) {
  if (!ip) return null;
  const v = String(ip).replace(/^::ffff:/, '');
  return net.isIP(v) ? v : null;
}

// Three tiers: gps (from phone) -> ip (offline geoip) -> region centroid.
// Returns {lat, lng, accuracy_m, loc_source} or null when nothing resolves.
async function resolveLocation({ lat, lng, accuracy_m, ip, home_region }, settings) {
  if (lat != null && lng != null) {
    return { lat, lng, accuracy_m: accuracy_m == null ? 50 : accuracy_m, loc_source: 'gps' };
  }
  const cleaned = cleanIp(ip);
  if (cleaned) {
    const hit = geoip.lookup(cleaned);
    if (hit && Array.isArray(hit.ll)) {
      return { lat: hit.ll[0], lng: hit.ll[1], accuracy_m: settings.ip_accuracy_m, loc_source: 'ip' };
    }
  }
  if (home_region) {
    const { rows } = await query('SELECT lat, lng FROM regions WHERE code = $1', [home_region]);
    if (rows[0]) {
      return { lat: rows[0].lat, lng: rows[0].lng, accuracy_m: settings.region_accuracy_m, loc_source: 'region' };
    }
  }
  return null;
}

module.exports = { resolveLocation, cleanIp };
