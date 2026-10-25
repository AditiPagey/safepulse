const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (e) => console.error('pg pool error:', e.message));

const query = (text, params) => pool.query(text, params);

// Runs fn(client) inside a transaction on ONE connection (needed for advisory locks and DDL).
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

// Global lock serializing evaluate + register. Call inside tx(); released at commit/rollback.
const EVAL_LOCK_KEY = 727001;
const advisoryLock = (client) => client.query('SELECT pg_advisory_xact_lock($1)', [EVAL_LOCK_KEY]);

module.exports = { pool, query, tx, advisoryLock };
