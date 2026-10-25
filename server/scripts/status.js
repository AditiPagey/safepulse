#!/usr/bin/env node
// Dev tool: print events, queue state and event tables.  node scripts/status.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const { query, pool } = require('../db');

(async () => {
  const ev = await query(
    `SELECT event_id, type, status, total, pending, safe, unsafe, no_response, found_safe,
            round(radius_m::numeric) AS radius_m, is_sim
     FROM event_index ORDER BY opened_at`
  );
  console.log('EVENTS'); console.table(ev.rows);
  const n = await query(
    `SELECT count(*) FILTER (WHERE event_id IS NULL) AS unassigned,
            count(*) FILTER (WHERE event_id IS NOT NULL) AS assigned,
            count(*) FILTER (WHERE NOT counted) AS uncounted
     FROM notifications`
  );
  console.log('QUEUE'); console.table(n.rows);
  const t = await query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name ~ '^ev(sim)?_[0-9]' ORDER BY 1"
  );
  console.log('event tables:', t.rows.map((r) => r.table_name).join(', ') || '(none)');
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
