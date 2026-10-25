const clients = new Set();

// GET /api/dept/stream (deptAuth applied by the router)
function handler(req, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  res.write(`event: ping\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

function emit(name, payload) {
  const msg = `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of clients) {
    try { c.write(msg); } catch (_) { clients.delete(c); }
  }
}

function startPing() {
  setInterval(() => emit('ping', { time: new Date().toISOString() }), 15000).unref();
}

module.exports = { handler, emit, startPing, clientCount: () => clients.size };
