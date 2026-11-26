'use strict';

/* Socket integration (M2): creating a room, joining by code, the host's
   room:start, the four-seat limit, the lobby timer with room:extend and
   ROOM_EXPIRED, room isolation and snapshot privacy. Error orders follow
   docs/PROTOCOL.md section 4. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, sleep, eventually, FIXED_PASSAGE, UNUSED_CODE } = require('./helpers');
const { createMemoryRoomStore } = require('../src/roomStore');
const { isValidRoomCode } = require('../src/roomCode');

/**
 * Emits with a raw ack callback and records how many events the client had
 * received when the ack arrived, so tests can check "ack, then room:state".
 */
function emitWithIndex(client, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), 2000);
    client.socket.emit(event, payload, (ack) => {
      clearTimeout(timer);
      resolve({ ack, index: client.events.length });
    });
  });
}

/** Every client types the whole passage; resolves when all saw room:state finished. */
async function finishRace(clients) {
  for (const c of clients) c.progress(1, FIXED_PASSAGE);
  await Promise.all(clients.map((c) => c.waitFor('room:state', (s) => s.phase === 'finished')));
}

/* ---------- Create ---------- */

test('room:create answers ok with a valid code, the creator as host, phase waiting and lobby time left', async (t) => {
  const ctx = await setup(t);
  const a = await ctx.client();
  const { ack, index } = await emitWithIndex(a, 'room:create', {});
  assert.equal(ack.ok, true);
  assert.ok(isValidRoomCode(ack.room.code), ack.room.code);
  assert.equal(ack.room.hostId, ack.playerId);
  assert.equal(ack.room.phase, 'waiting');
  assert.equal(ack.room.maxPlayers, 4);
  assert.equal(ack.room.minPlayers, 2);
  assert.ok(ack.room.expiresInMs > 0 && ack.room.expiresInMs <= 2000, `expiresInMs ${ack.room.expiresInMs}`);
  assert.deepEqual(ack.room.players, [
    { id: ack.playerId, slot: 1, connected: true, ready: true, inRace: false, finished: false },
  ]);
  assert.equal(index, 0, 'the ack comes before any room:state');

  const state = await a.waitFor('room:state');
  assert.equal(state.payload.code, ack.room.code);
  assert.equal(state.payload.hostId, ack.playerId);
  await sleep(80);
  assert.deepEqual(a.events.map((e) => e.name), ['room:state'], 'exactly one room:state');
});

test('two creates from two sockets get two different rooms', async (t) => {
  const ctx = await setup(t);
  const a = await ctx.created();
  const b = await ctx.created();
  assert.notEqual(a.code, b.code);
  assert.equal(b.joinAck.room.players.length, 1);
  assert.equal(b.joinAck.room.hostId, b.playerId);
});

test('room:create with a bad payload gets BAD_PAYLOAD and the socket is kicked', async (t) => {
  const ctx = await setup(t);
  for (const payload of [null, 'x', 1, []]) {
    const c = await ctx.client();
    const ack = await c.emitAck('room:create', payload);
    assert.equal(ack.error.code, 'BAD_PAYLOAD', JSON.stringify(payload));
    assert.equal(await c.disconnected, 'io server disconnect');
  }
});

test('a socket already in a room gets ALREADY_JOINED for a second create and keeps its room', async (t) => {
  const ctx = await setup(t);
  const a = await ctx.created();
  const ack = await a.create();
  assert.equal(ack.ok, false);
  assert.equal(ack.error.code, 'ALREADY_JOINED');
  await sleep(50);
  assert.equal(a.socket.connected, true);
  const b = await ctx.joined();
  assert.deepEqual(b.joinAck.room.players.map((p) => p.id), [a.playerId, b.playerId]);
});

test('a socket already in a room gets ALREADY_JOINED for a join to another room and stays', async (t) => {
  const ctx = await setup(t);
  const other = await ctx.created();
  const a = await ctx.created();
  const ack = await a.join(other.code);
  assert.equal(ack.error.code, 'ALREADY_JOINED');
  await sleep(50);
  assert.equal(a.socket.connected, true);
  const c = await ctx.joinedTo(a.code);
  assert.equal(c.joinAck.room.players.length, 2);
});

test('a socket in a room that sends a bad create payload gets BAD_PAYLOAD and is not kicked', async (t) => {
  const ctx = await setup(t);
  const a = await ctx.created();
  assert.equal((await a.emitAck('room:create', null)).error.code, 'BAD_PAYLOAD');
  assert.equal((await a.emitAck('room:join', { code: 5 })).error.code, 'BAD_PAYLOAD');
  await sleep(50);
  assert.equal(a.socket.connected, true);
});

/* ---------- Join ---------- */

test('a second player joins by code and both get room:state with two players, the creator as host', async (t) => {
  const ctx = await setup(t);
  const a = await ctx.created();
  const b = await ctx.client();
  const { ack, index } = await emitWithIndex(b, 'room:join', { code: a.code });
  assert.equal(ack.ok, true);
  assert.equal(ack.room.code, a.code);
  assert.equal(ack.room.hostId, a.playerId);
  assert.equal(index, 0, 'the ack comes before room:state');
  assert.deepEqual(ack.room.players.map((p) => [p.slot, p.ready, p.inRace]), [
    [1, true, false],
    [2, true, false],
  ]);
  for (const c of [a, b]) {
    const state = await c.waitFor('room:state', (s) => s.players.length === 2);
    assert.equal(state.payload.hostId, a.playerId);
  }
});

test('two players in a room do not start a race by themselves', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.lobby(2);
  await sleep(200);
  for (const c of [a, b]) {
    assert.equal(c.pending('race:countdown').length, 0);
    assert.equal(c.lastState().phase, 'waiting');
  }
});

test('a code that no room has gets ROOM_NOT_FOUND and the socket is kicked', async (t) => {
  const ctx = await setup(t);
  const c = await ctx.client();
  const ack = await c.join('AAAAAA');
  assert.equal(ack.error.code, 'ROOM_NOT_FOUND');
  assert.equal(await c.disconnected, 'io server disconnect');
});

test('a lowercase code gets BAD_CODE even when the uppercase room exists', async (t) => {
  const ctx = await setup(t, { randomInt: () => 0 });
  await ctx.created();
  assert.equal(ctx.code, 'AAAAAA');
  const c = await ctx.client();
  const ack = await c.join('aaaaaa');
  assert.equal(ack.error.code, 'BAD_CODE');
  assert.equal(await c.disconnected, 'io server disconnect');
});

test('codes with forbidden characters, spaces, hyphens or the wrong length get BAD_CODE', async (t) => {
  const ctx = await setup(t);
  for (const code of ['K7QM0X', 'K7QMOX', 'K7Q-M2', ' K7QM2X', 'K7QM2', 'K7QM2XX', 'K7QM2X'.repeat(2)]) {
    const c = await ctx.client();
    assert.equal((await c.join(code)).error.code, 'BAD_CODE', code);
    await c.disconnected;
  }
});

test('a join payload with a non-string or too long code gets BAD_PAYLOAD and the socket is kicked', async (t) => {
  const ctx = await setup(t);
  for (const payload of [{ code: 5 }, {}, { code: '' }, { code: 'A'.repeat(17) }, { code: null }]) {
    const c = await ctx.client();
    assert.equal((await c.emitAck('room:join', payload)).error.code, 'BAD_PAYLOAD', JSON.stringify(payload));
    assert.equal(await c.disconnected, 'io server disconnect');
  }
});

test('four players fit, a fifth gets ROOM_FULL and is kicked, and the race of four ends with places 1 to 4', async (t) => {
  const ctx = await setup(t);
  const players = await ctx.lobby(4);
  assert.deepEqual(players[3].joinAck.room.players.map((p) => p.slot), [1, 2, 3, 4]);
  const fifth = await ctx.client();
  const ack = await fifth.join(ctx.code);
  assert.equal(ack.error.code, 'ROOM_FULL');
  assert.equal(await fifth.disconnected, 'io server disconnect');

  await ctx.start();
  await Promise.all(players.map((c) => c.waitFor('race:start')));
  for (const c of players) {
    c.progress(1, FIXED_PASSAGE);
    await players[0].waitFor('player:finish', (f) => f.id === c.playerId);
  }
  const end = await players[0].waitFor('race:end');
  assert.deepEqual(
    end.payload.results.map((r) => [r.id, r.place, r.status]),
    players.map((c, i) => [c.playerId, i + 1, 'finished'])
  );
});

test('a fifth player joining while four are racing gets ROOM_FULL, not RACE_IN_PROGRESS', async (t) => {
  const ctx = await setup(t);
  await ctx.racing(4);
  const fifth = await ctx.client();
  assert.equal((await fifth.join(ctx.code)).error.code, 'ROOM_FULL');
  assert.equal(await fifth.disconnected, 'io server disconnect');
});

test('a fifth player joining during the countdown of four gets ROOM_FULL', async (t) => {
  const ctx = await setup(t, { countdownMs: 500 });
  await ctx.lobby(4);
  await ctx.start();
  const fifth = await ctx.client();
  assert.equal((await fifth.join(ctx.code)).error.code, 'ROOM_FULL');
});

test('joining a room that is counting down with a free seat gets RACE_IN_PROGRESS and the socket is kicked', async (t) => {
  const ctx = await setup(t, { countdownMs: 500 });
  await ctx.lobby(2);
  await ctx.start();
  const c = await ctx.client();
  assert.equal((await c.join(ctx.code)).error.code, 'RACE_IN_PROGRESS');
  assert.equal(await c.disconnected, 'io server disconnect');
});

test('joining a room that is racing with a free seat gets RACE_IN_PROGRESS and the socket is kicked', async (t) => {
  const ctx = await setup(t);
  await ctx.racing(2);
  const c = await ctx.client();
  assert.equal((await c.join(ctx.code)).error.code, 'RACE_IN_PROGRESS');
  assert.equal(await c.disconnected, 'io server disconnect');
});

test('a player who leaves can join again as a new player with a new id', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.lobby(2);
  await b.close();
  await a.waitFor('room:state', (s) => s.players.length === 1);
  const again = await ctx.joined();
  assert.notEqual(again.playerId, b.playerId);
  assert.equal(again.joinAck.room.players.find((p) => p.id === again.playerId).slot, 2);
});

/* ---------- Start ---------- */

test('a non-host room:start gets NOT_HOST and nothing starts', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.lobby(2);
  const ack = await b.start();
  assert.equal(ack.ok, false);
  assert.equal(ack.error.code, 'NOT_HOST');
  await sleep(100);
  assert.equal(a.pending('race:countdown').length, 0);
  assert.equal(b.socket.connected, true);
});

test('the host start answers ok, then room:state countdown with both racing, then race:countdown and race:start', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.lobby(2);
  a.drain();
  b.drain();
  const before = a.events.length;
  const { ack, index } = await emitWithIndex(a, 'room:start', {});
  assert.deepEqual(ack, { ok: true });
  assert.equal(index, before, 'the ack comes before room:state');
  for (const c of [a, b]) {
    const state = await c.waitFor('room:state');
    assert.equal(state.payload.phase, 'countdown');
    assert.equal(state.payload.expiresInMs, null);
    assert.ok(state.payload.players.every((p) => p.inRace === true && p.ready === true));
    const countdown = await c.waitFor('race:countdown');
    assert.equal(countdown.index, state.index + 1);
    await c.waitFor('race:start');
  }
});

test('a second room:start during the countdown gets RACE_IN_PROGRESS', async (t) => {
  const ctx = await setup(t, { countdownMs: 300 });
  const [a] = await ctx.lobby(2);
  await ctx.start();
  assert.equal((await a.start()).error.code, 'RACE_IN_PROGRESS');
});

test('room:start during the race gets RACE_IN_PROGRESS from the host and NOT_HOST from others', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.racing(2);
  assert.equal((await a.start()).error.code, 'RACE_IN_PROGRESS');
  assert.equal((await b.start()).error.code, 'NOT_HOST');
});

test('the host alone gets NOT_ENOUGH_PLAYERS', async (t) => {
  const ctx = await setup(t);
  const a = await ctx.created();
  assert.equal((await a.start()).error.code, 'NOT_ENOUGH_PLAYERS');
  assert.equal(a.socket.connected, true);
});

test('room:start before entering a room gets NOT_IN_ROOM and the socket stays', async (t) => {
  const ctx = await setup(t);
  const c = await ctx.client();
  assert.equal((await c.start()).error.code, 'NOT_IN_ROOM');
  await sleep(50);
  assert.equal(c.socket.connected, true);
});

test('room:start with a bad payload gets BAD_PAYLOAD before NOT_IN_ROOM', async (t) => {
  const ctx = await setup(t);
  const c = await ctx.client();
  for (const payload of [null, 'x', 1, []]) {
    assert.equal((await c.emitAck('room:start', payload)).error.code, 'BAD_PAYLOAD', JSON.stringify(payload));
  }
  assert.equal(c.socket.connected, true);
});

test('room:start without an ack gets game:error BAD_PAYLOAD and starts nothing', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.lobby(2);
  a.socket.emit('room:start', {});
  assert.equal((await a.waitFor('game:error')).payload.code, 'BAD_PAYLOAD');
  await sleep(80);
  assert.equal(b.pending('race:countdown').length, 0);
});

test('a host start with three players seats all three', async (t) => {
  const ctx = await setup(t);
  const players = await ctx.lobby(3);
  await ctx.start();
  const state = await players[2].waitFor('room:state', (s) => s.phase === 'countdown');
  assert.deepEqual(
    state.payload.players.map((p) => [p.id, p.inRace]),
    players.map((c) => [c.playerId, true])
  );
});

/* ---------- Lobby timer ---------- */

test('a lobby with no start expires: every player gets ROOM_EXPIRED, is disconnected, and the code is gone', async (t) => {
  const store = createMemoryRoomStore();
  const ctx = await setup(t, { store, lobbyTimeoutMs: 200 });
  const [a, b] = await ctx.lobby(2);
  await a.waitFor('room:state', (s) => s.players.length === 2);
  a.drain();
  b.drain();
  for (const c of [a, b]) {
    const error = await c.waitFor('game:error', (e) => e.code === 'ROOM_EXPIRED', 1500);
    assert.equal(typeof error.payload.message, 'string');
    assert.equal(await c.disconnected, 'io server disconnect');
  }
  // The expiry is silent: no "player left" or new-host room:state while the room closes.
  for (const c of [a, b]) assert.deepEqual(c.events.filter((e) => e.name !== 'game:error' && e.taken === false).map((e) => e.name), []);
  assert.equal(a.events.filter((e) => e.name === 'room:state' && e.taken === false).length, 0);
  await eventually(() => store.size() === 0, 'room deleted');
  const late = await ctx.client();
  assert.equal((await late.join(ctx.code)).error.code, 'ROOM_NOT_FOUND');
});

test('ROOM_EXPIRED arrives before the disconnect', async (t) => {
  const ctx = await setup(t, { lobbyTimeoutMs: 150 });
  const a = await ctx.created();
  const gone = new Promise((resolve) => a.socket.once('disconnect', () => resolve(a.events.length)));
  const countAtDisconnect = await gone;
  const names = a.events.slice(0, countAtDisconnect).map((e) => e.name);
  assert.deepEqual(names, ['room:state', 'game:error']);
  assert.equal(a.events[1].payload.code, 'ROOM_EXPIRED');
});

test('room:extend restarts the lobby timer, answers with fresh time and sends room:state to everyone', async (t) => {
  const lobbyTimeoutMs = 400;
  const ctx = await setup(t, { lobbyTimeoutMs });
  const [a, b] = await ctx.lobby(2);
  const joinedAt = performance.now();
  await sleep(200);
  b.drain();
  const ack = await b.extend();
  assert.equal(ack.ok, true);
  assert.equal(ack.room.phase, 'waiting');
  assert.ok(ack.room.expiresInMs > lobbyTimeoutMs - 50 && ack.room.expiresInMs <= lobbyTimeoutMs, `expiresInMs ${ack.room.expiresInMs}`);
  for (const c of [a, b]) {
    const state = await c.waitFor('room:state', (s) => s.expiresInMs > lobbyTimeoutMs - 50);
    assert.equal(state.payload.phase, 'waiting');
  }
  // The original deadline passes without an expiry.
  await sleep(Math.max(0, joinedAt + lobbyTimeoutMs + 80 - performance.now()));
  assert.equal(a.pending('game:error').length, 0);
  assert.equal(a.socket.connected, true);
  // The extended deadline expires the room.
  await a.waitFor('game:error', (e) => e.code === 'ROOM_EXPIRED', 1500);
});

test('a join restarts the lobby timer', async (t) => {
  const lobbyTimeoutMs = 400;
  const ctx = await setup(t, { lobbyTimeoutMs });
  const a = await ctx.created();
  const createdAt = performance.now();
  await sleep(200);
  const b = await ctx.joined();
  assert.ok(b.joinAck.room.expiresInMs > lobbyTimeoutMs - 50, `expiresInMs ${b.joinAck.room.expiresInMs}`);
  await sleep(Math.max(0, createdAt + lobbyTimeoutMs + 80 - performance.now()));
  assert.equal(a.pending('game:error').length, 0);
  await a.waitFor('game:error', (e) => e.code === 'ROOM_EXPIRED', 1500);
});

test('the lobby timer is cleared when the race starts', async (t) => {
  const ctx = await setup(t, { lobbyTimeoutMs: 150, raceTimeLimitMs: 2000 });
  const [a, b] = await ctx.racing(2);
  await sleep(350);
  for (const c of [a, b]) {
    assert.equal(c.pending('game:error').length, 0);
    assert.equal(c.socket.connected, true);
  }
});

test('the lobby timer starts again when the room returns to waiting after a race', async (t) => {
  const ctx = await setup(t, { lobbyTimeoutMs: 300 });
  const [a, b] = await ctx.racing(2);
  await finishRace([a, b]);
  assert.equal(a.lastState().expiresInMs, null, 'no lobby time while finished');
  await a.rematch();
  await b.rematch();
  const waiting = await a.waitFor('room:state', (s) => s.phase === 'waiting');
  assert.ok(waiting.payload.expiresInMs > 200, `expiresInMs ${waiting.payload.expiresInMs}`);
  await a.waitFor('game:error', (e) => e.code === 'ROOM_EXPIRED', 1500);
});

test('a join to a finished room shows no lobby time', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.racing(2);
  await finishRace([a, b]);
  const c = await ctx.joined();
  assert.equal(c.joinAck.room.phase, 'finished');
  assert.equal(c.joinAck.room.expiresInMs, null);
  const self = c.joinAck.room.players.find((p) => p.id === c.playerId);
  assert.equal(self.ready, true);
  assert.equal(self.inRace, false);
});

test('room:extend outside waiting gets NOT_WAITING in countdown, racing and finished', async (t) => {
  const ctx = await setup(t, { countdownMs: 200 });
  const [a, b] = await ctx.lobby(2);
  await ctx.start();
  assert.equal((await b.extend()).error.code, 'NOT_WAITING');
  await a.waitFor('race:start');
  assert.equal((await a.extend()).error.code, 'NOT_WAITING');
  await finishRace([a, b]);
  assert.equal((await b.extend()).error.code, 'NOT_WAITING');
  assert.equal(b.socket.connected, true);
});

test('room:extend before entering a room gets NOT_IN_ROOM and a bad payload gets BAD_PAYLOAD', async (t) => {
  const ctx = await setup(t);
  const c = await ctx.client();
  assert.equal((await c.emitAck('room:extend', null)).error.code, 'BAD_PAYLOAD');
  assert.equal((await c.extend()).error.code, 'NOT_IN_ROOM');
  assert.equal(c.socket.connected, true);
});

test('room:extend without an ack gets game:error BAD_PAYLOAD', async (t) => {
  const ctx = await setup(t);
  const a = await ctx.created();
  a.socket.emit('room:extend', {});
  assert.equal((await a.waitFor('game:error')).payload.code, 'BAD_PAYLOAD');
});

/* ---------- Isolation, privacy and cleanup ---------- */

test('two rooms are isolated: a start and progress in one never reach the other', async (t) => {
  const ctx = await setup(t);
  const a = await ctx.created();
  const b = await ctx.joinedTo(a.code);
  const c = await ctx.created();
  const d = await ctx.joinedTo(c.code);
  await eventually(() => [c, d].every((x) => x.lastState() && x.lastState().players.length === 2), 'room 2 settled');
  c.drain();
  d.drain();
  await ctx.start(a);
  await Promise.all([a.waitFor('race:start'), b.waitFor('race:start')]);
  a.progress(1, FIXED_PASSAGE);
  b.progress(1, FIXED_PASSAGE);
  await b.waitFor('race:end');
  await sleep(80);
  assert.deepEqual(c.events.filter((e) => !e.taken).map((e) => e.name), []);
  assert.deepEqual(d.events.filter((e) => !e.taken).map((e) => e.name), []);
  // Room 2 still works on its own.
  await ctx.start(c);
  await d.waitFor('race:start');
  await sleep(50);
  assert.equal(a.events.filter((e) => e.name === 'race:countdown').length, 1, 'room 1 saw only its own countdown');
});

test('no snapshot or ack ever contains a socket id, joinSeq or other server-only field', async (t) => {
  const ctx = await setup(t);
  const [a, b, c] = await ctx.racing(3);
  await finishRace([a, b, c]);
  await a.rematch();
  await b.rematch();
  await ctx.start(a);
  await c.waitFor('race:start');
  const ids = [a, b, c].map((x) => x.socket.id);
  const texts = [a, b, c].flatMap((x) => [JSON.stringify(x.joinAck), ...x.events.map((e) => JSON.stringify(e.payload))]);
  for (const text of texts) {
    for (const id of ids) assert.ok(!text.includes(id), 'socket id leaked');
    for (const field of ['joinSeq', 'socketId', 'lobbyDeadline', 'nextJoinSeq', '"ip"']) {
      assert.ok(!text.includes(field), `${field} leaked`);
    }
  }
  const states = [a, b, c].flatMap((x) => x.events.filter((e) => e.name === 'room:state'));
  assert.ok(states.length > 0);
  for (const s of states) {
    assert.deepEqual(Object.keys(s.payload).sort(), ['code', 'expiresInMs', 'hostId', 'maxPlayers', 'minPlayers', 'phase', 'players']);
    for (const p of s.payload.players) {
      assert.deepEqual(Object.keys(p).sort(), ['connected', 'finished', 'id', 'inRace', 'ready', 'slot']);
    }
  }
});

test('every waiting snapshot has inRace false for all players and a hostId among the players', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.racing(2);
  await finishRace([a, b]);
  await a.rematch();
  await b.rematch();
  await a.waitFor('room:state', (s) => s.phase === 'waiting');
  for (const s of a.events.filter((e) => e.name === 'room:state').map((e) => e.payload)) {
    assert.ok(s.players.some((p) => p.id === s.hostId), 'hostId is a player');
    if (s.phase === 'waiting') assert.ok(s.players.every((p) => p.inRace === false));
    else assert.equal(s.expiresInMs, null);
  }
});

test('the room is deleted once its last player leaves', async (t) => {
  const store = createMemoryRoomStore();
  const ctx = await setup(t, { store });
  const [a, b] = await ctx.lobby(2);
  assert.equal(store.size(), 1);
  await a.close();
  await b.waitFor('room:state', (s) => s.players.length === 1);
  assert.equal(store.size(), 1);
  await b.close();
  await eventually(() => store.size() === 0, 'room deleted');
  const late = await ctx.client();
  assert.equal((await late.join(ctx.code)).error.code, 'ROOM_NOT_FOUND');
});

test('an unused but valid code is not found', async (t) => {
  const ctx = await setup(t, { randomInt: () => 0 });
  await ctx.created();
  const c = await ctx.client();
  assert.equal((await c.join(UNUSED_CODE)).error.code, 'ROOM_NOT_FOUND');
});
