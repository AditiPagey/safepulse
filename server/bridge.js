// Bridges Postgres NOTIFY (sent by the Python table manager) to dashboard SSE.
const { Client } = require('pg');
const { emit } = require('./sse');

const CHANNEL = 'sp_events';
let stopped = false;

function ssl() {
  const url = process.env.DATABASE_URL || '';
  return /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false };
}

async function connect() {
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: ssl() });
  client.on('notification', (msg) => {
    try {
      const { name, payload } = JSON.parse(msg.payload);
      emit(name, payload);
    } catch (e) {
      console.error('bridge: bad payload', e.message);
    }
  });
  const retry = () => {
    if (stopped) return;
    client.removeAllListeners();
    client.end().catch(() => {});
    setTimeout(start, 2000);
  };
  client.on('error', (e) => { console.error('bridge error:', e.message); retry(); });
  client.on('end', retry);
  await client.connect();
  await client.query(`LISTEN ${CHANNEL}`);
  console.log(`bridge: listening on ${CHANNEL}`);
}

function start() {
  connect().catch((e) => {
    console.error('bridge connect failed:', e.message);
    if (!stopped) setTimeout(start, 3000);
  });
}

module.exports = { start, stop: () => { stopped = true; } };
