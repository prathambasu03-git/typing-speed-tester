'use strict';

/* Socket integration (M2): host succession by join order in every phase,
   and the rematch with whoever pressed "Race again" (players who did not
   sit out: inRace false, ready true, ignored by the race, safe from the old
   rematch timer). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, sleep, eventually, FIXED_PASSAGE } = require('./helpers');

const sleepUntil = (check) => eventually(check, 'condition', 2000);

/** Every client types the whole passage; resolves when all saw room:state finished. */
async function finishRace(clients) {
  for (const c of clients) c.progress(1, FIXED_PASSAGE);
  await Promise.all(clients.map((c) => c.waitFor('room:state', (s) => s.phase === 'finished')));
}

function byId(state) {
  return Object.fromEntries(state.players.map((p) => [p.id, p]));
}

/**
 * A, B, C race and finish; A and B press Race again; A starts. Resolves with
 * the clients and the countdown room:state as C saw it. C sits out.
 */
async function raceWithSitOut(ctx) {
  const [a, b, c] = await ctx.racing(3);
  await finishRace([a, b, c]);
  assert.equal((await a.rematch()).ok, true);
  assert.equal((await b.rematch()).ok, true);
  // Both rematch room:states must have reached C before the history is dropped.
  await sleepUntil(() => c.lastState().players.filter((p) => p.ready).length === 2);
  // Later waits must only see the second race, not the first one's events.
  for (const x of [a, b, c]) x.drain();
  await ctx.start(a);
  const countdown = await c.waitFor('room:state', (s) => s.phase === 'countdown');
  return { a, b, c, countdown: countdown.payload };
}

/* ---------- Succession by join order ---------- */

test('the host passes by join order, not slot: B leaves, D takes slot 2, A leaves, and C becomes host', async (t) => {
  const ctx = await setup(t);
  const [a, b, c] = await ctx.lobby(3);
  await b.close();
  await c.waitFor('room:state', (s) => s.players.length === 2);
  const d = await ctx.joined();
  assert.equal(d.joinAck.room.players.find((p) => p.id === d.playerId).slot, 2);
  await a.close();
  const state = await c.waitFor('room:state', (s) => !s.players.some((p) => p.id === a.playerId));
  assert.equal(state.payload.hostId, c.playerId);
  assert.equal((await d.start()).error.code, 'NOT_HOST');
  await ctx.start(c);
  await d.waitFor('race:start');
});

test('the host leaving the lobby passes the host to the next player, who can start once another joins', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.lobby(2);
  await a.close();
  const state = await b.waitFor('room:state', (s) => s.players.length === 1);
  assert.equal(state.payload.hostId, b.playerId);
  assert.ok(state.payload.expiresInMs > 0, 'the lobby timer keeps running');
  assert.equal((await b.start()).error.code, 'NOT_ENOUGH_PLAYERS');
  const c = await ctx.joined();
  assert.equal(c.joinAck.room.hostId, b.playerId);
  await ctx.start(b);
  await c.waitFor('race:start');
});

test('the host leaving mid-countdown with three racers keeps the countdown going under the next host', async (t) => {
  const ctx = await setup(t, { countdownMs: 300 });
  const [a, b, c] = await ctx.lobby(3);
  await ctx.start(a);
  await b.waitFor('race:countdown');
  await a.close();
  const state = await c.waitFor('room:state', (s) => s.players.length === 2);
  assert.equal(state.payload.phase, 'countdown');
  assert.equal(state.payload.hostId, b.playerId);
  await Promise.all([b.waitFor('race:start'), c.waitFor('race:start')]);
});

test('the host leaving mid-countdown with two racers returns the room to waiting under the other player', async (t) => {
  const ctx = await setup(t, { countdownMs: 300 });
  const [a, b] = await ctx.lobby(2);
  await ctx.start(a);
  await b.waitFor('race:countdown');
  await a.close();
  const state = await b.waitFor('room:state', (s) => s.players.length === 1);
  assert.equal(state.payload.phase, 'waiting');
  assert.equal(state.payload.hostId, b.playerId);
  assert.notEqual(state.payload.expiresInMs, null);
  assert.ok(state.payload.players.every((p) => p.inRace === false));
  await sleep(400);
  assert.equal(b.pending('race:start').length, 0);
});

test('the host leaving mid-race passes the host at once, and the new host starts the next race', async (t) => {
  const ctx = await setup(t);
  const [a, b, c] = await ctx.racing(3);
  await a.close();
  const state = await b.waitFor('room:state', (s) => s.phase === 'racing');
  assert.equal(state.payload.hostId, b.playerId);
  assert.equal(byId(state.payload)[a.playerId].connected, false);
  await finishRace([b, c]);
  assert.equal(b.lastState().hostId, b.playerId);
  await b.rematch();
  await c.rematch();
  await ctx.start(b);
  await c.waitFor('race:start');
});

test('the host leaving during results passes the host to the next player, who starts with the ready players', async (t) => {
  const ctx = await setup(t);
  const [a, b, c] = await ctx.racing(3);
  await finishRace([a, b, c]);
  await b.rematch();
  await c.rematch();
  await a.close();
  const state = await b.waitFor('room:state', (s) => s.players.length === 2);
  assert.equal(state.payload.hostId, b.playerId);
  await ctx.start(b);
  const countdown = await c.waitFor('room:state', (s) => s.phase === 'countdown');
  assert.deepEqual(
    countdown.payload.players.map((p) => [p.id, p.inRace]),
    [
      [b.playerId, true],
      [c.playerId, true],
    ]
  );
});

test('a new host on results who has not pressed Race again can still start with one ready player', async (t) => {
  const ctx = await setup(t);
  const [a, b, c] = await ctx.racing(3);
  await finishRace([a, b, c]);
  await c.rematch();
  await a.close();
  const state = await b.waitFor('room:state', (s) => s.players.length === 2);
  assert.equal(state.payload.phase, 'finished');
  assert.equal(state.payload.hostId, b.playerId);
  await ctx.start(b);
  const countdown = await c.waitFor('room:state', (s) => s.phase === 'countdown');
  assert.ok(countdown.payload.players.every((p) => p.inRace === true));
});

test('the rematch timeout removing the host passes the host and the room returns to waiting', async (t) => {
  const ctx = await setup(t, { rematchTimeoutMs: 200 });
  const [a, b] = await ctx.racing(2);
  await finishRace([a, b]);
  await b.rematch();
  await a.waitFor('game:error', (e) => e.code === 'IDLE_TIMEOUT', 1500);
  await a.disconnected;
  const state = await b.waitFor('room:state', (s) => s.phase === 'waiting', 1500);
  assert.equal(state.payload.hostId, b.playerId);
  assert.deepEqual(state.payload.players.map((p) => p.id), [b.playerId]);
});

/* ---------- Rematch and the host start ---------- */

test('when everyone presses Race again the room returns to waiting and nothing starts until the host does', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.racing(2);
  await finishRace([a, b]);
  await a.rematch();
  await b.rematch();
  const waiting = await b.waitFor('room:state', (s) => s.phase === 'waiting');
  assert.ok(waiting.payload.players.every((p) => p.ready && !p.inRace && !p.finished));
  await sleep(150);
  assert.equal(b.pending('race:countdown').length, 0);
  await ctx.start(a);
  await b.waitFor('race:countdown');
});

test('a host start with two of three ready seats those two and sits the third out as ready', async (t) => {
  const ctx = await setup(t);
  const { a, b, c, countdown } = await raceWithSitOut(ctx);
  const players = byId(countdown);
  assert.equal(players[a.playerId].inRace, true);
  assert.equal(players[b.playerId].inRace, true);
  assert.equal(players[c.playerId].inRace, false);
  assert.equal(players[c.playerId].ready, true);
  assert.equal(players[c.playerId].finished, false, 'a sat-out player does not show the old finish');
  // C still receives the race events (its client ignores them).
  await c.waitFor('race:countdown');
  await c.waitFor('race:start');
});

test('a sitting-out player has no effect on the race and never appears in updates or results', async (t) => {
  const ctx = await setup(t);
  const { a, b, c } = await raceWithSitOut(ctx);
  await Promise.all([a.waitFor('race:start'), b.waitFor('race:start'), c.waitFor('race:start')]);
  c.progress(1, FIXED_PASSAGE);
  a.progress(1, 'a');
  const update = await b.waitFor('race:update', (u) => u.players.some((p) => p.id === a.playerId && p.correctChars === 1));
  assert.deepEqual(update.payload.players.map((p) => p.id).sort(), [a.playerId, b.playerId].sort());
  a.progress(2, 'b cd');
  b.progress(1, FIXED_PASSAGE);
  const end = await c.waitFor('race:end');
  assert.deepEqual(end.payload.results.map((r) => r.id).sort(), [a.playerId, b.playerId].sort());
  const secondCountdown = c.events.filter((e) => e.name === 'race:countdown').pop().index;
  const finishes = c.events.filter((e) => e.name === 'player:finish' && e.index > secondCountdown);
  assert.equal(finishes.length, 2);
  assert.ok(finishes.every((f) => f.payload.id !== c.playerId), 'C never finishes');
  const bSecondCountdown = b.events.filter((e) => e.name === 'race:countdown').pop().index;
  for (const u of b.events.filter((e) => e.name === 'race:update' && e.index > bSecondCountdown)) {
    assert.ok(!u.payload.players.some((p) => p.id === c.playerId));
  }
});

test('the race ends when every racer finished even though a sitting-out player is connected', async (t) => {
  const ctx = await setup(t);
  const { a, b, c } = await raceWithSitOut(ctx);
  await Promise.all([a.waitFor('race:start'), b.waitFor('race:start')]);
  a.progress(1, FIXED_PASSAGE);
  b.progress(1, FIXED_PASSAGE);
  const end = await c.waitFor('race:end');
  assert.equal(end.payload.reason, 'all_finished');
  const state = await c.waitFor('room:state', (s) => s.phase === 'finished');
  const players = byId(state.payload);
  assert.equal(players[a.playerId].ready, false);
  assert.equal(players[b.playerId].ready, false);
  assert.equal(players[c.playerId].ready, true, 'the sat-out player stays ready');
  assert.equal(players[c.playerId].inRace, false);
});

test('a sitting-out player is not removed by the old rematch timer', async (t) => {
  const rematchTimeoutMs = 250;
  const ctx = await setup(t, { rematchTimeoutMs, raceTimeLimitMs: 3000 });
  const [a, b, c] = await ctx.racing(3);
  await finishRace([a, b, c]);
  const endedAt = performance.now();
  await a.rematch();
  await b.rematch();
  await ctx.start(a);
  await c.waitFor('race:start');
  // Well past the first race's rematch deadline, during the new race.
  await sleep(Math.max(0, endedAt + rematchTimeoutMs + 200 - performance.now()));
  assert.equal(c.socket.connected, true);
  assert.equal(c.events.filter((e) => e.name === 'game:error').length, 0);
  // After the new race only its racers face the new timer; C stays.
  a.progress(1, FIXED_PASSAGE);
  b.progress(1, FIXED_PASSAGE);
  await c.waitFor('race:end');
  await a.waitFor('game:error', (e) => e.code === 'IDLE_TIMEOUT', 1500);
  await b.waitFor('game:error', (e) => e.code === 'IDLE_TIMEOUT', 1500);
  const state = await c.waitFor('room:state', (s) => s.phase === 'waiting' && s.players.length === 1, 1500);
  assert.equal(state.payload.hostId, c.playerId);
  assert.equal(c.events.filter((e) => e.name === 'game:error').length, 0);
});

test('a player who sat out races in the next race', async (t) => {
  const ctx = await setup(t);
  const { a, b, c } = await raceWithSitOut(ctx);
  await Promise.all([a.waitFor('race:start'), b.waitFor('race:start')]);
  await finishRace([a, b]);
  await a.rematch();
  await b.rematch();
  const waiting = await c.waitFor('room:state', (s) => s.phase === 'waiting');
  assert.equal(waiting.payload.players.length, 3);
  // C ignored race 2's events; drop them so it waits for race 3's start.
  for (const x of [a, b, c]) x.drain();
  await ctx.start(a);
  const countdown = await c.waitFor('room:state', (s) => s.phase === 'countdown');
  assert.ok(countdown.payload.players.every((p) => p.inRace === true));
  await c.waitFor('race:start');
  c.progress(1, FIXED_PASSAGE);
  const finish = await a.waitFor('player:finish', (f) => f.id === c.playerId);
  assert.equal(finish.payload.place, 1);
});

test('only the host ready: PLAYERS_NOT_READY, then the idle players time out and the host alone gets NOT_ENOUGH_PLAYERS', async (t) => {
  const ctx = await setup(t, { rematchTimeoutMs: 250 });
  const [a, b, c] = await ctx.racing(3);
  await finishRace([a, b, c]);
  await a.rematch();
  assert.equal((await a.start()).error.code, 'PLAYERS_NOT_READY');
  await b.waitFor('game:error', (e) => e.code === 'IDLE_TIMEOUT', 1500);
  await c.waitFor('game:error', (e) => e.code === 'IDLE_TIMEOUT', 1500);
  const state = await a.waitFor('room:state', (s) => s.phase === 'waiting' && s.players.length === 1, 1500);
  assert.equal(state.payload.hostId, a.playerId);
  assert.equal((await a.start()).error.code, 'NOT_ENOUGH_PLAYERS');
});

test("the host's start counts as the host's own Race again", async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.racing(2);
  await finishRace([a, b]);
  await b.rematch();
  assert.equal(b.lastState().phase, 'finished');
  assert.deepEqual(await a.start(), { ok: true });
  const countdown = await b.waitFor('room:state', (s) => s.phase === 'countdown');
  assert.ok(countdown.payload.players.every((p) => p.inRace === true));
});

test('a non-host start after the race gets NOT_HOST even when everyone is ready', async (t) => {
  const ctx = await setup(t);
  const [a, b, c] = await ctx.racing(3);
  await finishRace([a, b, c]);
  await b.rematch();
  await c.rematch();
  assert.equal((await b.start()).error.code, 'NOT_HOST');
});

test('a player joining while the others are on results races with the host and the player still on results sits out', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.racing(2);
  await finishRace([a, b]);
  const d = await ctx.joined();
  assert.equal(d.joinAck.room.phase, 'finished');
  const self = d.joinAck.room.players.find((p) => p.id === d.playerId);
  assert.equal(self.ready, true);
  assert.equal(self.inRace, false);
  await a.rematch();
  await ctx.start(a);
  const countdown = byId((await d.waitFor('room:state', (s) => s.phase === 'countdown')).payload);
  assert.equal(countdown[a.playerId].inRace, true);
  assert.equal(countdown[d.playerId].inRace, true);
  assert.equal(countdown[b.playerId].inRace, false);
  assert.equal(countdown[b.playerId].ready, true);
});

test('a Race again sent after the host started without that player gets NOT_FINISHED', async (t) => {
  const ctx = await setup(t, { countdownMs: 300 });
  const { c } = await raceWithSitOut(ctx);
  assert.equal((await c.rematch()).error.code, 'NOT_FINISHED');
  assert.equal(c.socket.connected, true);
});

/* ---------- Leaving while players sit out ---------- */

test('every racer leaving mid-race with a sat-out player connected returns the room to waiting with no race:end', async (t) => {
  const ctx = await setup(t);
  const { a, b, c } = await raceWithSitOut(ctx);
  await c.waitFor('race:start');
  await a.close();
  await b.close();
  const state = await c.waitFor('room:state', (s) => s.phase === 'waiting');
  assert.equal(state.payload.hostId, c.playerId);
  assert.notEqual(state.payload.expiresInMs, null);
  assert.deepEqual(state.payload.players.map((p) => [p.id, p.inRace, p.ready]), [[c.playerId, false, true]]);
  await sleep(100);
  assert.equal(c.events.filter((e) => e.name === 'race:end').length, 1, 'only the first race ended');
});

test('a sitting-out player leaving mid-race is removed and the race ends normally without them', async (t) => {
  const ctx = await setup(t);
  const { a, b, c } = await raceWithSitOut(ctx);
  await Promise.all([a.waitFor('race:start'), b.waitFor('race:start')]);
  await c.close();
  const state = await a.waitFor('room:state', (s) => s.players.length === 2);
  assert.equal(state.payload.phase, 'racing');
  a.progress(1, FIXED_PASSAGE);
  b.progress(1, FIXED_PASSAGE);
  const end = await a.waitFor('race:end');
  assert.deepEqual(end.payload.results.map((r) => r.id).sort(), [a.playerId, b.playerId].sort());
});

test('a sitting-out player leaving during the countdown never cancels it', async (t) => {
  const ctx = await setup(t, { countdownMs: 300 });
  const { a, b, c } = await raceWithSitOut(ctx);
  await c.close();
  const state = await a.waitFor('room:state', (s) => s.players.length === 2);
  assert.equal(state.payload.phase, 'countdown');
  await Promise.all([a.waitFor('race:start'), b.waitFor('race:start')]);
});

test('a racer leaving the countdown cancels it when one racer is left, even with a sat-out player present', async (t) => {
  const ctx = await setup(t, { countdownMs: 300 });
  const { a, b, c } = await raceWithSitOut(ctx);
  await b.close();
  const state = await a.waitFor('room:state', (s) => s.players.length === 2);
  assert.equal(state.payload.phase, 'waiting');
  assert.deepEqual(state.payload.players.map((p) => p.id), [a.playerId, c.playerId]);
  assert.ok(state.payload.players.every((p) => !p.inRace && p.ready));
  await sleep(400);
  assert.equal(c.pending('race:start').length, 0);
});
