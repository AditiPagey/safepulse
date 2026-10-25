// Nearest shelters for a location. The list is computed on read; only "sent at" is stored.
const { query } = require('./db');
const { getSettings } = require('./config');
const { haversine } = require('./geo');

async function nearest(lat, lng, k = getSettings().shelters_k || 3) {
  const { rows } = await query('SELECT shelter_id, name, address, lat, lng, capacity FROM shelters');
  return rows
    .map((s) => ({ ...s, distance_m: Math.round(haversine(lat, lng, s.lat, s.lng)) }))
    .sort((a, b) => a.distance_m - b.distance_m)
    .slice(0, k);
}

module.exports = { nearest };
