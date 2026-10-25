const { query } = require('./db');
const { env, DEFAULT_SETTINGS } = require('./config');

// ~111 km per degree latitude; longitude scaled by cos(lat).
function offset(lat, lng, dNorthKm, dEastKm) {
  return [
    lat + dNorthKm / 111.0,
    lng + dEastKm / (111.0 * Math.cos((lat * Math.PI) / 180)),
  ];
}

async function seed() {
  const [lat, lng] = env.DEFAULT_CENTER;

  await query(
    `INSERT INTO settings (key, value) VALUES ('main', $1) ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify(DEFAULT_SETTINGS)]
  );

  const { rows: rc } = await query('SELECT count(*)::int AS n FROM regions');
  if (rc[0].n === 0) {
    const regions = [
      ['sim-region', 'Simulation Region', ...offset(lat, lng, 0, 0)],
      ['north-district', 'North District', ...offset(lat, lng, 8, 0)],
      ['east-district', 'East District', ...offset(lat, lng, 0, 8)],
      ['south-district', 'South District', ...offset(lat, lng, -8, 0)],
    ];
    for (const r of regions) {
      await query('INSERT INTO regions (code, name, lat, lng) VALUES ($1,$2,$3,$4)', r);
    }
  }

  const { rows: sc } = await query('SELECT count(*)::int AS n FROM shelters');
  if (sc[0].n === 0) {
    const shelters = [
      ['Central Community Center', '100 Main St', 0.5, 0.5, 400],
      ['Riverside High School', '220 River Rd', 2, -1, 800],
      ['Northgate Rec Center', '15 Northgate Ave', 4, 1, 300],
      ['Eastside Library', '78 East Blvd', 0.5, 4, 150],
      ['Southpark Gymnasium', '9 Park Ln', -3, 0.5, 500],
      ['West End Church Hall', '41 West St', 0, -4, 200],
      ['Harbor Convention Hall', '1 Harbor Way', -1.5, 3, 1200],
      ['Hillcrest Elementary', '300 Hillcrest Dr', 3, -3, 350],
    ];
    for (const [name, address, n, e, capacity] of shelters) {
      const [slat, slng] = offset(lat, lng, n, e);
      await query(
        'INSERT INTO shelters (name, address, lat, lng, capacity) VALUES ($1,$2,$3,$4,$5)',
        [name, address, slat, slng, capacity]
      );
    }
  }
}

module.exports = { seed };
