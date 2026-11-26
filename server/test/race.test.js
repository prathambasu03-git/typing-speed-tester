'use strict';

/* Pure room state machine and scoring (server/src/race.js). Fake `now`
   values, fixed passage 'ab cd', no sockets and no timers. */

const test = require('node:test');
const assert = require('node:assert/strict');
const race = require('../src/race');
const { COUNTDOWN_MS } = require('../src/constants');

const PASSAGE = 'ab cd';
const START = 10_000;
const CODE = 'K7QM2X';

/** A room with `count` joined players (socket ids s1, s2, ...). */
function roomWith(count, { maxPlayers = 2, minPlayers = 2 } = {}) {
  const room = race.createRoom(CODE, { maxPlayers, minPlayers });
  const players = [];
  for (let i = 1; i <= count; i += 1) {
    const result = race.addPlayer(room, { id: `p${i}`, socketId: `s${i}` });
    assert.equal(result.ok, true);
    players.push(result.player);
  }
  return { room, players };
}

/** A room already racing on `passage`, with the clock started at START. */
function racingRoom(count = 2, passage = PASSAGE, limits) {
  const { room, players } = roomWith(count, limits);
  race.beginCountdown(room, passage, START - COUNTDOWN_MS, COUNTDOWN_MS);
  race.beginRace(room, START);
  return { room, players };
}

/* ---------- createRoom and addPlayer ---------- */

test('a new room is keyed by its code and is waiting with no players, host or passage', () => {
  const room = race.createRoom(CODE, { maxPlayers: 4, minPlayers: 2 });
  assert.equal(room.id, CODE);
  assert.equal(room.phase, 'waiting');
  assert.equal(room.maxPlayers, 4);
  assert.equal(room.minPlayers, 2);
  assert.deepEqual(room.players, []);
  assert.equal(room.hostId, null);
  assert.equal(room.lobbyDeadline, null);
  assert.equal(room.nextJoinSeq, 1);
  assert.equal(room.passage, null);
  assert.equal(room.startAt, null);
});

test('the first player to join becomes the host', () => {
  const { room } = roomWith(2);
  assert.equal(room.hostId, 'p1');
  assert.equal(race.isHost(room, 'p1'), true);
  assert.equal(race.isHost(room, 'p2'), false);
});

test('isHost is false for every id while the room has no host', () => {
  const room = race.createRoom(CODE, { maxPlayers: 4, minPlayers: 2 });
  assert.equal(race.isHost(room, null), false);
  assert.equal(race.isHost(room, 'p1'), false);
});

test('new players join with inRace false and joinSeq 1, 2, 3', () => {
  const { players } = roomWith(3, { maxPlayers: 4 });
  assert.deepEqual(players.map((p) => p.joinSeq), [1, 2, 3]);
  assert.ok(players.every((p) => p.inRace === false && p.ready === true));
});

test('joinSeq is never reused after a player leaves', () => {
  const { room } = roomWith(3, { maxPlayers: 4 });
  race.removePlayer(room, 's2', 0);
  const added = race.addPlayer(room, { id: 'p4', socketId: 's4' });
  assert.equal(added.player.joinSeq, 4);
  assert.equal(added.player.slot, 2, 'the freed slot is reused');
  assert.equal(room.nextJoinSeq, 5);
});

test('ROOM_FULL is checked before RACE_IN_PROGRESS', () => {
  const { room } = racingRoom(2, PASSAGE, { maxPlayers: 2, minPlayers: 2 });
  assert.deepEqual(race.addPlayer(room, { id: 'p3', socketId: 's3' }), { ok: false, code: 'ROOM_FULL' });
});

test('joining players get slots 1 and 2 and start ready and connected', () => {
  const { players } = roomWith(2);
  assert.deepEqual(players.map((p) => p.slot), [1, 2]);
  for (const player of players) {
    assert.equal(player.ready, true);
    assert.equal(player.connected, true);
  }
});

test('a third player is refused with ROOM_FULL', () => {
  const { room } = roomWith(2);
  assert.deepEqual(race.addPlayer(room, { id: 'p3', socketId: 's3' }), { ok: false, code: 'ROOM_FULL' });
  assert.equal(room.players.length, 2);
});

test('the same socket joining twice is refused with ALREADY_JOINED', () => {
  const { room } = roomWith(1);
  assert.deepEqual(race.addPlayer(room, { id: 'again', socketId: 's1' }), { ok: false, code: 'ALREADY_JOINED' });
  assert.equal(room.players.length, 1);
});

test('ALREADY_JOINED is checked before ROOM_FULL', () => {
  const { room } = roomWith(2);
  assert.equal(race.addPlayer(room, { id: 'again', socketId: 's2' }).code, 'ALREADY_JOINED');
});

test('joining during a countdown is refused with RACE_IN_PROGRESS when a slot is free', () => {
  const { room } = roomWith(2, { maxPlayers: 3 });
  race.beginCountdown(room, PASSAGE, 0, 3000);
  assert.deepEqual(race.addPlayer(room, { id: 'p3', socketId: 's3' }), { ok: false, code: 'RACE_IN_PROGRESS' });
});

test('joining during a race is refused with RACE_IN_PROGRESS when a slot is free', () => {
  const { room } = racingRoom(2, PASSAGE, { maxPlayers: 3, minPlayers: 2 });
  assert.deepEqual(race.addPlayer(room, { id: 'p3', socketId: 's3' }), { ok: false, code: 'RACE_IN_PROGRESS' });
});

test('joining a finished room with a free slot is allowed', () => {
  const { room } = racingRoom(2, PASSAGE, { maxPlayers: 3, minPlayers: 2 });
  race.endRace(room);
  assert.equal(race.addPlayer(room, { id: 'p3', socketId: 's3' }).ok, true);
});

test('slot 1 is reused after its player leaves', () => {
  const { room } = roomWith(2);
  race.removePlayer(room, 's1', 0);
  const result = race.addPlayer(room, { id: 'p3', socketId: 's3' });
  assert.equal(result.player.slot, 1);
  assert.deepEqual(room.players.map((p) => p.id), ['p3', 'p2']);
});

/* ---------- removePlayer and setReady ---------- */

test('a player who leaves while waiting is removed from the room', () => {
  const { room } = roomWith(2);
  const result = race.removePlayer(room, 's2', 5);
  assert.equal(result.removed, true);
  assert.equal(result.player.id, 'p2');
  assert.deepEqual(room.players.map((p) => p.id), ['p1']);
});

test('removing an unknown socket changes nothing', () => {
  const { room } = roomWith(1);
  assert.deepEqual(race.removePlayer(room, 'nope', 5), { removed: false, player: null });
  assert.equal(room.players.length, 1);
});

test('a player who leaves mid-race stays in the room as disconnected', () => {
  const { room, players } = racingRoom();
  const result = race.removePlayer(room, 's2', START + 500);
  assert.equal(result.removed, false);
  assert.equal(players[1].connected, false);
  assert.equal(players[1].leftAt, START + 500);
  assert.equal(room.dirty, true);
  assert.equal(room.players.length, 2);
});

test('a player who left mid-race has frozen stats and ignored keys', () => {
  const { room, players } = racingRoom();
  race.applyKeys(room, players[1], 'ab', START + 400);
  race.removePlayer(room, 's2', START + 2000);
  assert.deepEqual(race.applyKeys(room, players[1], ' cd', START + 2100), { changed: false, finished: false });
  const entry = race.buildResults(room, START + 60000).find((r) => r.id === 'p2');
  assert.equal(entry.status, 'left');
  assert.equal(entry.correctChars, 2);
  assert.equal(entry.timeMs, 2000);
  // 2 chars over 2 s = 12 wpm; it does not keep dropping as the race goes on.
  assert.equal(entry.wpm, 12);
});

test('setReady marks a player ready and refuses an unknown socket', () => {
  const { room, players } = roomWith(1);
  players[0].ready = false;
  assert.deepEqual(race.setReady(room, 's1'), { ok: true });
  assert.equal(players[0].ready, true);
  assert.deepEqual(race.setReady(room, 'nope'), { ok: false, code: 'NOT_IN_ROOM' });
});

/* ---------- reassignHost ---------- */

test('the host passes by join order, not slot, when a later joiner took a freed lower slot', () => {
  // A (slot 1, seq 1), B (slot 2, seq 2), C (slot 3, seq 3); B leaves; D takes slot 2 (seq 4); A leaves.
  const { room } = roomWith(3, { maxPlayers: 4 });
  race.removePlayer(room, 's2', 0);
  const d = race.addPlayer(room, { id: 'p4', socketId: 's4' }).player;
  assert.equal(d.slot, 2);
  race.removePlayer(room, 's1', 0);
  assert.equal(room.hostId, 'p3', 'C joined before D');
});

test('reassignHost returns false and keeps the host while the host is still connected', () => {
  const { room } = roomWith(2);
  assert.equal(race.reassignHost(room), false);
  assert.equal(room.hostId, 'p1');
});

test('reassignHost skips a disconnected racer and returns true when the host changes', () => {
  const { room, players } = racingRoom(3, PASSAGE, { maxPlayers: 4, minPlayers: 2 });
  players[1].connected = false; // p2 left mid-race
  players[0].connected = false; // the host left mid-race
  assert.equal(race.reassignHost(room), true);
  assert.equal(room.hostId, 'p3');
});

test('a host leaving mid-race passes the host at once to the earliest-joined connected player', () => {
  const { room } = racingRoom(3, PASSAGE, { maxPlayers: 4, minPlayers: 2 });
  race.removePlayer(room, 's1', START + 100);
  assert.equal(room.hostId, 'p2');
});

test('reassignHost gives null when no connected player is left', () => {
  const { room } = racingRoom(2);
  race.removePlayer(room, 's1', START + 100);
  race.removePlayer(room, 's2', START + 100);
  assert.equal(room.hostId, null);
});

test('removing the last player of a waiting room leaves no host', () => {
  const { room } = roomWith(1);
  race.removePlayer(room, 's1', 0);
  assert.equal(room.hostId, null);
});

/* ---------- shouldReturnToWaiting ---------- */

test('a finished room where every player is ready returns to waiting, even with one player', () => {
  const { room } = roomWith(1);
  room.phase = 'finished';
  assert.equal(race.shouldReturnToWaiting(room), true);
});

test('a finished room with two ready players returns to waiting and never to a countdown', () => {
  const { room } = roomWith(2);
  room.phase = 'finished';
  assert.equal(race.shouldReturnToWaiting(room), true);
});

test('a finished room with one player not ready stays finished', () => {
  const { room, players } = roomWith(2);
  room.phase = 'finished';
  players[1].ready = false;
  assert.equal(race.shouldReturnToWaiting(room), false);
});

test('the return check does nothing in waiting, countdown or racing', () => {
  const { room } = roomWith(2);
  for (const phase of ['waiting', 'countdown', 'racing']) {
    room.phase = phase;
    assert.equal(race.shouldReturnToWaiting(room), false, phase);
  }
});

test('an empty finished room does not return to waiting', () => {
  const room = race.createRoom(CODE, { maxPlayers: 2, minPlayers: 2 });
  room.phase = 'finished';
  assert.equal(race.shouldReturnToWaiting(room), false);
});

/* ---------- canStart ---------- */

test('canStart: a non-host is refused with NOT_HOST even while racing', () => {
  const { room } = racingRoom(2);
  assert.deepEqual(race.canStart(room, 'p2'), { ok: false, code: 'NOT_HOST' });
});

test('canStart: the host during a countdown gets RACE_IN_PROGRESS', () => {
  const { room } = roomWith(2);
  race.beginCountdown(room, PASSAGE, 0, 3000);
  assert.deepEqual(race.canStart(room, 'p1'), { ok: false, code: 'RACE_IN_PROGRESS' });
});

test('canStart: the host during a race gets RACE_IN_PROGRESS', () => {
  const { room } = racingRoom(2);
  assert.deepEqual(race.canStart(room, 'p1'), { ok: false, code: 'RACE_IN_PROGRESS' });
});

test('canStart: the host alone in waiting gets NOT_ENOUGH_PLAYERS', () => {
  const { room } = roomWith(1);
  assert.deepEqual(race.canStart(room, 'p1'), { ok: false, code: 'NOT_ENOUGH_PLAYERS' });
});

test('canStart: the host alone in finished gets NOT_ENOUGH_PLAYERS', () => {
  const { room } = roomWith(1);
  room.phase = 'finished';
  assert.deepEqual(race.canStart(room, 'p1'), { ok: false, code: 'NOT_ENOUGH_PLAYERS' });
});

test('canStart: finished with three players and only the host ready gets PLAYERS_NOT_READY', () => {
  const { room, players } = roomWith(3, { maxPlayers: 4 });
  room.phase = 'finished';
  players[1].ready = false;
  players[2].ready = false;
  assert.deepEqual(race.canStart(room, 'p1'), { ok: false, code: 'PLAYERS_NOT_READY' });
});

test('canStart: finished with the host not ready and B ready is ok because the host counts', () => {
  const { room, players } = roomWith(3, { maxPlayers: 4 });
  room.phase = 'finished';
  players[0].ready = false;
  players[2].ready = false;
  assert.deepEqual(race.canStart(room, 'p1'), { ok: true });
});

test('canStart: finished with the host and B ready and C not ready is ok', () => {
  const { room, players } = roomWith(3, { maxPlayers: 4 });
  room.phase = 'finished';
  players[2].ready = false;
  assert.deepEqual(race.canStart(room, 'p1'), { ok: true });
});

test('canStart: the host with two players in waiting is ok', () => {
  const { room } = roomWith(2);
  assert.deepEqual(race.canStart(room, 'p1'), { ok: true });
});

/* ---------- Countdown and race start ---------- */

test('beginCountdown sets the passage and a provisional start after the default 3000 ms', () => {
  const { room } = roomWith(2);
  race.beginCountdown(room, PASSAGE, 1000, COUNTDOWN_MS);
  assert.equal(room.phase, 'countdown');
  assert.deepEqual(room.passage, ['a', 'b', ' ', 'c', 'd']);
  assert.equal(room.startAt, 4000);
  assert.equal(room.finishCount, 0);
});

test('beginCountdown resets every race field left over from the previous race for every racer', () => {
  const { room, players } = racingRoom();
  race.applyKeys(room, players[0], 'ab cd', START + 100);
  race.applyKeys(room, players[1], 'x', START + 100);
  players[1].lastSeq = 7;
  race.endRace(room);
  // Both pressed "Race again", so both race (M2 seating rule).
  race.setReady(room, 's1');
  race.setReady(room, 's2');
  race.beginCountdown(room, 'xyz', START + 5000, 50);
  assert.equal(room.finishCount, 0);
  for (const player of players) {
    assert.equal(player.index, 0);
    assert.deepEqual(player.results, [null, null, null]);
    assert.equal(player.totalKeystrokes, 0);
    assert.equal(player.correctKeystrokes, 0);
    assert.equal(player.correctCount, 0);
    assert.equal(player.incorrectCount, 0);
    assert.equal(player.lastSeq, 0);
    assert.equal(player.finishedAt, null);
    assert.equal(player.leftAt, null);
    assert.equal(player.place, null);
  }
});

test('beginCountdown from waiting seats every player', () => {
  const { room, players } = roomWith(3, { maxPlayers: 4 });
  race.beginCountdown(room, PASSAGE, 0, 3000);
  assert.deepEqual(players.map((p) => [p.inRace, p.ready]), [
    [true, true],
    [true, true],
    [true, true],
  ]);
});

test('beginCountdown from finished seats the ready players and the host, and makes everyone ready', () => {
  const { room, players } = racingRoom(3, PASSAGE, { maxPlayers: 4, minPlayers: 2 });
  for (const p of players) race.applyKeys(room, p, 'ab', START + 100);
  race.endRace(room);
  race.setReady(room, 's1'); // host ready
  race.setReady(room, 's2'); // B ready; C not
  race.beginCountdown(room, 'xyz', START + 5000, 50);
  assert.deepEqual(players.map((p) => [p.id, p.inRace, p.ready]), [
    ['p1', true, true],
    ['p2', true, true],
    ['p3', false, true],
  ]);
  // Only racers get fresh race fields; C keeps the old numbers but never races.
  assert.deepEqual(players[0].results, [null, null, null]);
  assert.deepEqual(players[1].results, [null, null, null]);
  assert.equal(players[2].index, 2);
});

test('beginCountdown seats a host who has not pressed Race again', () => {
  const { room, players } = racingRoom(3, PASSAGE, { maxPlayers: 4, minPlayers: 2 });
  race.endRace(room);
  race.setReady(room, 's2');
  race.beginCountdown(room, PASSAGE, START + 5000, 50);
  assert.deepEqual(players.map((p) => p.inRace), [true, true, false]);
});

test('cancelCountdown returns the room to waiting, drops the passage and unseats everyone', () => {
  const { room, players } = roomWith(2);
  race.beginCountdown(room, PASSAGE, 0, 3000);
  race.cancelCountdown(room);
  assert.equal(room.phase, 'waiting');
  assert.equal(room.passage, null);
  assert.equal(room.startAt, null);
  assert.ok(players.every((p) => p.inRace === false && p.ready === true));
});

test('markWaiting sets every inRace false and every ready true', () => {
  const { room, players } = racingRoom(2);
  race.endRace(room);
  race.markWaiting(room);
  assert.equal(room.phase, 'waiting');
  assert.ok(players.every((p) => p.inRace === false && p.ready === true));
});

test('abandonRace returns to waiting, removes disconnected players and passes the host', () => {
  const { room } = racingRoom(2, PASSAGE, { maxPlayers: 4, minPlayers: 2 });
  race.endRace(room);
  race.addPlayer(room, { id: 'p3', socketId: 's3' }); // joins on results
  race.setReady(room, 's1');
  race.beginCountdown(room, PASSAGE, START, 0); // p1, p3 race; p2 sits out
  race.beginRace(room, START);
  race.removePlayer(room, 's1', START + 100);
  race.removePlayer(room, 's3', START + 100);
  assert.equal(race.hasConnectedRacer(room), false);
  race.abandonRace(room);
  assert.equal(room.phase, 'waiting');
  assert.equal(room.passage, null);
  assert.equal(room.startAt, null);
  assert.equal(room.finishCount, 0);
  assert.deepEqual(room.players.map((p) => [p.id, p.inRace, p.ready]), [['p2', false, true]]);
  assert.equal(room.hostId, 'p2');
});

test('beginRace resets startAt to the moment the countdown timer actually fired', () => {
  const { room } = roomWith(2);
  race.beginCountdown(room, PASSAGE, 0, 3000);
  race.beginRace(room, 3250);
  assert.equal(room.phase, 'racing');
  assert.equal(room.startAt, 3250);
});

test('beginRace without a time keeps the provisional startAt', () => {
  const { room } = roomWith(2);
  race.beginCountdown(room, PASSAGE, 0, 3000);
  race.beginRace(room);
  assert.equal(room.startAt, 3000);
});

test('a late countdown timer does not shorten the race clock', () => {
  const { room, players } = roomWith(2);
  race.beginCountdown(room, PASSAGE, 0, 3000);
  race.beginRace(room, 3400);
  race.applyKeys(room, players[0], PASSAGE, 4400);
  assert.equal(race.buildFinish(room, players[0]).timeMs, 1000);
});

/* ---------- applyKeys ---------- */

test('typing the whole passage finishes the player in place 1', () => {
  const { room, players } = racingRoom();
  const outcome = race.applyKeys(room, players[0], 'ab cd', START + 2000);
  assert.deepEqual(outcome, { changed: true, finished: true });
  assert.equal(players[0].place, 1);
  assert.equal(players[0].finishedAt, START + 2000);
  assert.equal(players[0].correctKeystrokes, 5);
  assert.equal(players[0].totalKeystrokes, 5);
  assert.equal(room.finishCount, 1);
});

test('a corrected mistake still finishes, with accuracy 83', () => {
  const { room, players } = racingRoom();
  const outcome = race.applyKeys(room, players[0], 'ax\bb cd', START + 6000);
  assert.equal(outcome.finished, true);
  assert.equal(players[0].totalKeystrokes, 6);
  assert.equal(players[0].correctKeystrokes, 5);
  assert.equal(race.buildFinish(room, players[0]).accuracy, 83);
});

test('the full length with a mistake at the end does not finish', () => {
  const { room, players } = racingRoom();
  const outcome = race.applyKeys(room, players[0], 'ab cx', START + 1000);
  assert.deepEqual(outcome, { changed: true, finished: false });
  assert.equal(players[0].finishedAt, null);
  assert.equal(players[0].place, null);
});

test('keys typed past the end of the passage are ignored and not counted', () => {
  const { room, players } = racingRoom();
  race.applyKeys(room, players[0], 'ab cx', START + 1000);
  const outcome = race.applyKeys(room, players[0], 'zzz', START + 1100);
  assert.deepEqual(outcome, { changed: false, finished: false });
  assert.equal(players[0].totalKeystrokes, 5);
  assert.equal(players[0].index, 5);
});

test('fixing the last character after reaching the end finishes the player', () => {
  const { room, players } = racingRoom();
  race.applyKeys(room, players[0], 'ab cx', START + 1000);
  assert.equal(race.applyKeys(room, players[0], '\bd', START + 1100).finished, true);
});

test('a Backspace at the start of the passage is ignored', () => {
  const { room, players } = racingRoom();
  const outcome = race.applyKeys(room, players[0], '\b', START + 100);
  assert.deepEqual(outcome, { changed: false, finished: false });
  assert.equal(players[0].index, 0);
  assert.equal(players[0].totalKeystrokes, 0);
});

test('a Backspace undoes the counter for the erased character but not the keystroke counts', () => {
  const { room, players } = racingRoom();
  race.applyKeys(room, players[0], 'ab\b', START + 100);
  assert.equal(players[0].index, 1);
  assert.equal(players[0].correctCount, 1);
  assert.equal(players[0].results[1], null);
  assert.equal(players[0].totalKeystrokes, 2);
  assert.equal(players[0].correctKeystrokes, 2);
});

test('keys after the finish in the same batch are ignored', () => {
  const { room, players } = racingRoom();
  const outcome = race.applyKeys(room, players[0], 'ab cd\b\bxx', START + 100);
  assert.equal(outcome.finished, true);
  assert.equal(players[0].index, 5);
  assert.equal(players[0].totalKeystrokes, 5);
});

test('keys from a player who already finished are ignored', () => {
  const { room, players } = racingRoom();
  race.applyKeys(room, players[0], 'ab cd', START + 100);
  assert.deepEqual(race.applyKeys(room, players[0], '\b', START + 200), { changed: false, finished: false });
  assert.equal(players[0].place, 1);
  assert.equal(room.finishCount, 1);
});

test('keys during the countdown are ignored', () => {
  const { room, players } = roomWith(2);
  race.beginCountdown(room, PASSAGE, 0, 3000);
  assert.deepEqual(race.applyKeys(room, players[0], 'ab cd', 100), { changed: false, finished: false });
  assert.equal(players[0].index, 0);
});

test('keys after the race ended are ignored', () => {
  const { room, players } = racingRoom();
  race.endRace(room);
  assert.deepEqual(race.applyKeys(room, players[0], 'ab cd', START + 100), { changed: false, finished: false });
});

test('two players finishing at the same millisecond get places 1 and 2 in processing order', () => {
  const { room, players } = racingRoom();
  race.applyKeys(room, players[1], 'ab cd', START + 700);
  race.applyKeys(room, players[0], 'ab cd', START + 700);
  assert.equal(players[1].place, 1);
  assert.equal(players[0].place, 2);
  const results = race.buildResults(room, START + 700);
  assert.deepEqual(results.map((r) => [r.id, r.place]), [['p2', 1], ['p1', 2]]);
});

/* ---------- Sitting out (M2) ---------- */

/** Racing room: p1 (host) and p2 race, p3 sits out (it did not press Race again). */
function roomWithSitOut() {
  const { room, players } = racingRoom(3, PASSAGE, { maxPlayers: 4, minPlayers: 2 });
  race.endRace(room);
  race.setReady(room, 's1');
  race.setReady(room, 's2');
  race.beginCountdown(room, PASSAGE, START - 50, 50);
  race.beginRace(room, START);
  return { room, players };
}

test('racers lists only players with inRace', () => {
  const { room } = roomWithSitOut();
  assert.deepEqual(race.racers(room).map((p) => p.id), ['p1', 'p2']);
});

test('a racer leaving mid-race stays as disconnected while a sitting-out player is removed', () => {
  const { room, players } = roomWithSitOut();
  const racer = race.removePlayer(room, 's2', START + 100);
  assert.equal(racer.removed, false);
  assert.equal(players[1].connected, false);
  const sitter = race.removePlayer(room, 's3', START + 100);
  assert.equal(sitter.removed, true);
  assert.deepEqual(room.players.map((p) => p.id), ['p1', 'p2']);
});

test('applyKeys changes nothing for a sitting-out player, even the whole passage', () => {
  const { room, players } = roomWithSitOut();
  assert.deepEqual(race.applyKeys(room, players[2], PASSAGE, START + 100), { changed: false, finished: false });
  assert.equal(players[2].finishedAt, null);
  assert.equal(room.finishCount, 0);
  assert.equal(room.dirty, false);
});

test('the race is over when both racers finished even though a sitting-out player is connected', () => {
  const { room, players } = roomWithSitOut();
  race.applyKeys(room, players[0], PASSAGE, START + 100);
  race.applyKeys(room, players[1], PASSAGE, START + 200);
  assert.equal(race.isRaceOver(room), true);
});

test('the race is not over while a racer has not finished', () => {
  const { room, players } = roomWithSitOut();
  race.applyKeys(room, players[0], PASSAGE, START + 100);
  assert.equal(race.isRaceOver(room), false);
});

test('the race is not over and hasConnectedRacer is false when only a sitting-out player is connected', () => {
  const { room } = roomWithSitOut();
  race.removePlayer(room, 's1', START + 100);
  race.removePlayer(room, 's2', START + 100);
  assert.equal(race.isRaceOver(room), false);
  assert.equal(race.hasConnectedRacer(room), false);
});

test('hasConnectedRacer is true while one racer is connected', () => {
  const { room } = roomWithSitOut();
  race.removePlayer(room, 's1', START + 100);
  assert.equal(race.hasConnectedRacer(room), true);
});

test('buildResults and buildProgress exclude sitting-out players', () => {
  const { room } = roomWithSitOut();
  assert.deepEqual(race.buildResults(room, START + 500).map((r) => r.id).sort(), ['p1', 'p2']);
  assert.deepEqual(race.buildProgress(room, START + 500).players.map((p) => p.id), ['p1', 'p2']);
});

test('endRace sets racers not ready and leaves sitting-out players ready', () => {
  const { room, players } = roomWithSitOut();
  race.endRace(room);
  assert.deepEqual(players.map((p) => [p.id, p.ready]), [
    ['p1', false],
    ['p2', false],
    ['p3', true],
  ]);
});

test('endRace passes the host when the host left during the race', () => {
  const { room } = roomWithSitOut();
  race.removePlayer(room, 's1', START + 100);
  race.endRace(room);
  assert.deepEqual(room.players.map((p) => p.id), ['p2', 'p3']);
  assert.equal(room.hostId, 'p2');
});

/* ---------- isRaceOver ---------- */

test('the race is not over while a connected player is still typing', () => {
  const { room, players } = racingRoom();
  race.applyKeys(room, players[0], 'ab cd', START + 100);
  assert.equal(race.isRaceOver(room), false);
});

test('the race is over when every connected player has finished', () => {
  const { room, players } = racingRoom();
  race.applyKeys(room, players[0], 'ab cd', START + 100);
  race.removePlayer(room, 's2', START + 200);
  assert.equal(race.isRaceOver(room), true);
});

test('the race is not over when nobody is connected', () => {
  const { room } = racingRoom();
  race.removePlayer(room, 's1', START + 100);
  race.removePlayer(room, 's2', START + 100);
  assert.equal(race.isRaceOver(room), false);
});

/* ---------- Scoring: buildProgress, buildFinish, buildResults ---------- */

test('buildProgress reports correct characters and floored percent progress', () => {
  const { room, players } = racingRoom();
  race.applyKeys(room, players[0], 'ab', START + 300);
  const progress = race.buildProgress(room, START + 300);
  assert.equal(progress.elapsedMs, 300);
  const entry = progress.players.find((p) => p.id === 'p1');
  assert.deepEqual(entry, { id: 'p1', correctChars: 2, progress: 40, wpm: 24, accuracy: 100, finished: false, place: null });
});

test('live wpm in the first second is computed over a 1000 ms floor', () => {
  const { room, players } = racingRoom();
  race.applyKeys(room, players[0], 'ab c', START + 100);
  // 4 chars over 100 ms would be 480 wpm; over the 1000 ms floor it is 48.
  assert.equal(race.buildProgress(room, START + 100).players[0].wpm, 48);
});

test('a finish in under a second reports the real time and wpm over the 1000 ms floor', () => {
  const { room, players } = racingRoom();
  race.applyKeys(room, players[0], 'ab cd', START + 250);
  assert.deepEqual(race.buildFinish(room, players[0]), { id: 'p1', place: 1, timeMs: 250, wpm: 60, accuracy: 100 });
});

test('a finisher at 30 s with 150 correct characters scores 60 wpm', () => {
  const passage = 'a'.repeat(150);
  const { room, players } = racingRoom(2, passage);
  race.applyKeys(room, players[0], passage, START + 30000);
  const entry = race.buildResults(room, START + 30000)[0];
  assert.equal(entry.id, 'p1');
  assert.equal(entry.status, 'finished');
  assert.equal(entry.wpm, 60);
  assert.equal(entry.rawWpm, 60);
  assert.equal(entry.accuracy, 100);
  assert.equal(entry.timeMs, 30000);
});

test('wpm is clamped to 1000', () => {
  const passage = 'a'.repeat(100);
  const { room, players } = racingRoom(2, passage);
  race.applyKeys(room, players[0], passage, START + 10);
  // 100 chars over the 1000 ms floor is 1200 wpm before clamping.
  assert.equal(race.buildFinish(room, players[0]).wpm, 1000);
  assert.equal(race.buildResults(room, START + 10)[0].wpm, 1000);
  assert.equal(race.buildProgress(room, START + 10).players[0].wpm, 1000);
});

test('rawWpm is clamped to 5000', () => {
  const passage = 'a'.repeat(500);
  const { room, players } = racingRoom(2, passage);
  race.applyKeys(room, players[0], 'b'.repeat(500), START + 10);
  // 500 keystrokes over the 1000 ms floor is 6000 raw wpm before clamping.
  const entry = race.buildResults(room, START + 10).find((r) => r.id === 'p1');
  assert.equal(entry.rawWpm, 5000);
  assert.equal(entry.wpm, 0);
  assert.equal(entry.accuracy, 0);
  assert.equal(entry.incorrectChars, 500);
});

test('a player who typed nothing scores zero on every number', () => {
  const { room } = racingRoom();
  const entry = race.buildResults(room, START + 5000).find((r) => r.id === 'p2');
  assert.deepEqual(
    { wpm: entry.wpm, rawWpm: entry.rawWpm, accuracy: entry.accuracy, correctChars: entry.correctChars },
    { wpm: 0, rawWpm: 0, accuracy: 0, correctChars: 0 }
  );
});

test('an unfinished player at the time limit has timeMs equal to the elapsed race time', () => {
  const { room, players } = racingRoom();
  race.applyKeys(room, players[0], 'ab', START + 100);
  const entry = race.buildResults(room, START + 120000).find((r) => r.id === 'p1');
  assert.equal(entry.status, 'unfinished');
  assert.equal(entry.timeMs, 120000);
});

test('results order finishers by place, then unfinished by correct characters, then players who left', () => {
  const { room, players } = racingRoom(5, PASSAGE, { maxPlayers: 5, minPlayers: 2 });
  const [p1, p2, p3, p4, p5] = players;
  race.applyKeys(room, p2, 'ab cd', START + 1000);
  race.applyKeys(room, p1, 'ab cd', START + 2000);
  race.applyKeys(room, p4, 'a', START + 2000);
  race.applyKeys(room, p3, 'ab c', START + 2000);
  race.applyKeys(room, p5, 'ab c', START + 2000);
  race.removePlayer(room, 's5', START + 2500);
  const results = race.buildResults(room, START + 3000);
  assert.deepEqual(
    results.map((r) => [r.id, r.place, r.status]),
    [
      ['p2', 1, 'finished'],
      ['p1', 2, 'finished'],
      ['p3', 3, 'unfinished'],
      ['p4', 4, 'unfinished'],
      ['p5', 5, 'left'],
    ]
  );
});

test('unfinished players with equal correct characters are ordered by accuracy, then slot', () => {
  const { room, players } = racingRoom(3, PASSAGE, { maxPlayers: 3, minPlayers: 2 });
  const [p1, p2, p3] = players;
  race.applyKeys(room, p1, 'ax\bb', START + 100); // 2 correct, accuracy 66
  race.applyKeys(room, p2, 'ab', START + 100); // 2 correct, accuracy 100
  race.applyKeys(room, p3, 'ab', START + 100); // 2 correct, accuracy 100, higher slot
  const results = race.buildResults(room, START + 500);
  assert.deepEqual(results.map((r) => r.id), ['p2', 'p3', 'p1']);
});

test('result places are unique and run from 1 to n', () => {
  const { room, players } = racingRoom(3, PASSAGE, { maxPlayers: 3, minPlayers: 2 });
  race.applyKeys(room, players[2], 'ab cd', START + 100);
  const places = race.buildResults(room, START + 500).map((r) => r.place);
  assert.deepEqual(places, [1, 2, 3]);
});

test('result entries have exactly the fields in PROTOCOL.md section 6', () => {
  const { room, players } = racingRoom();
  race.applyKeys(room, players[0], 'ab cd', START + 100);
  for (const entry of race.buildResults(room, START + 100)) {
    assert.deepEqual(Object.keys(entry).sort(), [
      'accuracy',
      'correctChars',
      'id',
      'incorrectChars',
      'place',
      'rawWpm',
      'slot',
      'status',
      'timeMs',
      'wpm',
    ]);
  }
});

/* ---------- endRace and toSnapshot ---------- */

test('endRace sets finished, drops disconnected players and clears ready', () => {
  const { room, players } = racingRoom();
  race.applyKeys(room, players[0], 'ab cd', START + 100);
  race.removePlayer(room, 's2', START + 200);
  race.endRace(room);
  assert.equal(room.phase, 'finished');
  assert.deepEqual(room.players.map((p) => p.id), ['p1']);
  assert.equal(players[0].ready, false);
  assert.equal(room.dirty, false);
});

test('a snapshot lists players by slot with code, host and lobby time, and never socket ids or joinSeq', () => {
  const { room } = roomWith(2);
  race.removePlayer(room, 's1', 0);
  race.addPlayer(room, { id: 'p3', socketId: 's3' });
  room.lobbyDeadline = 5000;
  const snapshot = race.toSnapshot(room, 2000);
  assert.deepEqual(snapshot, {
    code: CODE,
    phase: 'waiting',
    maxPlayers: 2,
    minPlayers: 2,
    hostId: 'p2',
    expiresInMs: 3000,
    players: [
      { id: 'p3', slot: 1, connected: true, ready: true, inRace: false, finished: false },
      { id: 'p2', slot: 2, connected: true, ready: true, inRace: false, finished: false },
    ],
  });
  const text = JSON.stringify(snapshot);
  assert.ok(!text.includes('s3') && !text.includes('s2'));
  assert.ok(!text.includes('joinSeq') && !text.includes('socketId') && !text.includes('lobbyDeadline'));
});

test('a snapshot has expiresInMs null outside waiting and inRace true for racers', () => {
  const { room } = roomWith(2);
  room.lobbyDeadline = 5000;
  race.beginCountdown(room, PASSAGE, 0, 3000);
  const snapshot = race.toSnapshot(room, 2000);
  assert.equal(snapshot.phase, 'countdown');
  assert.equal(snapshot.expiresInMs, null);
  assert.ok(snapshot.players.every((p) => p.inRace === true));
});

test('a snapshot shows finished false for a sat-out player who finished the previous race', () => {
  const { room, players } = racingRoom(3, PASSAGE, { maxPlayers: 4, minPlayers: 2 });
  race.applyKeys(room, players[2], PASSAGE, START + 100);
  race.endRace(room);
  race.setReady(room, 's1');
  race.setReady(room, 's2');
  race.beginCountdown(room, PASSAGE, START + 5000, 50); // p3 sits out
  const p3 = race.toSnapshot(room, START + 5000).players.find((p) => p.id === 'p3');
  assert.equal(players[2].finishedAt, START + 100, 'the old finish is still stored');
  assert.equal(p3.inRace, false);
  assert.equal(p3.finished, false);
});

test('a snapshot shows finished true for a racer who finished, and false for everyone in waiting', () => {
  const { room, players } = racingRoom(2);
  race.applyKeys(room, players[0], PASSAGE, START + 100);
  assert.equal(race.toSnapshot(room, START + 100).players[0].finished, true);
  race.endRace(room);
  assert.equal(race.toSnapshot(room, START + 200).players[0].finished, true, 'results still show the finish');
  race.markWaiting(room);
  assert.ok(race.toSnapshot(room, START + 300).players.every((p) => p.finished === false));
});

test('a snapshot never reports negative lobby time', () => {
  const { room } = roomWith(1);
  room.lobbyDeadline = 1000;
  assert.equal(race.toSnapshot(room, 5000).expiresInMs, 0);
});

test('a waiting snapshot without a lobby deadline has expiresInMs null', () => {
  const { room } = roomWith(1);
  assert.equal(race.toSnapshot(room, 0).expiresInMs, null);
});
