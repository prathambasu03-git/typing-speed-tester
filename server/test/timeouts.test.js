'use strict';

/* Socket integration: the rematch (idle) timeout, the join timeout, the
   disconnect after a failed join, the passage fallback, and the idempotent
   rematch while waiting. Timers are shortened through createServer options. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { setup, sleep, FIXED_PASSAGE } = require('./helpers');
const { createMemoryRoomStore } = require('../src/roomStore');
const { PASSAGE_WORD_COUNT } = require('../src/constants');

const REMATCH_MS = 150;
const JOIN_MS = 150;

/** Polls `check` until it returns true, or fails after `timeoutMs`. */
async function eventually(check, message, timeoutMs = 1000) {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${message}`);
    await sleep(5);
  }
}

/** Records how many events the client had seen when it was disconnected. */
function trackDisconnect(client) {
  return new Promise((resolve) => {
    client.socket.once('disconnect', (reason) => resolve({ reason, eventCount: client.events.length }));
  });
}

/** Two players race and both finish; resolves once both saw room:state finished. */
async function finishedRoom(ctx) {
  const [a, b] = await ctx.racing();
  a.progress(1, FIXED_PASSAGE);
  b.progress(1, FIXED_PASSAGE);
  await a.waitFor('room:state', (s) => s.phase === 'finished');
  await b.waitFor('room:state', (s) => s.phase === 'finished');
  return [a, b];
}

/* ---------- Idle timeout after a race ---------- */

test('a player who does not rematch gets IDLE_TIMEOUT before the server disconnects them', async (t) => {
  const ctx = await setup(t, { rematchTimeoutMs: REMATCH_MS });
  const [a, b] = await finishedRoom(ctx);
  const bGone = trackDisconnect(b);
  assert.equal((await a.rematch()).ok, true);

  const error = await b.waitFor('game:error', (e) => e.code === 'IDLE_TIMEOUT', 1500);
  assert.equal(typeof error.payload.message, 'string');
  const { reason, eventCount } = await bGone;
  assert.equal(reason, 'io server disconnect');
  assert.ok(error.index < eventCount, 'game:error arrived before the disconnect');
});

test('the player who rematched stays connected and sees the room go back to waiting after the idle timeout', async (t) => {
  const ctx = await setup(t, { rematchTimeoutMs: REMATCH_MS });
  const [a, b] = await finishedRoom(ctx);
  await a.rematch();
  await b.disconnected;

  const state = await a.waitFor('room:state', (s) => s.phase === 'waiting', 1500);
  assert.deepEqual(state.payload.players.map((p) => [p.id, p.ready]), [[a.playerId, true]]);
  assert.equal(a.socket.connected, true);
  assert.equal(a.pending('game:error').length, 0);
});

test('a new player can join after the idle timeout and a countdown starts', async (t) => {
  const ctx = await setup(t, { rematchTimeoutMs: REMATCH_MS });
  const [a, b] = await finishedRoom(ctx);
  await a.rematch();
  await b.disconnected;
  await a.waitFor('room:state', (s) => s.phase === 'waiting', 1500);

  const c = await ctx.joined();
  assert.equal(c.joinAck.room.phase, 'waiting');
  await a.waitFor('race:countdown');
  await c.waitFor('race:countdown');
  await c.waitFor('race:start');
});

test('when both players stay idle both are removed and the room is deleted', async (t) => {
  const store = createMemoryRoomStore();
  const ctx = await setup(t, { store, rematchTimeoutMs: REMATCH_MS });
  const [a, b] = await finishedRoom(ctx);

  await a.waitFor('game:error', (e) => e.code === 'IDLE_TIMEOUT', 1500);
  await b.waitFor('game:error', (e) => e.code === 'IDLE_TIMEOUT', 1500);
  assert.equal(await a.disconnected, 'io server disconnect');
  assert.equal(await b.disconnected, 'io server disconnect');
  await eventually(() => store.getRoom('main') === null, 'room deleted');
});

test('a fresh client after both players went idle gets a new waiting room', async (t) => {
  const ctx = await setup(t, { rematchTimeoutMs: REMATCH_MS });
  const [a, b] = await finishedRoom(ctx);
  await Promise.all([a.disconnected, b.disconnected]);

  const c = await ctx.joined();
  assert.equal(c.joinAck.room.phase, 'waiting');
  assert.deepEqual(c.joinAck.room.players.map((p) => [p.slot, p.ready]), [[1, true]]);
});

test('a player who joined the finished room is not removed by the idle timeout', async (t) => {
  const ctx = await setup(t, { rematchTimeoutMs: 300 });
  const [a, b] = await finishedRoom(ctx);
  await b.close();
  await a.waitFor('room:state', (s) => s.players.length === 1);
  const c = await ctx.joined();

  await a.waitFor('game:error', (e) => e.code === 'IDLE_TIMEOUT', 1500);
  await a.disconnected;
  const state = await c.waitFor('room:state', (s) => s.phase === 'waiting', 1500);
  assert.deepEqual(state.payload.players.map((p) => p.id), [c.playerId]);
  assert.equal(c.socket.connected, true);
  assert.equal(c.pending('game:error').length, 0);
});

test('the rematch timer does not fire once both players rematched and the next race runs', async (t) => {
  const ctx = await setup(t, { rematchTimeoutMs: REMATCH_MS, raceTimeLimitMs: 5000 });
  const [a, b] = await finishedRoom(ctx);
  await a.rematch();
  await b.rematch();
  await a.waitFor('race:countdown');
  await Promise.all([a.waitFor('race:start'), b.waitFor('race:start')]);
  a.drain();
  b.drain();

  await sleep(REMATCH_MS * 3);
  for (const c of [a, b]) {
    assert.equal(c.socket.connected, true);
    assert.equal(c.events.filter((e) => e.name === 'game:error').length, 0);
    assert.equal(c.pending('room:state').length, 0);
  }
  // The race is still live.
  a.progress(1, 'a');
  await b.waitFor('race:update', (u) => u.players.some((p) => p.id === a.playerId && p.correctChars === 1));
});

test('a repeated rematch while waiting after an idle timeout sends only the ack', async (t) => {
  const ctx = await setup(t, { rematchTimeoutMs: REMATCH_MS });
  const [a, b] = await finishedRoom(ctx);
  await a.rematch();
  await b.disconnected;
  await a.waitFor('room:state', (s) => s.phase === 'waiting', 1500);
  const before = a.events.length;

  const ack = await a.rematch();
  assert.equal(ack.ok, true);
  assert.equal(ack.room.phase, 'waiting');
  await sleep(100);
  assert.deepEqual(a.events.slice(before).map((e) => e.name), []);
});

/* ---------- Join timeout ---------- */

test('a socket that never joins is disconnected after the join timeout with no event first', async (t) => {
  const ctx = await setup(t, { joinTimeoutMs: JOIN_MS });
  const a = await ctx.client();
  const started = performance.now();
  assert.equal(await a.disconnected, 'io server disconnect');
  assert.ok(performance.now() - started >= JOIN_MS - 20, 'not before the join timeout');
  assert.deepEqual(a.events.map((e) => e.name), []);
});

test('a socket that joins in time is not disconnected by the join timeout', async (t) => {
  const ctx = await setup(t, { joinTimeoutMs: JOIN_MS });
  const a = await ctx.joined();
  await sleep(JOIN_MS * 3);
  assert.equal(a.socket.connected, true);
});

/* ---------- Failed joins ---------- */

test('a third client gets the ROOM_FULL ack and is then disconnected by the server', async (t) => {
  const ctx = await setup(t);
  await ctx.joined();
  await ctx.joined();
  const c = await ctx.client();
  const gone = trackDisconnect(c);
  const ack = await c.join();
  assert.equal(ack.error.code, 'ROOM_FULL');
  const { reason } = await gone;
  assert.equal(reason, 'io server disconnect');
});

test('a socket answered ALREADY_JOINED keeps its seat and still races', async (t) => {
  const ctx = await setup(t);
  const a = await ctx.joined();
  assert.equal((await a.join()).error.code, 'ALREADY_JOINED');
  await sleep(50);
  assert.equal(a.socket.connected, true);

  const b = await ctx.joined();
  await a.waitFor('race:start');
  await b.waitFor('race:start');
  a.progress(1, FIXED_PASSAGE);
  const finish = await b.waitFor('player:finish');
  assert.equal(finish.payload.id, a.playerId);
  assert.equal(finish.payload.place, 1);
});

/* ---------- Passage fallback ---------- */

function assertDefaultPassage(passage) {
  assert.equal(typeof passage, 'string');
  assert.ok(passage.length > 0);
  const words = passage.split(' ');
  assert.equal(words.length, PASSAGE_WORD_COUNT);
  assert.ok(words.every((w) => w.length > 0), 'no empty words');
}

test('a pickPassage that throws falls back to a valid passage of words', async (t) => {
  t.mock.method(console, 'error', () => {});
  const ctx = await setup(t, {
    pickPassage: () => {
      throw new Error('test: picker broke');
    },
  });
  const a = await ctx.joined();
  await ctx.joined();
  const countdown = await a.waitFor('race:countdown');
  assertDefaultPassage(countdown.payload.passage);
  await a.waitFor('race:start');
  assert.equal(a.pending('game:error').length, 0);
});

test('a pickPassage that returns an empty string falls back to a valid passage of words', async (t) => {
  t.mock.method(console, 'error', () => {});
  const ctx = await setup(t, { pickPassage: () => '' });
  const a = await ctx.joined();
  await ctx.joined();
  const countdown = await a.waitFor('race:countdown');
  assertDefaultPassage(countdown.payload.passage);
  await a.waitFor('race:start');
  assert.equal(a.pending('game:error').length, 0);
});

/* ---------- No leaks ---------- */

test('the process exits after close() with an unjoined socket and a pending rematch timer', async () => {
  const appPath = path.join(__dirname, '..', 'src', 'app.js');
  const script = `
    const { createServer } = require(${JSON.stringify(appPath)});
    const { io } = require('socket.io-client');
    (async () => {
      const server = createServer({ countdownMs: 20, pickPassage: () => 'ab', rematchTimeoutMs: 60000, joinTimeoutMs: 60000 });
      const port = await server.listen(0);
      const url = 'http://127.0.0.1:' + port;
      const mk = () => new Promise((res) => { const s = io(url, { transports: ['websocket'], reconnection: false, forceNew: true }); s.on('connect', () => res(s)); });
      const a = await mk(); const b = await mk();
      const ended = new Promise((res) => a.on('race:end', res));
      const started = new Promise((res) => b.on('race:start', res));
      await a.emitWithAck('room:join', {}); await b.emitWithAck('room:join', {});
      await started;
      a.emit('race:progress', { seq: 1, keys: 'ab' }); b.emit('race:progress', { seq: 1, keys: 'ab' });
      await ended;
      const idle = await mk();
      await server.close();
      for (const s of [a, b, idle]) s.disconnect();
      console.log('closed');
    })().catch((err) => { console.error(err); process.exit(2); });
  `;
  const child = spawn(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..') });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`process did not exit within 8 s; output: ${out}`));
    }, 8000);
    child.on('exit', (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  assert.equal(code, 0, out);
  assert.match(out, /closed/);
});
