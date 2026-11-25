'use strict';

/* Pure room state machine and scoring (server/src/race.js). Fake `now`
   values, fixed passage 'ab cd', no sockets and no timers. */

const test = require('node:test');
const assert = require('node:assert/strict');
const race = require('../src/race');
const { COUNTDOWN_MS } = require('../src/constants');

const PASSAGE = 'ab cd';
const START = 10_000;

/** A room with `count` joined players (socket ids s1, s2, ...). */
function roomWith(count, { maxPlayers = 2, minPlayers = 2 } = {}) {
  const room = race.createRoom('main', { maxPlayers, minPlayers });
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

test('a new room is waiting with no players and no passage', () => {
  const room = race.createRoom('main', { maxPlayers: 2, minPlayers: 2 });
  assert.equal(room.id, 'main');
  assert.equal(room.phase, 'waiting');
  assert.deepEqual(room.players, []);
  assert.equal(room.passage, null);
  assert.equal(room.startAt, null);
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

/* ---------- shouldStartCountdown ---------- */

test('two ready players in waiting start a countdown', () => {
  const { room } = roomWith(2);
  assert.equal(race.shouldStartCountdown(room), 'countdown');
});

test('one ready player in waiting stays waiting', () => {
  const { room } = roomWith(1);
  assert.equal(race.shouldStartCountdown(room), null);
});

test('one ready player in finished moves the room to waiting', () => {
  const { room } = roomWith(1);
  room.phase = 'finished';
  assert.equal(race.shouldStartCountdown(room), 'waiting');
});

test('two players with one not ready in finished stay finished', () => {
  const { room, players } = roomWith(2);
  room.phase = 'finished';
  players[1].ready = false;
  assert.equal(race.shouldStartCountdown(room), null);
});

test('two ready players in finished start a rematch countdown', () => {
  const { room } = roomWith(2);
  room.phase = 'finished';
  assert.equal(race.shouldStartCountdown(room), 'countdown');
});

test('the start check does nothing during a countdown or a race', () => {
  const { room } = roomWith(2);
  room.phase = 'countdown';
  assert.equal(race.shouldStartCountdown(room), null);
  room.phase = 'racing';
  assert.equal(race.shouldStartCountdown(room), null);
});

test('an empty finished room does not move to waiting', () => {
  const room = race.createRoom('main', { maxPlayers: 2, minPlayers: 2 });
  room.phase = 'finished';
  assert.equal(race.shouldStartCountdown(room), null);
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

test('beginCountdown resets every race field left over from the previous race', () => {
  const { room, players } = racingRoom();
  race.applyKeys(room, players[0], 'ab cd', START + 100);
  race.applyKeys(room, players[1], 'x', START + 100);
  players[1].lastSeq = 7;
  race.endRace(room);
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

test('cancelCountdown returns the room to waiting and drops the passage', () => {
  const { room } = roomWith(2);
  race.beginCountdown(room, PASSAGE, 0, 3000);
  race.cancelCountdown(room);
  assert.equal(room.phase, 'waiting');
  assert.equal(room.passage, null);
  assert.equal(room.startAt, null);
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

test('a snapshot lists players by slot and never includes socket ids', () => {
  const { room } = roomWith(2);
  race.removePlayer(room, 's1', 0);
  race.addPlayer(room, { id: 'p3', socketId: 's3' });
  const snapshot = race.toSnapshot(room);
  assert.deepEqual(snapshot, {
    phase: 'waiting',
    maxPlayers: 2,
    players: [
      { id: 'p3', slot: 1, connected: true, ready: true, finished: false },
      { id: 'p2', slot: 2, connected: true, ready: true, finished: false },
    ],
  });
  assert.ok(!JSON.stringify(snapshot).includes('s3'));
});
