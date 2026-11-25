'use strict';

/* HTTP endpoints, the origin check on Socket.io connections and the per-IP
   connection cap. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, sleep } = require('./helpers');

const PAGES = 'https://prathambasu03-git.github.io';

/** Resolves 'connected' or 'refused' for a client that was not awaited. */
function outcome(client) {
  return client.connected.then(
    () => 'connected',
    () => 'refused'
  );
}

/* ---------- HTTP ---------- */

test('GET /health answers 200 with status ok as JSON', async (t) => {
  const ctx = await setup(t);
  const res = await fetch(`${ctx.url}/health`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('responses do not advertise Express in x-powered-by', async (t) => {
  const ctx = await setup(t);
  const res = await fetch(`${ctx.url}/health`);
  await res.arrayBuffer();
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('an unknown path answers 404', async (t) => {
  const ctx = await setup(t);
  const res = await fetch(`${ctx.url}/nope`);
  await res.arrayBuffer();
  assert.equal(res.status, 404);
});

test('the Socket.io client script is served at /socket.io/socket.io.js', async (t) => {
  const ctx = await setup(t);
  const res = await fetch(`${ctx.url}/socket.io/socket.io.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  const body = await res.text();
  assert.ok(body.length > 1000);
});

/* ---------- Origin check ---------- */

test('a socket from a foreign origin is refused with connect_error', async (t) => {
  const ctx = await setup(t);
  const c = ctx.rawClient({ extraHeaders: { origin: 'https://evil.example' } });
  assert.equal(await outcome(c), 'refused');
});

test('a socket from the GitHub Pages origin connects', async (t) => {
  const ctx = await setup(t, { allowLocalhost: false });
  const c = ctx.rawClient({ extraHeaders: { origin: PAGES } });
  assert.equal(await outcome(c), 'connected');
});

test('a socket from localhost connects only when localhost is allowed', async (t) => {
  const open = await setup(t, { allowLocalhost: true });
  assert.equal(await outcome(open.rawClient({ extraHeaders: { origin: 'http://localhost:8080' } })), 'connected');
  const closed = await setup(t, { allowLocalhost: false });
  assert.equal(await outcome(closed.rawClient({ extraHeaders: { origin: 'http://localhost:8080' } })), 'refused');
});

test('a socket from the null origin connects only when the null origin is allowed', async (t) => {
  const strict = await setup(t);
  assert.equal(await outcome(strict.rawClient({ extraHeaders: { origin: 'null' } })), 'refused');
  const dev = await setup(t, { allowNullOrigin: true });
  assert.equal(await outcome(dev.rawClient({ extraHeaders: { origin: 'null' } })), 'connected');
});

test('a socket from a custom CORS origin list connects only for listed origins', async (t) => {
  const ctx = await setup(t, { corsOrigins: ['https://a.example'], allowLocalhost: false });
  assert.equal(await outcome(ctx.rawClient({ extraHeaders: { origin: 'https://a.example' } })), 'connected');
  assert.equal(await outcome(ctx.rawClient({ extraHeaders: { origin: PAGES } })), 'refused');
});

test('a polling handshake from a foreign origin is refused over HTTP', async (t) => {
  const ctx = await setup(t);
  const res = await fetch(`${ctx.url}/socket.io/?EIO=4&transport=polling`, {
    headers: { origin: 'https://evil.example' },
  });
  await res.arrayBuffer();
  assert.ok(res.status >= 400, `status ${res.status}`);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('a polling handshake from the GitHub Pages origin gets a matching CORS header', async (t) => {
  const ctx = await setup(t);
  const res = await fetch(`${ctx.url}/socket.io/?EIO=4&transport=polling`, { headers: { origin: PAGES } });
  await res.arrayBuffer();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), PAGES);
});

/* ---------- Per-IP connection cap ---------- */

test('connections past the per-IP cap are refused', async (t) => {
  const ctx = await setup(t, { maxConnectionsPerIp: 2 });
  await ctx.client();
  await ctx.client();
  assert.equal(await outcome(ctx.rawClient()), 'refused');
});

test('a slot under the per-IP cap frees up when a client disconnects', async (t) => {
  const ctx = await setup(t, { maxConnectionsPerIp: 2 });
  const first = await ctx.client();
  await ctx.client();
  await first.close();
  // The server notices the close asynchronously; retry briefly.
  let result = 'refused';
  for (let attempt = 0; attempt < 20 && result === 'refused'; attempt += 1) {
    result = await outcome(ctx.rawClient());
    if (result === 'refused') await sleep(20);
  }
  assert.equal(result, 'connected');
});

test('refused connections do not use up the per-IP cap', async (t) => {
  const ctx = await setup(t, { maxConnectionsPerIp: 1 });
  const evil = ctx.rawClient({ extraHeaders: { origin: 'https://evil.example' } });
  assert.equal(await outcome(evil), 'refused');
  assert.equal(await outcome(ctx.rawClient()), 'connected');
});

test('connections opened at the same time still respect the per-IP cap', async (t) => {
  const ctx = await setup(t, { maxConnectionsPerIp: 2 });
  const clients = Array.from({ length: 5 }, () => ctx.rawClient());
  const results = await Promise.all(clients.map(outcome));
  assert.equal(results.filter((r) => r === 'connected').length, 2, results.join(', '));
});

/* ---------- Per-IP cap behind a reverse proxy (TRUST_PROXY_HOPS) ---------- */

const PROXY_OPTIONS = Object.freeze({ trustProxyHops: 1, maxConnectionsPerIp: 1 });

function viaProxy(forwardedFor) {
  return { extraHeaders: { 'x-forwarded-for': forwardedFor } };
}

/**
 * Resolves once the server has closed this client's engine socket. The
 * listener is added after the server's own close handler, so by the time it
 * runs the per-IP counter has already been decremented.
 */
function serverSideClose(ctx, client) {
  const raw = ctx.server.io.engine.clients[client.socket.io.engine.id];
  assert.ok(raw, 'server-side engine socket not found');
  return new Promise((resolve) => raw.once('close', resolve));
}

test('with one trusted hop, clients with different forwarded addresses each get their own slot', async (t) => {
  const ctx = await setup(t, PROXY_OPTIONS);
  assert.equal(await outcome(ctx.rawClient(viaProxy('203.0.113.1'))), 'connected');
  assert.equal(await outcome(ctx.rawClient(viaProxy('203.0.113.2'))), 'connected');
});

test('with one trusted hop, a second client with the same forwarded address is refused', async (t) => {
  const ctx = await setup(t, PROXY_OPTIONS);
  await ctx.client(viaProxy('203.0.113.1'));
  await ctx.client(viaProxy('203.0.113.2'));
  assert.equal(await outcome(ctx.rawClient(viaProxy('203.0.113.1'))), 'refused');
});

test('with one trusted hop, a forwarded address gets its slot back after its client disconnects', async (t) => {
  const ctx = await setup(t, PROXY_OPTIONS);
  const first = await ctx.client(viaProxy('203.0.113.1'));
  await ctx.client(viaProxy('203.0.113.2'));
  assert.equal(await outcome(ctx.rawClient(viaProxy('203.0.113.1'))), 'refused');
  const closed = serverSideClose(ctx, first);
  await first.close();
  await closed;
  assert.equal(await outcome(ctx.rawClient(viaProxy('203.0.113.1'))), 'connected');
});

test('with one trusted hop, a client-written entry left of the proxy entry does not dodge the cap', async (t) => {
  const ctx = await setup(t, PROXY_OPTIONS);
  await ctx.client(viaProxy('203.0.113.1'));
  assert.equal(await outcome(ctx.rawClient(viaProxy('203.0.113.9, 203.0.113.1'))), 'refused');
});

test('with no trusted hops, a different forwarded address does not dodge the cap', async (t) => {
  const ctx = await setup(t, { maxConnectionsPerIp: 1 });
  await ctx.client(viaProxy('203.0.113.1'));
  assert.equal(await outcome(ctx.rawClient(viaProxy('203.0.113.2'))), 'refused');
});
