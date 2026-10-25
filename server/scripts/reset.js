#!/usr/bin/env node
// Dev tool: wipe all events, event tables and reports (keeps users, regions, shelters, settings).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const { query, pool } = require('../db');
const { TABLE_RE, qi } = require('../events');
(async () => {
  const { rows } = await query('SELECT table_name FROM event_index');
  for (const r of rows) if (TABLE_RE.test(r.table_name)) await query(`DROP TABLE IF EXISTS ${qi(r.table_name)}`);
  await query('DELETE FROM event_index');
  await query('DELETE FROM event_log');
  await query('DELETE FROM notifications');
  console.log(`reset: dropped ${rows.length} event table(s), cleared reports and logs`);
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
