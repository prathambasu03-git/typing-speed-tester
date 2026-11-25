'use strict';

/* Socket integration: the full two-client race, the countdown before every
   race (first race and rematch), the time limit and the rematch paths. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, sleep, FIXED_PASSAGE } = require('./helpers');
const { COUNTDOWN_MS, RACE_TIME_LIMIT_MS } = require('../src/constants');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Allowed gap between the server firing its timer and the client seeing the
// event, since both events cross the same local socket.
const TIMING_SLACK_MS = 20;

/** Names of the lifecycle events a client saw, with the phase for room:state. */
function lifecycle(client) {
  return client.events
    .filter((e) => e.name !== 'race:update')
    .map((e) => (e.name === 'room:state' ? `room:state:${e.payload.phase}` : e.name));
}

/** Expected wpm for `chars` correct characters, with the 1000 ms floor and clamp. */
function expectedWpm(chars, timeMs) {
  return Math.min(1000, Math.round(chars / 5 / (Math.max(timeMs, 1000) / 60000)));
}

function indexOfEvent(client, name, from = 0) {
  return client.events.findIndex((e, i) => i >= from && e.name === name);
}

/* ---------- Full race ---------- */

test('two clients race the same passage from join to results', async (t) => {
  const ctx = await setup(t);

  // A joins an empty room and waits.
  const a = await ctx.client();
  const ackA = await a.join();
  assert.equal(ackA.ok, true);
  assert.match(ackA.playerId, UUID);
  assert.notEqual(ackA.playerId, a.socket.id);
  assert.equal(ackA.room.phase, 'waiting');
  assert.equal(ackA.room.players.length, 1);

  // B joins: the room fills, a countdown starts with the fixed passage.
  const b = await ctx.client();
  const ackB = await b.join();
  assert.equal(ackB.ok, true);
  assert.notEqual(ackB.playerId, ackA.playerId);
  const idA = ackA.playerId;
  const idB = ackB.playerId;

  for (const c of [a, b]) {
    const countdownState = await c.waitFor('room:state', (s) => s.phase === 'countdown');
    assert.deepEqual(
      countdownState.payload.players.map((p) => p.id),
      [idA, idB]
    );
    const countdown = await c.waitFor('race:countdown');
    assert.equal(countdown.payload.passage, FIXED_PASSAGE);
    await c.waitFor('race:start');
  }
  assert.deepEqual(lifecycle(a), [
    'room:state:waiting',
    'room:state:waiting',
    'room:state:countdown',
    'race:countdown',
    'room:state:racing',
    'race:start',
  ]);
  assert.deepEqual(lifecycle(b), [
    'room:state:waiting',
    'room:state:countdown',
    'race:countdown',
    'room:state:racing',
    'race:start',
  ]);

  // A types the first two characters; both see A's live progress.
  a.progress(1, 'ab');
  for (const c of [a, b]) {
    const update = await c.waitFor('race:update', (u) => u.players.some((p) => p.id === idA && p.correctChars === 2));
    const entryA = update.payload.players.find((p) => p.id === idA);
    assert.equal(entryA.progress, 40);
    assert.equal(entryA.finished, false);
    assert.equal(entryA.place, null);
    assert.equal(entryA.accuracy, 100);
  }

  // A finishes first.
  a.progress(2, ' cd');
  const finishA = await a.waitFor('player:finish');
  assert.equal(finishA.payload.id, idA);
  assert.equal(finishA.payload.place, 1);
  assert.equal(finishA.payload.accuracy, 100);
  assert.equal(finishA.payload.wpm, expectedWpm(5, finishA.payload.timeMs));
  assert.deepEqual((await b.waitFor('player:finish')).payload, finishA.payload);

  // B finishes second: the race ends with every player finished.
  b.progress(1, 'ab cd');
  for (const c of [a, b]) {
    const finishB = await c.waitFor('player:finish', (f) => f.id === idB);
    assert.equal(finishB.payload.place, 2);
    const end = await c.waitFor('race:end');
    assert.equal(end.payload.reason, 'all_finished');
    assert.deepEqual(
      end.payload.results.map((r) => [r.id, r.place, r.status]),
      [
        [idA, 1, 'finished'],
        [idB, 2, 'finished'],
      ]
    );
    const finishedState = await c.waitFor('room:state', (s) => s.phase === 'finished');
    assert.deepEqual(
      finishedState.payload.players.map((p) => [p.id, p.ready, p.finished]),
      [
        [idA, false, true],
        [idB, false, true],
      ]
    );
    // Order: player:finish, final race:update, race:end, room:state finished.
    const iFinish = finishB.index;
    const iUpdate = indexOfEvent(c, 'race:update', iFinish);
    assert.ok(iUpdate > iFinish && iUpdate < end.index, 'a final race:update comes before race:end');
    assert.ok(end.index < finishedState.index);
  }

  // Both press "Race again": a new countdown starts.
  assert.equal((await a.rematch()).ok, true);
  assert.equal((await b.rematch()).ok, true);
  for (const c of [a, b]) {
    const again = await c.waitFor('race:countdown');
    assert.equal(again.payload.passage, FIXED_PASSAGE);
  }
});

test('the race:end results carry the server-computed numbers', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.racing();
  a.progress(1, 'ax\bb cd');
  await a.waitFor('player:finish');
  b.progress(1, 'ab cd');
  const end = await a.waitFor('race:end');
  const [first, second] = end.payload.results;
  assert.equal(first.id, a.playerId);
  assert.equal(first.slot, 1);
  assert.equal(first.accuracy, 83);
  assert.equal(first.correctChars, 5);
  assert.equal(first.incorrectChars, 0);
  assert.equal(first.wpm, expectedWpm(5, first.timeMs));
  assert.equal(first.rawWpm, expectedWpm(6, first.timeMs));
  assert.equal(second.id, b.playerId);
  assert.equal(second.slot, 2);
  assert.equal(second.accuracy, 100);
  assert.ok(Number.isInteger(first.timeMs) && first.timeMs >= 0);
  assert.ok(second.timeMs >= first.timeMs);
});

test('live race:update stops once nothing changes', async (t) => {
  const ctx = await setup(t, { broadcastIntervalMs: 20 });
  const [a] = await ctx.racing();
  a.progress(1, 'a');
  await a.waitFor('race:update');
  await sleep(120);
  assert.equal(a.pending('race:update').length, 0, 'no update is sent while nothing changed');
});

/* ---------- Countdown before every race ---------- */

test('race:countdown always comes before race:start, right after room:state countdown', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.racing();
  for (const c of [a, b]) {
    const names = lifecycle(c);
    const iCountdown = names.indexOf('race:countdown');
    assert.ok(iCountdown > 0);
    assert.equal(names[iCountdown - 1], 'room:state:countdown');
    assert.ok(iCountdown < names.indexOf('race:start'));
  }
});

test('race:countdown announces the configured countdown and time limit', async (t) => {
  const ctx = await setup(t, { countdownMs: 120, raceTimeLimitMs: 1500 });
  await ctx.joined();
  const b = await ctx.joined();
  const countdown = await b.waitFor('race:countdown');
  assert.equal(countdown.payload.startsInMs, 120);
  assert.equal(countdown.payload.raceTimeLimitMs, 1500);
  const start = await b.waitFor('race:start');
  assert.deepEqual(start.payload, { raceTimeLimitMs: 1500 });
});

test('race:start does not arrive before the countdown has elapsed', async (t) => {
  const countdownMs = 150;
  const ctx = await setup(t, { countdownMs });
  await ctx.joined();
  const b = await ctx.client();
  const joinedAt = performance.now();
  await b.join();
  const countdown = await b.waitFor('race:countdown');
  const start = await b.waitFor('race:start');
  assert.ok(start.at - countdown.at >= countdownMs - TIMING_SLACK_MS, `gap was ${start.at - countdown.at} ms`);
  assert.ok(start.at - joinedAt >= countdownMs - TIMING_SLACK_MS);
});

test('the server default countdown of 3000 ms is announced in race:countdown', async (t) => {
  const ctx = await setup(t, { countdownMs: undefined, raceTimeLimitMs: undefined });
  await ctx.joined();
  const b = await ctx.joined();
  const countdown = await b.waitFor('race:countdown');
  assert.equal(countdown.payload.startsInMs, COUNTDOWN_MS);
  assert.equal(countdown.payload.startsInMs, 3000);
  assert.equal(countdown.payload.raceTimeLimitMs, RACE_TIME_LIMIT_MS);
  await sleep(300);
  assert.equal(b.pending('race:start').length, 0, 'the race has not started 300 ms into a 3 s countdown');
});

test('a rematch starts with a countdown before race:start, with the same timing', async (t) => {
  const countdownMs = 150;
  const ctx = await setup(t, { countdownMs });
  const [a, b] = await ctx.racing();
  a.progress(1, FIXED_PASSAGE);
  b.progress(1, FIXED_PASSAGE);
  await Promise.all([a.waitFor('race:end'), b.waitFor('race:end')]);
  await a.rematch();
  await b.rematch();
  for (const c of [a, b]) {
    const countdown = await c.waitFor('race:countdown');
    assert.equal(countdown.payload.startsInMs, countdownMs);
    const start = await c.waitFor('race:start');
    assert.ok(start.index > countdown.index);
    assert.ok(start.at - countdown.at >= countdownMs - TIMING_SLACK_MS, `gap was ${start.at - countdown.at} ms`);
  }
  const names = lifecycle(a);
  const afterEnd = names.slice(names.indexOf('race:end'));
  assert.deepEqual(afterEnd, [
    'race:end',
    'room:state:finished',
    'room:state:finished',
    'room:state:finished',
    'room:state:countdown',
    'race:countdown',
    'room:state:racing',
    'race:start',
  ]);
});

test('progress in a rematch race starts again from seq 1 and zero', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.racing();
  a.progress(1, FIXED_PASSAGE);
  b.progress(1, FIXED_PASSAGE);
  await Promise.all([a.waitFor('race:end'), b.waitFor('race:end')]);
  await a.rematch();
  await b.rematch();
  await Promise.all([a.waitFor('race:start'), b.waitFor('race:start')]);
  a.drain();
  b.progress(1, 'a');
  const update = await a.waitFor('race:update', (u) => u.players.some((p) => p.correctChars > 0));
  const byId = Object.fromEntries(update.payload.players.map((p) => [p.id, p]));
  assert.equal(byId[b.playerId].correctChars, 1);
  assert.equal(byId[a.playerId].correctChars, 0);
  assert.equal(byId[a.playerId].finished, false);
});

/* ---------- Time limit ---------- */

test('a race nobody finishes ends at the time limit ordered by correct characters', async (t) => {
  const raceTimeLimitMs = 300;
  const ctx = await setup(t, { raceTimeLimitMs });
  const [a, b] = await ctx.racing();
  b.progress(1, 'ab');
  a.progress(1, 'a');
  const end = await a.waitFor('race:end', undefined, 3000);
  assert.equal(end.payload.reason, 'time_limit');
  assert.deepEqual(
    end.payload.results.map((r) => [r.id, r.place, r.status, r.correctChars]),
    [
      [b.playerId, 1, 'unfinished', 2],
      [a.playerId, 2, 'unfinished', 1],
    ]
  );
  for (const result of end.payload.results) {
    assert.ok(result.timeMs >= raceTimeLimitMs - 5 && result.timeMs < raceTimeLimitMs + 200, `timeMs ${result.timeMs}`);
  }
  const state = await a.waitFor('room:state', (s) => s.phase === 'finished');
  assert.ok(state.payload.players.every((p) => p.ready === false && p.finished === false));
});

/* ---------- Rematch paths ---------- */

test('one rematch alone keeps the room finished with only that player ready', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.racing();
  a.progress(1, FIXED_PASSAGE);
  b.progress(1, FIXED_PASSAGE);
  await b.waitFor('room:state', (s) => s.phase === 'finished');
  const ack = await a.rematch();
  assert.equal(ack.ok, true);
  assert.equal(ack.room.phase, 'finished');
  const state = await b.waitFor('room:state', (s) => s.phase === 'finished' && s.players.some((p) => p.ready));
  assert.deepEqual(
    state.payload.players.map((p) => [p.id, p.ready]),
    [
      [a.playerId, true],
      [b.playerId, false],
    ]
  );
  await sleep(100);
  assert.equal(b.pending('race:countdown').length, 0);
});

test('a rematch after the opponent left sends the ack, room:state finished, then room:state waiting', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.racing();
  a.progress(1, FIXED_PASSAGE);
  b.progress(1, FIXED_PASSAGE);
  await a.waitFor('room:state', (s) => s.phase === 'finished');
  await b.close();
  await a.waitFor('room:state', (s) => s.phase === 'finished' && s.players.length === 1);
  a.drain();

  const ack = await a.rematch();
  assert.equal(ack.ok, true);
  assert.equal(ack.room.phase, 'finished');
  const first = await a.waitFor('room:state');
  assert.equal(first.payload.phase, 'finished');
  assert.deepEqual(first.payload.players.map((p) => [p.id, p.ready]), [[a.playerId, true]]);
  const second = await a.waitFor('room:state');
  assert.equal(second.payload.phase, 'waiting');
  assert.equal(second.index, first.index + 1);
});

test('a repeated rematch while waiting sends only the ack', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.racing();
  a.progress(1, FIXED_PASSAGE);
  b.progress(1, FIXED_PASSAGE);
  await a.waitFor('room:state', (s) => s.phase === 'finished');
  await b.close();
  await a.rematch();
  await a.waitFor('room:state', (s) => s.phase === 'waiting');
  const before = a.events.length;

  const ack = await a.rematch();
  assert.equal(ack.ok, true);
  assert.equal(ack.room.phase, 'waiting');
  await sleep(100);
  assert.deepEqual(a.events.slice(before).map((e) => e.name), []);
});

test('a new player joining after a lone rematch starts a countdown', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.racing();
  a.progress(1, FIXED_PASSAGE);
  b.progress(1, FIXED_PASSAGE);
  await a.waitFor('room:state', (s) => s.phase === 'finished');
  await b.close();
  await a.rematch();
  await a.waitFor('room:state', (s) => s.phase === 'waiting');
  const c = await ctx.joined();
  assert.equal(c.joinAck.room.phase, 'waiting');
  await a.waitFor('race:countdown');
  await c.waitFor('race:start');
});

test('a player joining a finished room waits until the remaining player presses rematch', async (t) => {
  const ctx = await setup(t);
  const [a, b] = await ctx.racing();
  a.progress(1, FIXED_PASSAGE);
  b.progress(1, FIXED_PASSAGE);
  await a.waitFor('room:state', (s) => s.phase === 'finished');
  await b.close();
  await a.waitFor('room:state', (s) => s.players.length === 1);

  const c = await ctx.joined();
  assert.equal(c.joinAck.room.phase, 'finished');
  const state = await a.waitFor('room:state', (s) => s.players.length === 2);
  assert.equal(state.payload.phase, 'finished');
  assert.deepEqual(
    state.payload.players.map((p) => [p.id, p.ready]),
    [
      [a.playerId, false],
      [c.playerId, true],
    ]
  );
  await sleep(100);
  assert.equal(c.pending('race:countdown').length, 0);

  await a.rematch();
  await c.waitFor('race:countdown');
  await c.waitFor('race:start');
});

test('the race clock starts when the countdown timer actually fires, not when it was scheduled', async (t) => {
  // An injected clock lets the test simulate a timer that fires late.
  let fakeNow = 0;
  const ctx = await setup(t, { countdownMs: 200, now: () => fakeNow });
  const a = await ctx.joined();
  const b = await ctx.joined();
  await a.waitFor('race:countdown'); // scheduled start: 0 + 200
  fakeNow = 1000; // the timer "fires" 800 ms late
  await Promise.all([a.waitFor('race:start'), b.waitFor('race:start')]);
  fakeNow = 3000;
  a.progress(1, FIXED_PASSAGE);
  const finish = await b.waitFor('player:finish');
  assert.equal(finish.payload.timeMs, 2000);
  assert.equal(finish.payload.wpm, expectedWpm(5, 2000));
});

test('a time-limit end lists the finisher first and the unfinished player second', async (t) => {
  const ctx = await setup(t, { raceTimeLimitMs: 300 });
  const [a, b] = await ctx.racing();
  b.progress(1, FIXED_PASSAGE);
  a.progress(1, 'ab c');
  const end = await a.waitFor('race:end', undefined, 3000);
  assert.equal(end.payload.reason, 'time_limit');
  assert.deepEqual(
    end.payload.results.map((r) => [r.id, r.place, r.status]),
    [
      [b.playerId, 1, 'finished'],
      [a.playerId, 2, 'unfinished'],
    ]
  );
  assert.ok(end.payload.results[0].timeMs < end.payload.results[1].timeMs);
});
