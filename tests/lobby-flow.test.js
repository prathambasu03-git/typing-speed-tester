'use strict';

/*
 * Milestone M2 flow tests: the room lobby, Start race, host changes,
 * sitting out, Race again, the lobby warning, copying the invite link and
 * entry errors. script.js runs in the fake DOM (tests/helpers/load-script.js)
 * with a fake Socket.io `io` (tests/helpers/mp-harness.js).
 * Run from the repo root with:  node --test tests/
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const MP = require('../multiplayer.js');
const {
  PAGES_HOST, PAGES_PATH, PASSAGE, flush, setupMp, P, room, result, createRoom, joinRoom, playRace,
} = require('./helpers/mp-harness.js');

const LINK = `https://${PAGES_HOST}${PAGES_PATH}#room=K7QM2X`;
const COPY_FALLBACK_TEXT = "The link is selected. Copy it with your device's copy command.";
const LOBBY_WARNING = 'No race has started, so this room closes in about 1 minute. Press Stay in room to keep it open.';
const copy = (value) => JSON.parse(JSON.stringify(value)); // vm objects -> plain objects
const trackNames = (app) => app.el('race-tracks').children.map((li) => li.children[0].textContent);

/* ---------- Create -> lobby -> second player -> Start -> countdown ---------- */

describe('creating a room', () => {
  it("sends room:create with {} on connect, with joinAckTimeoutMs", async () => {
    const app = setupMp();
    app.press('multi');
    app.click('create-room-btn');
    await flush();
    const socket = app.socket();
    socket.fire('connect');
    const create = socket.last('room:create');
    assert.deepEqual(copy(create.payload), {});
    assert.equal(create.timeoutMs, MP.MP_CONSTANTS.joinAckTimeoutMs);
    assert.equal(socket.count('room:join'), 0);
  });

  it("enters the lobby view (phase 'waiting') titled 'race room'", async () => {
    const app = setupMp();
    await createRoom(app);
    assert.equal(app.get('state.phase'), 'waiting');
    assert.equal(app.el('race-title').textContent, 'race room');
    assert.equal(app.el('mp-menu').hidden, true);
    assert.equal(app.el('room-info').hidden, false);
    assert.equal(app.el('room-actions').hidden, false);
  });

  it('shows the code, its spelled-out twin and the invite link', async () => {
    const app = setupMp();
    await createRoom(app);
    assert.equal(app.el('room-code').textContent, 'K7QM2X');
    assert.equal(app.el('room-code-spelled').textContent, 'Room code K 7 Q M 2 X');
    assert.equal(app.el('room-link').value, LINK);
  });

  it('puts the invite link in the address bar', async () => {
    const app = setupMp();
    await createRoom(app);
    assert.equal(app.history.calls.at(-1), LINK);
  });

  it('focuses Copy invite link', async () => {
    const app = setupMp();
    await createRoom(app);
    assert.equal(app.document.activeElement, app.el('copy-link-btn'));
  });

  it('announces the room, spelled out, once', async () => {
    const app = setupMp();
    app.press('multi');
    app.settle();
    app.click('create-room-btn');
    app.settle();
    await flush();
    const before = app.spoken.length;
    app.socket().fire('connect');
    app.socket().last('room:create').cb(null, { ok: true, playerId: 'a', room: room('waiting', [P('a', 1)], 'a') });
    app.settle();
    assert.deepEqual(app.spokenSince(before),
      ['Room K 7 Q M 2 X created. Share the invite link. You can start the race when another player joins.']);
  });

  it('shows Start race to the host, aria-disabled, with the "one more player" hint', async () => {
    const app = setupMp();
    await createRoom(app);
    const start = app.el('start-btn');
    assert.equal(start.hidden, false);
    assert.equal(start.getAttribute('aria-disabled'), 'true');
    assert.equal(start.disabled, false, 'aria-disabled, never disabled, so it stays focusable');
    assert.equal(start.textContent, 'Start race');
    assert.equal(app.el('start-hint').hidden, false);
    assert.equal(app.el('start-hint').textContent, 'Waiting for at least one more player.');
  });

  it("says 'Share the code or link so others can join.' while alone", async () => {
    const app = setupMp();
    await createRoom(app);
    assert.equal(app.el('race-status').textContent, 'Share the code or link so others can join.');
  });

  it('lists the host as "You (host)"', async () => {
    const app = setupMp();
    await createRoom(app);
    assert.deepEqual(trackNames(app), ['You (host)']);
  });

  it('pressing the disabled Start announces the hint and sends nothing', async () => {
    const app = setupMp();
    const socket = await createRoom(app);
    app.settle();
    const before = app.spoken.length;
    app.click('start-btn');
    app.settle();
    assert.deepEqual(app.spokenSince(before), ['Waiting for at least one more player.']);
    assert.equal(socket.count('room:start'), 0);
  });
});

describe('a second player joining the lobby', () => {
  async function hostWithTwo() {
    const app = setupMp();
    const socket = await createRoom(app);
    app.settle();
    const before = app.spoken.length;
    socket.fire('room:state', room('waiting', [P('a', 1), P('b', 2)], 'a'));
    app.settle();
    return { app, socket, said: app.spokenSince(before) };
  }

  it('enables Start race (no aria-disabled) and hides the hint', async () => {
    const { app } = await hostWithTwo();
    assert.equal(app.el('start-btn').getAttribute('aria-disabled'), null);
    assert.equal(app.el('start-hint').hidden, true);
    assert.equal(app.el('start-hint').textContent, '');
  });

  it('makes one announcement: "Player 2 joined the room. You can start the race now."', async () => {
    const { said } = await hostWithTwo();
    assert.deepEqual(said, ['Player 2 joined the room. You can start the race now.']);
  });

  it('says nothing for a repeat of the same snapshot', async () => {
    const { app, socket } = await hostWithTwo();
    const before = app.spoken.length;
    socket.fire('room:state', room('waiting', [P('a', 1), P('b', 2)], 'a'));
    app.settle();
    assert.deepEqual(app.spokenSince(before), []);
  });

  it('lists "You (host)" and "Player 2"', async () => {
    const { app } = await hostWithTwo();
    assert.deepEqual(trackNames(app), ['You (host)', 'Player 2']);
  });

  it('shows the player count in the status line', async () => {
    const { app } = await hostWithTwo();
    assert.equal(app.el('race-status').textContent, '2 of 4 players here. Press Start race when everyone is ready.');
  });

  it('does not move focus', async () => {
    const app = setupMp();
    const socket = await createRoom(app);
    app.el('leave-room-btn').focus();
    socket.fire('room:state', room('waiting', [P('a', 1), P('b', 2)], 'a'));
    assert.equal(app.document.activeElement, app.el('leave-room-btn'));
  });

  it('ignores an invalid snapshot (hostId not among the players)', async () => {
    const { app, socket } = await hostWithTwo();
    socket.fire('room:state', room('waiting', [P('a', 1)], 'zzz'));
    assert.deepEqual(trackNames(app), ['You (host)', 'Player 2']);
  });

  it('announces "Player 2 left the room." when they leave, and disables Start again', async () => {
    const { app, socket } = await hostWithTwo();
    const before = app.spoken.length;
    socket.fire('room:state', room('waiting', [P('a', 1)], 'a'));
    app.settle();
    assert.deepEqual(app.spokenSince(before), ['Player 2 left the room.']);
    assert.equal(app.el('start-btn').getAttribute('aria-disabled'), 'true');
  });
});

describe('the host starting the race', () => {
  async function started() {
    const app = setupMp();
    const socket = await createRoom(app);
    socket.fire('room:state', room('waiting', [P('a', 1), P('b', 2)], 'a'));
    app.click('start-btn');
    return { app, socket };
  }

  it('sends room:start with {} and ackTimeoutMs', async () => {
    const { socket } = await started();
    const start = socket.last('room:start');
    assert.deepEqual(copy(start.payload), {});
    assert.equal(start.timeoutMs, MP.MP_CONSTANTS.ackTimeoutMs);
  });

  it("shows 'Starting…', aria-disabled, while the ack is pending", async () => {
    const { app } = await started();
    assert.equal(app.el('start-btn').textContent, 'Starting…');
    assert.equal(app.el('start-btn').getAttribute('aria-disabled'), 'true');
  });

  it('sends only one room:start for a double press', async () => {
    const { app, socket } = await started();
    app.click('start-btn');
    assert.equal(socket.count('room:start'), 1);
  });

  it('enters the countdown on race:countdown, hides the room info and focuses the typing input', async () => {
    const { app, socket } = await started();
    socket.last('room:start').cb(null, { ok: true });
    socket.fire('room:state', room('countdown', [P('a', 1, { inRace: true }), P('b', 2, { inRace: true })], 'a'));
    socket.fire('race:countdown', { passage: PASSAGE, startsInMs: 3000, raceTimeLimitMs: 120000 });
    assert.equal(app.get('state.phase'), 'countdown');
    assert.equal(app.el('room-info').hidden, true);
    assert.equal(app.el('room-actions').hidden, true);
    assert.equal(app.el('typing-area').hidden, false);
    assert.equal(app.document.activeElement, app.el('hidden-input'));
  });

  it('says the race rule at the first countdown', async () => {
    const { app, socket } = await started();
    socket.last('room:start').cb(null, { ok: true });
    socket.fire('room:state', room('countdown', [P('a', 1, { inRace: true }), P('b', 2, { inRace: true })], 'a'));
    socket.fire('race:countdown', { passage: PASSAGE, startsInMs: 3000, raceTimeLimitMs: 120000 });
    const before = app.spoken.length;
    app.settle();
    assert.deepEqual(app.spokenSince(before), ['Race starting in 3 seconds. Fix every mistake to finish.']);
    assert.equal(app.get('state.mp.session.instructionsSpoken'), true);
  });

  it('shows and announces a failed start, and enables Start again', async () => {
    const { app, socket } = await started();
    app.settle();
    const before = app.spoken.length;
    socket.last('room:start').cb(null, { ok: false, error: { code: 'PLAYERS_NOT_READY' } });
    app.settle();
    const text = MP.errorMessage('PLAYERS_NOT_READY');
    assert.equal(app.el('race-status').textContent, text);
    assert.deepEqual(app.spokenSince(before), [text]);
    assert.equal(app.el('start-btn').textContent, 'Start race');
    assert.equal(app.get('state.mp.startRequested'), false);
  });

  it('gives the generic message when the start ack times out', async () => {
    const { app, socket } = await started();
    socket.last('room:start').cb(new Error('timeout'));
    assert.equal(app.el('race-status').textContent, MP.errorMessage('BAD_RESPONSE'));
  });
});

/* ---------- Joining, and entry errors ---------- */

describe('joining a room', () => {
  it('sends room:join with the normalised code', async () => {
    const app = setupMp();
    app.press('multi');
    app.submitJoin(' k7q-m2x ');
    await flush();
    app.socket().fire('connect');
    assert.deepEqual(copy(app.socket().last('room:join').payload), { code: 'K7QM2X' });
    assert.equal(app.socket().count('room:create'), 0);
  });

  it('focuses #race-title and announces the join once', async () => {
    const app = setupMp();
    app.press('multi');
    app.settle();
    app.submitJoin('K7QM2X');
    app.settle();
    await flush();
    const before = app.spoken.length;
    app.socket().fire('connect');
    app.socket().last('room:join').cb(null, { ok: true, playerId: 'b', room: room('waiting', [P('a', 1), P('b', 2)], 'a') });
    app.settle();
    assert.equal(app.document.activeElement, app.el('race-title'));
    assert.deepEqual(app.spokenSince(before), ['Joined room K 7 Q M 2 X. Waiting for the host to start the race.']);
  });

  it('hides Start race from a player who is not the host', async () => {
    const app = setupMp();
    await joinRoom(app, room('waiting', [P('a', 1), P('b', 2)], 'a'), 'b');
    assert.equal(app.el('start-btn').hidden, true);
    assert.equal(app.el('start-hint').hidden, true);
    assert.equal(app.el('race-status').textContent, 'Waiting for the host to start the race…');
    assert.deepEqual(trackNames(app), ['Player 1 (host)', 'You']);
  });

  it('tells a player who joins after a race that they race in the next one', async () => {
    const app = setupMp();
    app.press('multi');
    app.submitJoin('K7QM2X');
    await flush();
    app.socket().fire('connect');
    const finished = room('finished', [P('a', 1, { ready: false }), P('b', 2, { ready: false }), P('c', 3)], 'a');
    app.socket().last('room:join').cb(null, { ok: true, playerId: 'c', room: finished });
    const before = app.spoken.length;
    app.settle();
    assert.deepEqual(app.spokenSince(before),
      ['Joined room K 7 Q M 2 X. The others are on their results. You will race in the next one.']);
    assert.equal(app.el('race-status').textContent, 'Waiting for the host to start the next race…');
  });
});

describe('a join that fails with ROOM_FULL', () => {
  async function full() {
    const app = setupMp();
    app.press('multi');
    app.submitJoin('k7q-m2x');
    await flush();
    const socket = app.socket();
    socket.fire('connect');
    socket.last('room:join').cb(null, { ok: false, error: { code: 'ROOM_FULL', message: 'full' } });
    return { app, socket };
  }

  it("goes back to the menu, still in multiplayer", async () => {
    const { app } = await full();
    assert.equal(app.get('state.mode'), 'multi');
    assert.equal(app.get('state.phase'), 'menu');
    assert.equal(app.el('mp-menu').hidden, false);
  });
  it('shows the ROOM_FULL text inline under the code input', async () => {
    const { app } = await full();
    assert.equal(app.el('room-code-error').hidden, false);
    assert.equal(app.el('room-code-error').textContent,
      'That room is full (4 players). Ask the host for a new room or try another code.');
    assert.equal(app.el('room-code-input').getAttribute('aria-invalid'), 'true');
  });
  it('keeps the (normalised) code in the input', async () => {
    const { app } = await full();
    assert.equal(app.el('room-code-input').value, 'K7QM2X');
  });
  it('focuses the code input', async () => {
    const { app } = await full();
    assert.equal(app.document.activeElement, app.el('room-code-input'));
  });
  it('closes the socket and shows no #mp-error', async () => {
    const { app, socket } = await full();
    assert.equal(socket.disconnected, true);
    assert.equal(app.el('mp-error').hidden, true);
  });
  it('lets the user create a room right after', async () => {
    const { app } = await full();
    app.click('create-room-btn');
    assert.equal(app.get('state.phase'), 'connecting');
    assert.deepEqual(copy(app.get('state.mp.intent')), { type: 'create' });
  });
});

describe('other entry errors', () => {
  for (const code of ['BAD_CODE', 'ROOM_NOT_FOUND', 'RACE_IN_PROGRESS']) {
    it(`shows ${code} inline under the code input and stays in the menu`, async () => {
      const app = setupMp();
      app.press('multi');
      app.submitJoin('K7QM2X');
      await flush();
      app.socket().fire('connect');
      app.socket().last('room:join').cb(null, { ok: false, error: { code } });
      assert.equal(app.get('state.phase'), 'menu');
      assert.equal(app.el('room-code-error').textContent, MP.errorMessage(code));
      assert.equal(app.el('room-code-input').value, 'K7QM2X');
    });
  }

  it('shows TOO_MANY_ROOMS on create in #menu-error and focuses Create', async () => {
    const app = setupMp();
    app.press('multi');
    app.click('create-room-btn');
    await flush();
    app.socket().fire('connect');
    app.socket().last('room:create').cb(null, { ok: false, error: { code: 'TOO_MANY_ROOMS' } });
    assert.equal(app.get('state.phase'), 'menu');
    assert.equal(app.el('menu-error').hidden, false);
    assert.equal(app.el('menu-error').textContent, MP.errorMessage('TOO_MANY_ROOMS'));
    assert.equal(app.el('room-code-error').hidden, true);
    assert.equal(app.document.activeElement, app.el('create-room-btn'));
  });

  it('shows RATE_LIMITED on a join under the code input', async () => {
    const app = setupMp();
    app.press('multi');
    app.submitJoin('K7QM2X');
    await flush();
    app.socket().fire('connect');
    app.socket().last('room:join').cb(null, { ok: false, error: { code: 'RATE_LIMITED' } });
    assert.equal(app.el('room-code-error').textContent, MP.errorMessage('RATE_LIMITED'));
  });

  it('ends multiplayer for any other failure code', async () => {
    const app = setupMp();
    app.press('multi');
    app.click('create-room-btn');
    await flush();
    app.socket().fire('connect');
    app.socket().last('room:create').cb(null, { ok: false, error: { code: 'BAD_PAYLOAD' } });
    assert.equal(app.get('state.mode'), 'solo');
    assert.equal(app.el('mp-error').hidden, false);
  });

  it('ends multiplayer for an ack whose room fails validation', async () => {
    const app = setupMp();
    app.press('multi');
    app.click('create-room-btn');
    await flush();
    app.socket().fire('connect');
    app.socket().last('room:create').cb(null, { ok: true, playerId: 'a', room: room('waiting', [P('a', 1)], 'a', { code: 'bad' }) });
    assert.equal(app.get('state.mode'), 'solo');
  });
});

/* ---------- Host changes ---------- */

describe('a host change in the lobby', () => {
  // a (slot 1) hosts; b (slot 2) and c (slot 3) are in. a leaves; b is next.
  const three = () => room('waiting', [P('a', 1), P('b', 2), P('c', 3)], 'a');
  const afterLeave = () => room('waiting', [P('b', 2), P('c', 3)], 'b');

  async function asPlayer(id) {
    const app = setupMp();
    const socket = await joinRoom(app, three(), id);
    app.settle();
    app.el('leave-room-btn').focus();
    const before = app.spoken.length;
    socket.fire('room:state', afterLeave());
    app.settle();
    return { app, socket, said: app.spokenSince(before) };
  }

  it('tells the new host in one announcement that the old host left and they can start', async () => {
    const { said } = await asPlayer('b');
    assert.deepEqual(said, ['Player 1 left the room. You are now the host. You can start the race.']);
  });
  it('tells the others who the new host is', async () => {
    const { said } = await asPlayer('c');
    assert.deepEqual(said, ['Player 1 left the room. Player 2 is now the host.']);
  });
  it('does not move focus for the new host', async () => {
    const { app } = await asPlayer('b');
    assert.equal(app.document.activeElement, app.el('leave-room-btn'));
  });
  it('does not move focus for the others', async () => {
    const { app } = await asPlayer('c');
    assert.equal(app.document.activeElement, app.el('leave-room-btn'));
  });
  it('shows the new host an enabled Start race', async () => {
    const { app } = await asPlayer('b');
    assert.equal(app.el('start-btn').hidden, false);
    assert.equal(app.el('start-btn').getAttribute('aria-disabled'), null);
  });
  it('moves "(host)" on the tracks', async () => {
    const { app } = await asPlayer('c');
    assert.deepEqual(trackNames(app), ['Player 2 (host)', 'You']);
  });
  it('tells a new host left alone to wait for one more player', async () => {
    const app = setupMp();
    const socket = await joinRoom(app, room('waiting', [P('a', 1), P('b', 2)], 'a'), 'b');
    app.settle();
    const before = app.spoken.length;
    socket.fire('room:state', room('waiting', [P('b', 2)], 'b'));
    app.settle();
    assert.deepEqual(app.spokenSince(before),
      ['Player 1 left the room. You are now the host. Waiting for at least one more player.']);
    assert.equal(app.el('solo-tip').hidden, false);
  });
});

describe('a host change during the race', () => {
  it('tells only the new host, with no next step, and moves "(host)"', async () => {
    const app = setupMp();
    const socket = await joinRoom(app, room('waiting', [P('a', 1), P('b', 2), P('c', 3)], 'a'), 'b');
    const racers = (hostId, aConnected = true) => room('racing', [
      P('a', 1, { inRace: true, connected: aConnected }), P('b', 2, { inRace: true }), P('c', 3, { inRace: true }),
    ], hostId);
    socket.fire('room:state', room('countdown', [P('a', 1, { inRace: true }), P('b', 2, { inRace: true }), P('c', 3, { inRace: true })], 'a'));
    socket.fire('race:countdown', { passage: PASSAGE, startsInMs: 3000, raceTimeLimitMs: 120000 });
    socket.fire('room:state', racers('a'));
    socket.fire('race:start', { raceTimeLimitMs: 120000 });
    app.settle();
    const before = app.spoken.length;
    socket.fire('room:state', racers('b', false));
    app.settle();
    assert.deepEqual(app.spokenSince(before), ['Player 1 left the race. You are now the host.']);
    assert.deepEqual(trackNames(app), ['Player 1', 'You (host)', 'Player 3']);
  });
});

/* ---------- Sitting out, Race again ---------- */

describe('sitting out a race the host started without you', () => {
  // a hosts; a and b pressed Race again and a started; c was on the results.
  async function satOut() {
    const app = setupMp();
    const socket = await joinRoom(app, room('waiting', [P('a', 1), P('b', 2), P('c', 3)], 'a'), 'c');
    playRace(app, socket, ['a', 'b', 'c'], 'a');
    app.settle();
    assert.equal(app.get('state.phase'), 'finished');
    app.el('restart-btn').focus(); // focus on Race again, inside the results card
    const before = app.spoken.length;
    socket.fire('room:state', room('countdown', [
      P('a', 1, { inRace: true, ready: false }), P('b', 2, { inRace: true, ready: false }), P('c', 3, { ready: false }),
    ], 'a'));
    return { app, socket, before };
  }

  it("moves to the lobby view (phase 'waiting') and hides the results", async () => {
    const { app } = await satOut();
    assert.equal(app.get('state.phase'), 'waiting');
    assert.equal(app.el('results').hidden, true);
    assert.equal(app.el('room-info').hidden, false);
  });
  it('focuses #race-title, since focus was in the results card', async () => {
    const { app } = await satOut();
    assert.equal(app.document.activeElement, app.el('race-title'));
  });
  it('announces SIT_OUT_MESSAGE once and shows it in the status line', async () => {
    const { app, before } = await satOut();
    app.settle();
    assert.deepEqual(app.spokenSince(before), [MP.SIT_OUT_MESSAGE]);
    assert.equal(app.el('race-status').textContent, MP.SIT_OUT_MESSAGE);
  });
  it('lists everyone with where they are', async () => {
    const { app } = await satOut();
    assert.deepEqual(trackNames(app), ['Player 1 (host)', 'Player 2', 'You']);
    const metas = app.el('race-tracks').children.map((li) => li.children[2].textContent);
    assert.deepEqual(metas, ['racing', 'racing', 'sitting out']);
  });
  it('ignores race:countdown, race:start, race:update, player:finish and race:end', async () => {
    const { app, socket } = await satOut();
    socket.fire('race:countdown', { passage: PASSAGE, startsInMs: 3000, raceTimeLimitMs: 120000 });
    assert.equal(app.get('state.phase'), 'waiting');
    socket.fire('room:state', room('racing', [
      P('a', 1, { inRace: true, ready: false }), P('b', 2, { inRace: true, ready: false }), P('c', 3, { ready: false }),
    ], 'a'));
    socket.fire('race:start', { raceTimeLimitMs: 120000 });
    socket.fire('race:update', { elapsedMs: 1000, players: [] });
    socket.fire('player:finish', { id: 'a', place: 1, timeMs: 9000, wpm: 80, accuracy: 99 });
    socket.fire('race:end', { reason: 'all_finished', results: [result('a', 1, 1), result('b', 2, 2)] });
    assert.equal(app.get('state.phase'), 'waiting');
    assert.equal(app.el('typing-area').hidden, true);
    assert.equal(app.el('results').hidden, true);
    assert.equal(app.el('race-status').textContent, MP.SIT_OUT_MESSAGE);
  });
  it('drops a late race:rematch failure', async () => {
    const app = setupMp();
    const socket = await joinRoom(app, room('waiting', [P('a', 1), P('b', 2), P('c', 3)], 'a'), 'c');
    playRace(app, socket, ['a', 'b', 'c'], 'a');
    app.click('restart-btn'); // Race again, ack pending
    socket.fire('room:state', room('countdown', [
      P('a', 1, { inRace: true, ready: false }), P('b', 2, { inRace: true, ready: false }), P('c', 3, { ready: false }),
    ], 'a'));
    socket.last('race:rematch').cb(null, { ok: false, error: { code: 'NOT_FINISHED' } });
    assert.equal(app.get('state.phase'), 'waiting');
    assert.equal(app.el('race-status').textContent, MP.SIT_OUT_MESSAGE);
  });
  it('races in the next one: back to waiting, then a countdown with inRace true', async () => {
    const { app, socket } = await satOut();
    socket.fire('room:state', room('finished', [
      P('a', 1, { inRace: true, ready: false }), P('b', 2, { inRace: true, ready: false }), P('c', 3, { ready: true }),
    ], 'a'));
    assert.equal(app.get('state.phase'), 'waiting');
    socket.fire('room:state', room('countdown', [
      P('a', 1, { inRace: true }), P('b', 2, { inRace: true }), P('c', 3, { inRace: true }),
    ], 'a'));
    socket.fire('race:countdown', { passage: PASSAGE, startsInMs: 3000, raceTimeLimitMs: 120000 });
    assert.equal(app.get('state.phase'), 'countdown');
  });
});

describe('Race again', () => {
  async function onResults(selfId) {
    const app = setupMp();
    const socket = selfId === 'a'
      ? await createRoom(app, room('waiting', [P('a', 1), P('b', 2)], 'a'))
      : await joinRoom(app, room('waiting', [P('a', 1), P('b', 2)], 'a'), 'b');
    playRace(app, socket, ['a', 'b'], 'a');
    app.settle();
    app.el('restart-btn').focus();
    return { app, socket };
  }

  it('sends race:rematch with ackTimeoutMs', async () => {
    const { app, socket } = await onResults('a');
    app.click('restart-btn');
    assert.equal(socket.last('race:rematch').timeoutMs, MP.MP_CONSTANTS.ackTimeoutMs);
  });
  it('moves the host to the lobby view, focuses #race-title, and says why Start waits', async () => {
    const { app, socket } = await onResults('a');
    app.click('restart-btn');
    const before = app.spoken.length;
    socket.last('race:rematch').cb(null, {
      ok: true, room: room('finished', [P('a', 1, { inRace: true }), P('b', 2, { inRace: true, ready: false })], 'a'),
    });
    app.settle();
    assert.equal(app.get('state.phase'), 'waiting');
    assert.equal(app.el('results').hidden, true);
    assert.equal(app.el('room-info').hidden, false);
    assert.equal(app.document.activeElement, app.el('race-title'));
    assert.deepEqual(app.spokenSince(before), ['Back in the room. Waiting for at least one more player to press Race again.']);
    assert.equal(app.el('start-btn').getAttribute('aria-disabled'), 'true');
  });
  it('tells the host they can start when the other player is already back', async () => {
    const { app, socket } = await onResults('a');
    app.click('restart-btn');
    const before = app.spoken.length;
    socket.last('race:rematch').cb(null, {
      ok: true, room: room('finished', [P('a', 1, { inRace: true }), P('b', 2, { inRace: true })], 'a'),
    });
    app.settle();
    assert.deepEqual(app.spokenSince(before), ['Back in the room. You can start the race.']);
    assert.equal(app.el('start-btn').getAttribute('aria-disabled'), null);
  });
  it('tells a non-host to wait for the host', async () => {
    const { app, socket } = await onResults('b');
    app.click('restart-btn');
    const before = app.spoken.length;
    socket.last('race:rematch').cb(null, {
      ok: true, room: room('finished', [P('a', 1, { inRace: true, ready: false }), P('b', 2, { inRace: true })], 'a'),
    });
    app.settle();
    assert.deepEqual(app.spokenSince(before), ['Back in the room. Waiting for the host to start.']);
    assert.equal(app.el('race-status').textContent, 'Waiting for the host to start the next race…');
  });
  it("shows the host the 'back in the room' count in the status line", async () => {
    const { app, socket } = await onResults('a');
    app.click('restart-btn');
    socket.last('race:rematch').cb(null, {
      ok: true, room: room('finished', [P('a', 1, { inRace: true }), P('b', 2, { inRace: true, ready: false })], 'a'),
    });
    assert.equal(app.el('race-status').textContent,
      '1 of 2 players are back in the room. Players still on their results will join the next race.');
  });
});

/* ---------- The lobby warning and Stay in room ---------- */

describe('the lobby warning', () => {
  const warnAt = 600000 - MP.MP_CONSTANTS.lobbyWarningMs - MP.MP_CONSTANTS.lobbyWarningMarginMs;

  it('does not show before lobbyDeadline - lobbyWarningMs - lobbyWarningMarginMs', async () => {
    const app = setupMp();
    await createRoom(app);
    app.clock.advance(warnAt - 1);
    assert.equal(app.el('extend-btn').hidden, true);
    assert.ok(!app.spoken.includes(LOBBY_WARNING));
  });

  it('shows Stay in room and appends LOBBY_WARNING to the status line at that time', async () => {
    const app = setupMp();
    await createRoom(app);
    app.clock.advance(warnAt);
    assert.equal(app.el('extend-btn').hidden, false);
    assert.equal(app.el('race-status').textContent, `Share the code or link so others can join. ${LOBBY_WARNING}`);
  });

  it('announces the warning exactly once', async () => {
    const app = setupMp();
    await createRoom(app);
    app.clock.advance(warnAt + 50000);
    assert.equal(app.spoken.filter((t) => t === LOBBY_WARNING).length, 1);
  });

  it('is rescheduled by a join, which restarts the server timer', async () => {
    const app = setupMp();
    const socket = await createRoom(app);
    app.clock.advance(300000);
    socket.fire('room:state', room('waiting', [P('a', 1), P('b', 2)], 'a')); // expiresInMs 600000 again
    app.clock.advance(warnAt - 300000 + 1000);
    assert.equal(app.el('extend-btn').hidden, true, 'the old deadline no longer applies');
    app.clock.advance(300000);
    assert.equal(app.el('extend-btn').hidden, false);
  });

  it('stays up, with no second announcement, for a snapshot of the same deadline (latency jitter)', async () => {
    const app = setupMp();
    const socket = await createRoom(app);
    app.clock.advance(warnAt);
    app.settle();
    // A ready change: same server deadline, seen 1 s "earlier" or "later" by latency.
    const remaining = 600000 - warnAt - app.get('CONFIG.resultAnnounceDelayMs') - 20;
    socket.fire('room:state', room('waiting', [P('a', 1)], 'a', { expiresInMs: remaining - 1000 }));
    socket.fire('room:state', room('waiting', [P('a', 1)], 'a', { expiresInMs: remaining + 1000 }));
    app.settle();
    assert.equal(app.el('extend-btn').hidden, false);
    assert.equal(app.spoken.filter((t) => t === LOBBY_WARNING).length, 1);
  });

  it('is not scheduled when the snapshot has no lobby timer (expiresInMs null)', async () => {
    const app = setupMp();
    await createRoom(app, room('waiting', [P('a', 1)], 'a', { expiresInMs: null }));
    app.clock.advance(3600000);
    assert.equal(app.el('extend-btn').hidden, true);
  });
});

describe('Stay in room', () => {
  async function warned() {
    const app = setupMp();
    const socket = await createRoom(app);
    app.clock.advance(600000 - 63000);
    app.settle(); // the warning is announced on the next frame
    app.el('extend-btn').focus();
    app.click('extend-btn');
    return { app, socket };
  }

  it('sends room:extend with ackTimeoutMs and marks the button aria-disabled', async () => {
    const { app, socket } = await warned();
    const extend = socket.last('room:extend');
    assert.deepEqual(copy(extend.payload), {});
    assert.equal(extend.timeoutMs, MP.MP_CONSTANTS.ackTimeoutMs);
    assert.equal(app.el('extend-btn').getAttribute('aria-disabled'), 'true');
  });
  it('sends one room:extend for a double press', async () => {
    const { app, socket } = await warned();
    app.click('extend-btn');
    assert.equal(socket.count('room:extend'), 1);
  });
  it('on success hides the warning, moves focus off the hidden button and announces the minutes', async () => {
    const { app, socket } = await warned();
    const before = app.spoken.length;
    socket.last('room:extend').cb(null, { ok: true, room: room('waiting', [P('a', 1)], 'a') });
    app.settle();
    assert.equal(app.el('extend-btn').hidden, true);
    assert.equal(app.document.activeElement, app.el('race-title'));
    assert.equal(app.el('race-status').textContent, 'Share the code or link so others can join.');
    assert.deepEqual(app.spokenSince(before), ['The room stays open for 10 more minutes.']);
  });
  it('warns again before the new deadline', async () => {
    const { app, socket } = await warned();
    socket.last('room:extend').cb(null, { ok: true, room: room('waiting', [P('a', 1)], 'a') });
    app.clock.advance(600000 - 63000);
    assert.equal(app.el('extend-btn').hidden, false);
  });
  it('on failure keeps the button and shows and announces the error', async () => {
    const { app, socket } = await warned();
    app.settle();
    const before = app.spoken.length;
    socket.last('room:extend').cb(null, { ok: false, error: { code: 'NOT_WAITING' } });
    app.settle();
    assert.equal(app.el('extend-btn').hidden, false);
    assert.equal(app.el('extend-btn').getAttribute('aria-disabled'), null);
    assert.match(app.el('race-status').textContent, /^The room is not waiting for a race\./);
    assert.deepEqual(app.spokenSince(before), [MP.errorMessage('NOT_WAITING')]);
  });
});

describe('the room closing (ROOM_EXPIRED)', () => {
  async function expired() {
    const app = setupMp();
    const socket = await createRoom(app);
    socket.fire('game:error', { code: 'ROOM_EXPIRED', message: 'closed' });
    socket.fire('disconnect');
    return { app, socket };
  }
  it('goes back to solo', async () => {
    const { app } = await expired();
    assert.equal(app.get('state.mode'), 'solo');
    assert.equal(app.el('race-panel').hidden, true);
  });
  it('shows the ROOM_EXPIRED text in #mp-error', async () => {
    const { app } = await expired();
    assert.equal(app.el('mp-error').hidden, false);
    assert.equal(app.el('mp-error').textContent, MP.errorMessage('ROOM_EXPIRED'));
  });
  it('removes the room hash from the address bar', async () => {
    const { app } = await expired();
    assert.equal(app.window.location.hash, '');
    assert.equal(app.history.calls.at(-1), PAGES_PATH);
  });
  it('says DISCONNECTED for a drop with no game:error before it', async () => {
    const app = setupMp();
    const socket = await createRoom(app);
    socket.fire('disconnect');
    assert.equal(app.el('mp-error').textContent, MP.errorMessage('DISCONNECTED'));
  });
});

describe('Leave room', () => {
  it('returns to the menu, focuses Create, drops the hash and announces it once', async () => {
    const app = setupMp();
    const socket = await createRoom(app);
    app.settle();
    const before = app.spoken.length;
    app.click('leave-room-btn');
    app.settle();
    assert.equal(app.get('state.mode'), 'multi');
    assert.equal(app.get('state.phase'), 'menu');
    assert.equal(socket.disconnected, true);
    assert.equal(app.document.activeElement, app.el('create-room-btn'));
    assert.equal(app.window.location.hash, '');
    assert.deepEqual(app.spokenSince(before), ['You left the room.']);
  });
});

/* ---------- Copy invite link ---------- */

describe('Copy invite link', () => {
  it('writes the link with the clipboard API and reports it', async () => {
    const written = [];
    const app = setupMp({ navigator: { clipboard: { writeText: async (text) => { written.push(text); } } } });
    await createRoom(app);
    app.settle();
    const before = app.spoken.length;
    app.click('copy-link-btn');
    await flush();
    app.settle();
    assert.deepEqual(written, [LINK]);
    assert.equal(app.el('copy-status').textContent, 'Invite link copied.');
    assert.deepEqual(app.spokenSince(before), ['Invite link copied.']);
    assert.equal(app.document.activeElement, app.el('copy-link-btn'), 'focus stays on the button');
  });

  it('falls back to selecting the field when there is no clipboard API', async () => {
    const app = setupMp();
    await createRoom(app);
    app.settle();
    const before = app.spoken.length;
    app.click('copy-link-btn');
    app.settle();
    assert.equal(app.document.activeElement, app.el('room-link'));
    assert.equal(app.el('room-link').selected, true);
    assert.equal(app.el('copy-status').textContent, COPY_FALLBACK_TEXT);
    assert.deepEqual(app.spokenSince(before), [COPY_FALLBACK_TEXT]);
  });

  it('falls back when the clipboard write is refused', async () => {
    const app = setupMp({ navigator: { clipboard: { writeText: () => Promise.reject(new Error('denied')) } } });
    await createRoom(app);
    app.click('copy-link-btn');
    await flush();
    assert.equal(app.el('room-link').selected, true);
    assert.equal(app.el('copy-status').textContent, COPY_FALLBACK_TEXT);
  });

  it('falls back without calling the clipboard on an insecure page', async () => {
    let calls = 0;
    const app = setupMp({
      isSecureContext: false,
      navigator: { clipboard: { writeText: async () => { calls += 1; } } },
    });
    await createRoom(app);
    app.click('copy-link-btn');
    await flush();
    assert.equal(calls, 0);
    assert.equal(app.el('room-link').selected, true);
  });

  it('announces the same result again on a second press', async () => {
    const app = setupMp();
    await createRoom(app);
    app.click('copy-link-btn');
    app.settle();
    const before = app.spoken.length;
    app.click('copy-link-btn');
    app.settle();
    assert.deepEqual(app.spokenSince(before), [COPY_FALLBACK_TEXT]);
  });
});

/* ---------- The solo tip ---------- */

describe('#solo-tip', () => {
  it('shows SOLO_TIP while the host is alone in a waiting room', async () => {
    const app = setupMp();
    await createRoom(app);
    assert.equal(app.el('solo-tip').hidden, false);
    assert.equal(app.el('solo-tip').textContent, MP.SOLO_TIP);
  });
  it('hides once a second player joins', async () => {
    const app = setupMp();
    const socket = await createRoom(app);
    socket.fire('room:state', room('waiting', [P('a', 1), P('b', 2)], 'a'));
    assert.equal(app.el('solo-tip').hidden, true);
  });
  it('shows again when the other player leaves', async () => {
    const app = setupMp();
    const socket = await createRoom(app);
    socket.fire('room:state', room('waiting', [P('a', 1), P('b', 2)], 'a'));
    socket.fire('room:state', room('waiting', [P('a', 1)], 'a'));
    assert.equal(app.el('solo-tip').hidden, false);
  });
  it('stays hidden in the lobby view of a finished room, even alone', async () => {
    const app = setupMp();
    const socket = await createRoom(app, room('waiting', [P('a', 1), P('b', 2)], 'a'));
    playRace(app, socket, ['a', 'b'], 'a');
    app.click('restart-btn');
    socket.last('race:rematch').cb(null, { ok: true, room: room('finished', [P('a', 1, { inRace: true })], 'a') });
    assert.equal(app.get('state.phase'), 'waiting');
    assert.equal(app.el('solo-tip').hidden, true);
  });
  it('is never written to #announcer', async () => {
    const app = setupMp();
    const socket = await createRoom(app);
    socket.fire('room:state', room('waiting', [P('a', 1), P('b', 2)], 'a'));
    socket.fire('room:state', room('waiting', [P('a', 1)], 'a'));
    app.settle();
    assert.ok(!app.spoken.some((t) => t.includes(MP.SOLO_TIP)));
  });
});
