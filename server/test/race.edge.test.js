'use strict';

/* Socket integration: edge cases. Full room, double join, leaving during the
   countdown, disconnects mid-race, late and duplicate events, client-sent
   scores, bad payloads, rate limiting, simultaneous finishes, handler errors. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, sleep, FIXED_PASSAGE } = require('./helpers');
const { createMemoryRoomStore } = require('../src/roomStore');

/** Polls `check` until it returns true, or fails after `timeoutMs`. */
async function eventually(check, message, timeoutMs = 1000) {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${message}`);
    await sleep(5);
  }
}

/** The latest race:update entry for `playerId` seen by `client`. */
function latestEntry(client, playerId) {
  const updates = client.events.filter((e) => e.name === 'race:update');
  if (updates.length === 0) return null;
  return updates[updates.length - 1].payload.players.find((p) => p.id === playerId) || null;
}

/* ---------- Joining ---------- */

test('a third client is refused with ROOM_FULL', async (t) => {
  const ctx = await setup(t);
  await ctx.joined();
  await ctx.joined();
  const c = await ctx.client();
  const ack = await c.join();
  assert.equal(ack.ok, false);
  assert.equal(ack.error.code, 'ROOM_FULL');
  assert.equal(typeof ack.error.message, 'string');
});

test('a refused third client receives no room broadcasts', async (t) => {
  const ctx = await setup(t);
  const a = await ctx.joined();
  const b = await ctx.joined();
  const c = await ctx.client();
  await c.join();
  await Promise.all([a.waitFor('race:start'), b.waitFor('race:start')]);
  a.progress(1, 'ab');
  await b.waitFor('race:update');
  assert.deepEqual(c.events.map((e) => e.name), []);
});

test('a refused third client is still refused while the race runs', async (t) => {
  const ctx = await setup(t);
  await ctx.racing();
  const c = await ctx.client();
  assert.equal((await c.join()).error.code, 'ROOM_FULL');
});

test('the same socket joining twice is refused with ALREADY_JOINED and takes one slot', async (t) => {
  const ctx = await setup(t);
  const a = await ctx.joined();
  const again = await a.join();
  assert.equal(again.ok, false);
  assert.equal(again.error.code, 'ALREADY_JOINED');
  const b = await ctx.joined();
  assert.equal(b.joinAck.room.players.length, 2);
});

test('room:join with a payload that is not an object gets BAD_PAYLOAD', async (t) => {
  const ctx = await setup(t);
  for (const payload of [null, 'x', 1, [], true]) {
    const c = await ctx.client();
    const ack = await c.emitAck('room:join', payload);
    assert.equal(ack.ok, false, JSON.stringify(payload));
    assert.equal(ack.error.code, 'BAD_PAYLOAD', JSON.stringify(payload));
    // The ack arrives first, then the server drops the socket.
    assert.equal(await c.disconnected, 'io server disconnect', JSON.stringify(payload));
  }
  // None of them joined the room.
  const d = await ctx.joined();
  assert.equal(d.joinAck.room.players.length, 1);
});

test('room:join with no payload but an ack joins the room', async (t) => {
  const ctx = await setup(t);
  const a = await ctx.client();
  const ack = await a.emitAck('room:join');
  assert.equal(ack.ok, true);
});

test('room:join without an ack gets game:error BAD_PAYLOAD and does not join', async (t) => {
  const ctx = await setup(t);
  const a = await ctx.client();
  a.socket.emit('room:join', {});
  const error = await a.waitFor('game:error');
  assert.equal(error.payload.code, 'BAD_PAYLOAD');
  assert.equal(typeof error.payload.message, 'string');
  const b = await ctx.joined();
  assert.equal(b.joinAck.room.players.length, 1);
});

test('the join ack snapshot never exposes socket ids', async (t) => {
  const ctx = await setup(t);
  const a = await ctx.joined();
  const text = JSON.stringify(a.joinAck);
  assert.ok(!text.includes(a.socket.id));
  assert.deepEqual(Object.keys(a.joinAck.room.players[0]).sort(), ['connected', 'finished', 'id', 'ready', 'slot']);
});

/* ---------- Leaving ---------- */

test('a player leaving during the countdown returns the room to waiting and no race starts', async (t) => {
  const ctx = await setup(t, { countdownMs: 200 });
  const a = await ctx.joined();
  const b = await ctx.joined();
  await a.waitFor('race:countdown');
  await b.close();
  const state = await a.waitFor('room:state', (s) => s.phase === 'waiting' && s.players.length === 1);
  assert.deepEqual(state.payload.players.map((p) => [p.id, p.ready]), [[a.playerId, true]]);
  await sleep(300);
  assert.equal(a.pending('race:start').length, 0);
});

test('a new player after a cancelled countdown starts a fresh countdown', async (t) => {
  const ctx = await setup(t, { countdownMs: 100 });
  const a = await ctx.joined();
  const b = await ctx.joined();
  await a.waitFor('race:countdown');
  await b.close();
  await a.waitFor('room:state', (s) => s.phase === 'waiting' && s.players.length === 1);
  const c = await ctx.joined();
  await a.waitFor('race:countdown');
  await c.waitFor('race:start');
  await a.waitFor('race:start');
});

test('the only player leaving a waiting room deletes the room', async (t) => {
  const store = createMemoryRoomStore();
  const ctx = await setup(t, { store });
  const a = await ctx.joined();
  assert.ok(store.getRoom('main'));
  await a.close();
  await eventually(() => store.getRoom('main') === null, 'room deleted');
});

test('a player who finished sees the race end when the opponent disconnects', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.racing();
  b.progress(1, 'ab');
  a.progress(1, FIXED_PASSAGE);
  await a.waitFor('player:finish');
  await b.close();
  const end = await a.waitFor('race:end');
  assert.equal(end.payload.reason, 'all_finished');
  assert.deepEqual(
    end.payload.results.map((r) => [r.id, r.place, r.status, r.correctChars]),
    [
      [a.playerId, 1, 'finished', 5],
      [b.playerId, 2, 'left', 2],
    ]
  );
  const state = await a.waitFor('room:state', (s) => s.phase === 'finished');
  assert.deepEqual(state.payload.players.map((p) => p.id), [a.playerId]);
});

test('a disconnect mid-race marks the player disconnected and the race goes on', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.racing();
  await b.close();
  const state = await a.waitFor('room:state');
  assert.equal(state.payload.phase, 'racing');
  assert.deepEqual(
    state.payload.players.map((p) => [p.id, p.connected]),
    [
      [a.playerId, true],
      [b.playerId, false],
    ]
  );
  a.progress(1, FIXED_PASSAGE);
  const finish = await a.waitFor('player:finish');
  assert.equal(finish.payload.place, 1);
  const end = await a.waitFor('race:end');
  assert.equal(end.payload.reason, 'all_finished');
  assert.deepEqual(end.payload.results.map((r) => r.status), ['finished', 'left']);
});

test('both players disconnecting mid-race clears the room so a new client gets a fresh waiting room', async (t) => {
  const store = createMemoryRoomStore();
  const ctx = await setup(t, { store, raceTimeLimitMs: 300 });
  const [a, b] = await ctx.racing();
  await a.close();
  await b.close();
  await eventually(() => store.getRoom('main') === null, 'room deleted');

  const c = await ctx.joined();
  assert.equal(c.joinAck.room.phase, 'waiting');
  assert.deepEqual(c.joinAck.room.players.map((p) => p.slot), [1]);
  // The old race-limit timer must not fire into the new room.
  await sleep(400);
  assert.deepEqual(
    c.events.map((e) => e.name),
    ['room:state']
  );
  assert.equal(store.getRoom('main').phase, 'waiting');
});

/* ---------- Late, early and duplicate events ---------- */

test('progress sent during the countdown is ignored', async (t) => {
  const ctx = await setup(t, { countdownMs: 150 });
  const a = await ctx.joined();
  const b = await ctx.joined();
  await a.waitFor('race:countdown');
  a.progress(1, 'ab');
  await a.waitFor('race:start');
  // seq 1 is still unused, so it is accepted now; only this 'a' counts.
  a.progress(1, 'a');
  const update = await b.waitFor('race:update');
  const entry = update.payload.players.find((p) => p.id === a.playerId);
  assert.equal(entry.correctChars, 1);
  assert.equal(a.pending('game:error').length, 0);
});

test('a reused seq is ignored', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.racing();
  a.progress(1, 'a');
  await b.waitFor('race:update', (u) => u.players.some((p) => p.id === a.playerId && p.correctChars === 1));
  a.progress(1, 'b');
  a.progress(2, 'x');
  const update = await b.waitFor('race:update', (u) => u.players.some((p) => p.id === a.playerId && p.accuracy < 100));
  const entry = update.payload.players.find((p) => p.id === a.playerId);
  // Had the reused seq 1 been applied, 'b' would be correct at index 1.
  assert.equal(entry.correctChars, 1);
  assert.equal(entry.accuracy, 50);
});

test('an out-of-order lower seq is ignored', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.racing();
  a.progress(5, 'a');
  a.progress(3, 'b');
  a.progress(6, 'b');
  await b.waitFor('race:update', (u) => u.players.some((p) => p.id === a.playerId && p.correctChars === 2));
  await sleep(60);
  assert.equal(latestEntry(b, a.playerId).correctChars, 2);
  assert.equal(latestEntry(b, a.playerId).accuracy, 100);
});

test('progress after race:end is ignored without an error', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.racing();
  a.progress(1, FIXED_PASSAGE);
  b.progress(1, FIXED_PASSAGE);
  await a.waitFor('room:state', (s) => s.phase === 'finished');
  await b.waitFor('room:state', (s) => s.phase === 'finished');
  a.drain();
  b.drain();
  a.progress(2, 'x');
  await sleep(100);
  assert.deepEqual(a.events.filter((e) => !e.taken).map((e) => e.name), []);
  assert.deepEqual(b.events.filter((e) => !e.taken).map((e) => e.name), []);
});

test('progress from a player who already finished is ignored', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.racing();
  a.progress(1, FIXED_PASSAGE);
  await b.waitFor('player:finish');
  a.progress(2, '\b\b');
  b.progress(1, 'a');
  await b.waitFor('race:update', (u) => u.players.some((p) => p.id === b.playerId && p.correctChars === 1));
  const entry = latestEntry(b, a.playerId);
  assert.equal(entry.correctChars, 5);
  assert.equal(entry.finished, true);
  assert.equal(b.pending('player:finish').length, 0);
});

test('a rematch while racing gets NOT_FINISHED', async (t) => {
  const ctx = await setup(t);
  const [a] = await ctx.racing();
  const ack = await a.rematch();
  assert.equal(ack.ok, false);
  assert.equal(ack.error.code, 'NOT_FINISHED');
});

test('a rematch during the countdown gets NOT_FINISHED', async (t) => {
  const ctx = await setup(t, { countdownMs: 300 });
  const a = await ctx.joined();
  await ctx.joined();
  await a.waitFor('race:countdown');
  const ack = await a.rematch();
  assert.equal(ack.error.code, 'NOT_FINISHED');
});

test('a rematch before joining gets NOT_IN_ROOM', async (t) => {
  const ctx = await setup(t);
  const a = await ctx.client();
  const ack = await a.rematch();
  assert.equal(ack.ok, false);
  assert.equal(ack.error.code, 'NOT_IN_ROOM');
});

test('a rematch with a bad payload gets BAD_PAYLOAD', async (t) => {
  const ctx = await setup(t);
  const a = await ctx.joined();
  for (const payload of [null, 'x', 1, []]) {
    const ack = await a.emitAck('race:rematch', payload);
    assert.equal(ack.error.code, 'BAD_PAYLOAD', JSON.stringify(payload));
  }
});

test('a rematch without an ack gets game:error BAD_PAYLOAD', async (t) => {
  const ctx = await setup(t);
  const a = await ctx.joined();
  a.socket.emit('race:rematch', {});
  assert.equal((await a.waitFor('game:error')).payload.code, 'BAD_PAYLOAD');
});

test('a second rematch while the room is still finished is accepted again', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.racing();
  a.progress(1, FIXED_PASSAGE);
  b.progress(1, FIXED_PASSAGE);
  await a.waitFor('room:state', (s) => s.phase === 'finished');
  assert.equal((await a.rematch()).ok, true);
  assert.equal((await a.rematch()).ok, true);
  await sleep(80);
  assert.equal(a.pending('race:countdown').length, 0);
});

test('progress before joining gets game:error NOT_IN_ROOM', async (t) => {
  const ctx = await setup(t);
  const a = await ctx.client();
  a.progress(1, 'a');
  assert.equal((await a.waitFor('game:error')).payload.code, 'NOT_IN_ROOM');
});

/* ---------- Client-sent scores and bad payloads ---------- */

test('client-sent wpm and finished flags are ignored', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.racing();
  a.socket.emit('race:progress', { seq: 1, keys: 'a', wpm: 999, finished: true, place: 1, correctChars: 5, timeMs: 1 });
  const update = await b.waitFor('race:update');
  const entry = update.payload.players.find((p) => p.id === a.playerId);
  assert.equal(entry.correctChars, 1);
  assert.equal(entry.progress, 20);
  assert.equal(entry.finished, false);
  assert.equal(entry.place, null);
  assert.ok(entry.wpm <= 12, `server wpm ${entry.wpm}`);
  await sleep(60);
  assert.equal(b.pending('player:finish').length, 0);
});

test('progress with 65 keys gets game:error BAD_PAYLOAD', async (t) => {
  const ctx = await setup(t);
  const [a] = await ctx.racing();
  a.progress(1, 'a'.repeat(65));
  const error = await a.waitFor('game:error');
  assert.equal(error.payload.code, 'BAD_PAYLOAD');
});

test('progress with wrong types or missing fields gets game:error BAD_PAYLOAD for each', async (t) => {
  const ctx = await setup(t);
  const [a] = await ctx.racing();
  const bad = [null, 'ab', [1, 'a'], {}, { seq: '1', keys: 'a' }, { seq: 1 }, { seq: 0, keys: 'a' }, { seq: 1, keys: 'a\nb' }];
  for (const payload of bad) a.socket.emit('race:progress', payload);
  for (let i = 0; i < bad.length; i += 1) {
    assert.equal((await a.waitFor('game:error')).payload.code, 'BAD_PAYLOAD', `payload ${i}`);
  }
});

test('a rejected progress event does not use up its seq', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.racing();
  a.progress(5, 'a'.repeat(65));
  await a.waitFor('game:error');
  a.progress(1, 'a');
  const update = await b.waitFor('race:update');
  assert.equal(update.payload.players.find((p) => p.id === a.playerId).correctChars, 1);
});

test('a packet larger than 4 KB closes the connection', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.racing();
  a.progress(1, 'a'.repeat(5000));
  const reason = await a.disconnected;
  assert.equal(typeof reason, 'string');
  // The server treats it as a leave: the opponent sees A disconnected.
  const state = await b.waitFor('room:state');
  assert.equal(state.payload.players.find((p) => p.id === a.playerId).connected, false);
});

test('an unknown event name is ignored without an error', async (t) => {
  const ctx = await setup(t);
  const a = await ctx.joined();
  a.drain();
  a.socket.emit('race:cheat', { finished: true });
  await sleep(60);
  assert.equal(a.pending('game:error').length, 0);
  assert.equal(a.socket.connected, true);
});

/* ---------- Rate limiting ---------- */

test('an event with an ack past the rate limit gets RATE_LIMITED in the ack', async (t) => {
  const ctx = await setup(t, { rateLimit: { capacity: 3, refillPerSec: 0 } });
  const a = await ctx.client();
  assert.equal((await a.join()).ok, true);
  a.progress(1, 'a');
  a.progress(2, 'b');
  const ack = await a.rematch();
  assert.equal(ack.ok, false);
  assert.equal(ack.error.code, 'RATE_LIMITED');
});

test('an event without an ack past the rate limit gets one game:error RATE_LIMITED per second', async (t) => {
  const ctx = await setup(t, { rateLimit: { capacity: 3, refillPerSec: 0 } });
  const a = await ctx.client();
  await a.join();
  a.progress(1, 'a');
  a.progress(2, 'b');
  a.progress(3, 'c');
  a.progress(4, 'd');
  a.progress(5, 'e');
  const error = await a.waitFor('game:error', (e) => e.code === 'RATE_LIMITED');
  assert.equal(typeof error.payload.message, 'string');
  await sleep(100);
  assert.equal(a.pending('game:error').length, 0, 'only one RATE_LIMITED error inside the interval');
});

test('a rate-limited progress event is dropped and not applied', async (t) => {
  const ctx = await setup(t, { rateLimit: { capacity: 2, refillPerSec: 0 } });
  const [a, b] = await ctx.racing();
  // A spent 1 token on join; 1 left.
  a.progress(1, 'a');
  a.progress(2, 'b');
  await a.waitFor('game:error', (e) => e.code === 'RATE_LIMITED');
  await b.waitFor('race:update');
  await sleep(60);
  assert.equal(latestEntry(b, a.playerId).correctChars, 1);
});

test('normal typing at the default limit is never rate-limited', async (t) => {
  const ctx = await setup(t, { rateLimit: undefined });
  const [a, b] = await ctx.racing();
  // 19 events at once is under the default bucket of 20 (join used one).
  for (let seq = 1; seq <= 19; seq += 1) a.progress(seq, seq % 2 ? 'x' : '\b');
  b.progress(1, 'a');
  await b.waitFor('race:update', (u) => u.players.some((p) => p.id === b.playerId && p.correctChars === 1));
  await sleep(60);
  assert.equal(a.pending('game:error').length, 0);
});

/* ---------- Simultaneous finish ---------- */

test('two finishes sent back to back get unique places 1 and 2', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.racing();
  a.progress(1, FIXED_PASSAGE);
  b.progress(1, FIXED_PASSAGE);
  const f1 = await a.waitFor('player:finish');
  const f2 = await a.waitFor('player:finish');
  assert.deepEqual([f1.payload.place, f2.payload.place], [1, 2]);
  assert.notEqual(f1.payload.id, f2.payload.id);
  const end = await a.waitFor('race:end');
  assert.deepEqual(end.payload.results.map((r) => r.place), [1, 2]);
  assert.deepEqual(end.payload.results.map((r) => r.id), [f1.payload.id, f2.payload.id]);
  assert.ok(end.payload.results.every((r) => r.status === 'finished'));
});

/* ---------- Server robustness ---------- */

/** A memory store whose getRoom throws while `failing` is true. */
function createFlakyStore() {
  const inner = createMemoryRoomStore();
  const store = {
    failing: false,
    getRoom(id) {
      if (store.failing) throw new Error('test: store unavailable');
      return inner.getRoom(id);
    },
    saveRoom: (room) => inner.saveRoom(room),
    deleteRoom: (id) => inner.deleteRoom(id),
    clear: () => inner.clear(),
  };
  return store;
}

test('a handler error answers INTERNAL and the server keeps running', async (t) => {
  t.mock.method(console, 'error', () => {});
  const store = createFlakyStore();
  const ctx = await setup(t, { store });
  const a = await ctx.client();
  store.failing = true;
  const ack = await a.join();
  store.failing = false;
  assert.equal(ack.ok, false);
  assert.equal(ack.error.code, 'INTERNAL');
  assert.equal(console.error.mock.callCount() >= 1, true);
  // The server still serves: the same socket and a new one both join and race.
  assert.equal((await a.join()).ok, true);
  const b = await ctx.joined();
  await a.waitFor('race:start');
  await b.waitFor('race:start');
});

test('a handler error on an event without an ack emits game:error INTERNAL', async (t) => {
  t.mock.method(console, 'error', () => {});
  const store = createFlakyStore();
  const ctx = await setup(t, { store });
  const [a, b] = await ctx.racing();
  store.failing = true;
  a.progress(1, 'a');
  const error = await a.waitFor('game:error');
  store.failing = false;
  assert.equal(error.payload.code, 'INTERNAL');
  assert.equal(a.socket.connected, true);
  a.progress(2, 'a');
  const update = await b.waitFor('race:update');
  assert.equal(update.payload.players.find((p) => p.id === a.playerId).correctChars, 1);
});

test('closing the server mid-race disconnects every client', async (t) => {
  const ctx = await setup(t, { raceTimeLimitMs: 60000 });
  const [a, b] = await ctx.racing();
  await ctx.server.close();
  await Promise.all([a.disconnected, b.disconnected]);
});
