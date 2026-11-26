'use strict';

/*
 * Milestone M2, round-3 fixes: no "The room stays open." when the race
 * starts, the ghost racer (a timed-out Race again ack), a lobby deadline that
 * moves earlier, a dead invite cleared from the address bar, the
 * aria-disabled button styles, and isInteractiveTarget with no global
 * Element. script.js runs in the fake DOM (tests/helpers/load-script.js) with
 * a fake Socket.io `io` (tests/helpers/mp-harness.js).
 * Run from the repo root with:  node --test tests/
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const MP = require('../multiplayer.js');
const { loadApp } = require('./helpers/load-script.js');
const {
  PAGES_PATH, PASSAGE, flush, setupMp, P, room, createRoom, joinRoom, playRace,
} = require('./helpers/mp-harness.js');

const LOBBY_WARNING = 'No race has started, so this room closes in about 1 minute. Press Stay in room to keep it open.';
const { ackTimeoutMs, lobbyWarningMs, lobbyWarningMarginMs, progressIntervalMs } = MP.MP_CONSTANTS;
/** Time after creation (expiresInMs 600000) at which the warning shows. */
const WARN_AT = 600000 - lobbyWarningMs - lobbyWarningMarginMs;
const COUNTDOWN = { passage: PASSAGE, startsInMs: 3000, raceTimeLimitMs: 120000 };
const count = (list, text) => list.filter((t) => t === text).length;

/* ---------- 1. "The room stays open." is not said when the race starts ---------- */

describe('the lobby warning when the race starts', () => {
  /** Host with two players, the warning showing, Start pressed and acked. */
  async function startedWhileWarned() {
    const app = setupMp();
    const socket = await createRoom(app, room('waiting', [P('a', 1), P('b', 2)], 'a'));
    app.clock.advance(WARN_AT + 50);
    app.settle();
    assert.equal(app.el('extend-btn').hidden, false, 'precondition: the warning shows');
    app.el('start-btn').focus();
    app.click('start-btn');
    socket.last('room:start').cb(null, { ok: true });
    const before = app.spoken.length;
    socket.fire('room:state', room('countdown', [P('a', 1, { inRace: true }), P('b', 2, { inRace: true })], 'a'));
    return { app, socket, before };
  }

  it("does not speak 'stays open' for a countdown snapshot with expiresInMs null", async () => {
    const { app, before } = await startedWhileWarned();
    app.settle();
    assert.ok(!app.spokenSince(before).some((t) => /stays open/.test(t)), app.spokenSince(before).join(' | '));
  });

  it("does not leave 'stays open' in a pending announcement either", async () => {
    const { app } = await startedWhileWarned();
    assert.doesNotMatch(app.get('pendingAnnouncement'), /stays open/);
  });

  it("says 'Race starting…' from race:countdown, with no 'stays open' merged in", async () => {
    const { app, socket, before } = await startedWhileWarned();
    socket.fire('race:countdown', COUNTDOWN);
    app.settle();
    const said = app.spokenSince(before);
    assert.ok(said.some((t) => /^Race starting in 3 seconds\./.test(t)), said.join(' | '));
    assert.ok(!said.some((t) => /stays open/.test(t)), said.join(' | '));
  });

  it("does say 'The room stays open.' when another player's join moves the deadline later", async () => {
    const app = setupMp();
    const socket = await createRoom(app);
    app.clock.advance(WARN_AT + 50);
    app.settle();
    const before = app.spoken.length;
    socket.fire('room:state', room('waiting', [P('a', 1), P('b', 2)], 'a')); // expiresInMs 600000 again
    app.settle();
    assert.equal(app.el('extend-btn').hidden, true);
    assert.deepEqual(app.spokenSince(before),
      ['Player 2 joined the room. The room stays open. You can start the race now.']);
  });

  it("does say 'The room stays open.' when another player's Stay in room moves the deadline later", async () => {
    const app = setupMp();
    const socket = await createRoom(app, room('waiting', [P('a', 1), P('b', 2)], 'a'));
    app.clock.advance(WARN_AT + 50);
    app.settle();
    const before = app.spoken.length;
    socket.fire('room:state', room('waiting', [P('a', 1), P('b', 2)], 'a')); // b extended
    app.settle();
    assert.equal(app.el('extend-btn').hidden, true);
    assert.deepEqual(app.spokenSince(before), ['The room stays open.']);
  });
});

/* ---------- 2. The ghost racer: a timed-out Race again ack ---------- */

describe('a Race again whose ack times out', () => {
  /** Player b on the results of a two-player race, Race again pressed, ack timed out. */
  async function timedOut() {
    const app = setupMp();
    const socket = await joinRoom(app, room('waiting', [P('a', 1), P('b', 2)], 'a'), 'b');
    playRace(app, socket, ['a', 'b'], 'a');
    app.settle();
    app.el('restart-btn').focus();
    app.click('restart-btn');
    const rematch = socket.last('race:rematch');
    assert.equal(rematch.timeoutMs, ackTimeoutMs);
    rematch.cb(new Error('operation has timed out'));
    app.settle();
    assert.equal(app.get('state.phase'), 'finished', 'precondition: still on the results');
    app.el('restart-btn').focus();
    return { app, socket, rematch, before: app.spoken.length };
  }

  const readyRoom = () => room('finished', [P('a', 1, { inRace: true, ready: false }), P('b', 2, { inRace: true, ready: true })], 'a');
  const seatedRoom = (bInRace) => room('countdown', [
    P('a', 1, { inRace: true, ready: false }), P('b', 2, { inRace: bInRace, ready: false }),
  ], 'a');

  describe("then room:state 'finished' with this player ready", () => {
    it("enters the lobby view (phase 'waiting') and hides the results", async () => {
      const { app, socket } = await timedOut();
      socket.fire('room:state', readyRoom());
      assert.equal(app.get('state.phase'), 'waiting');
      assert.equal(app.el('results').hidden, true);
      assert.equal(app.el('room-info').hidden, false);
    });

    it('focuses #race-title', async () => {
      const { app, socket } = await timedOut();
      socket.fire('room:state', readyRoom());
      assert.equal(app.document.activeElement, app.el('race-title'));
    });

    it("announces 'Back in the room…' exactly once", async () => {
      const { app, socket, before } = await timedOut();
      socket.fire('room:state', readyRoom());
      app.settle();
      assert.deepEqual(app.spokenSince(before), ['Back in the room. Waiting for the host to start.']);
    });

    it('ignores a late real ack: no new state and nothing said', async () => {
      const { app, socket, rematch } = await timedOut();
      socket.fire('room:state', readyRoom());
      app.settle();
      const stateBefore = app.get('state');
      const spokenBefore = app.spoken.length;
      rematch.cb(null, { ok: true, room: readyRoom() });
      app.settle();
      assert.equal(app.get('state'), stateBefore);
      assert.equal(app.get('state.phase'), 'waiting');
      assert.deepEqual(app.spokenSince(spokenBefore), []);
    });
  });

  describe("then room:state 'countdown' with this player inRace", () => {
    it('announces nothing for that room:state and stays on the results until race:countdown', async () => {
      const { app, socket, before } = await timedOut();
      socket.fire('room:state', seatedRoom(true));
      app.settle();
      assert.deepEqual(app.spokenSince(before), []);
      assert.equal(app.get('state.phase'), 'finished');
    });

    it('starts the countdown on race:countdown with the results hidden and focus on the typing input', async () => {
      const { app, socket } = await timedOut();
      socket.fire('room:state', seatedRoom(true));
      socket.fire('race:countdown', COUNTDOWN);
      assert.equal(app.get('state.phase'), 'countdown');
      assert.equal(app.el('results').hidden, true);
      assert.equal(app.el('typing-area').hidden, false);
      assert.equal(app.document.activeElement, app.el('hidden-input'));
    });

    it("says 'Race starting…' after race:countdown", async () => {
      const { app, socket, before } = await timedOut();
      socket.fire('room:state', seatedRoom(true));
      socket.fire('race:countdown', COUNTDOWN);
      app.settle();
      const said = app.spokenSince(before);
      assert.equal(said.length, 1, said.join(' | '));
      assert.match(said[0], /^Race starting in 3 seconds\./);
    });

    it('runs on race:start and sends race:progress when typing', async () => {
      const { app, socket } = await timedOut();
      socket.fire('room:state', seatedRoom(true));
      socket.fire('race:countdown', COUNTDOWN);
      socket.fire('room:state', room('racing', [P('a', 1, { inRace: true, ready: false }), P('b', 2, { inRace: true, ready: false })], 'a'));
      socket.fire('race:start', { raceTimeLimitMs: 120000 });
      assert.equal(app.get('state.phase'), 'running');
      const sentBefore = socket.count('race:progress');
      app.keydown(PASSAGE[0], app.el('hidden-input'));
      app.clock.advance(progressIntervalMs + 10);
      assert.equal(socket.count('race:progress'), sentBefore + 1);
      assert.equal(socket.last('race:progress').payload.keys, PASSAGE[0]);
    });
  });

  describe("then room:state 'countdown' with this player not inRace", () => {
    it('sits out: lobby view, and race:countdown is ignored', async () => {
      const { app, socket } = await timedOut();
      socket.fire('room:state', seatedRoom(false));
      assert.equal(app.get('state.phase'), 'waiting');
      assert.equal(app.el('race-status').textContent, MP.SIT_OUT_MESSAGE);
      socket.fire('race:countdown', COUNTDOWN);
      assert.equal(app.get('state.phase'), 'waiting');
      assert.equal(app.el('typing-area').hidden, true);
    });
  });
});

/* ---------- 3. The lobby deadline can move earlier ---------- */

describe('a lobby deadline that moves', () => {
  /** Host alone, 1 s after creation (deadline at 600000 ms). */
  async function lobby() {
    const app = setupMp();
    const socket = await createRoom(app);
    app.clock.advance(1000);
    return { app, socket, deadline: app.get('state.mp.lobbyDeadline') };
  }
  const alone = (expiresInMs) => room('waiting', [P('a', 1)], 'a', { expiresInMs });

  it('keeps the deadline for a snapshot just inside the margin earlier', async () => {
    const { app, socket, deadline } = await lobby();
    socket.fire('room:state', alone(599000 - (lobbyWarningMarginMs - 1)));
    assert.equal(app.get('state.mp.lobbyDeadline'), deadline);
    assert.equal(app.el('extend-btn').hidden, true);
  });

  it('keeps the deadline for a snapshot just inside the margin later', async () => {
    const { app, socket, deadline } = await lobby();
    socket.fire('room:state', alone(599000 + (lobbyWarningMarginMs - 1)));
    assert.equal(app.get('state.mp.lobbyDeadline'), deadline);
    assert.equal(app.el('extend-btn').hidden, true);
  });

  it('moves the deadline earlier for a snapshot more than the margin earlier', async () => {
    const { app, socket, deadline } = await lobby();
    socket.fire('room:state', alone(599000 - lobbyWarningMarginMs - 1000));
    assert.equal(app.get('state.mp.lobbyDeadline'), deadline - lobbyWarningMarginMs - 1000);
  });

  it('shows the warning straight away when less than a minute is left', async () => {
    const { app, socket } = await lobby();
    socket.fire('room:state', alone(30000));
    app.clock.advance(1);
    assert.equal(app.el('extend-btn').hidden, false);
    assert.ok(app.el('race-status').textContent.endsWith(LOBBY_WARNING));
  });

  it('announces that early warning exactly once', async () => {
    const { app, socket } = await lobby();
    socket.fire('room:state', alone(30000));
    app.settle();
    socket.fire('room:state', alone(20000)); // earlier again, while shown
    app.settle();
    assert.equal(count(app.spoken, LOBBY_WARNING), 1);
    assert.equal(app.el('extend-btn').hidden, false);
  });

  it('hides the warning for a later snapshot', async () => {
    const { app, socket } = await lobby();
    socket.fire('room:state', alone(30000));
    app.settle();
    socket.fire('room:state', alone(600000));
    assert.equal(app.el('extend-btn').hidden, true);
    assert.ok(!app.el('race-status').textContent.includes(LOBBY_WARNING));
  });
});

/* ---------- 4. A dead invite is cleared ---------- */

describe('joining from an invite link that fails', () => {
  /** Opens #room=CODE, presses the banner's Join room and answers with `code`. */
  async function inviteJoinFails(code, hash = '#room=K7QM2X') {
    const app = setupMp({ hash });
    assert.equal(app.el('invite').hidden, false, 'precondition: the banner shows');
    app.click('invite-join-btn');
    await flush();
    app.socket().fire('connect');
    app.socket().last('room:join').cb(null, { ok: false, error: { code } });
    return app;
  }

  for (const code of ['ROOM_NOT_FOUND', 'BAD_CODE']) {
    it(`drops the hash with replaceState for ${code}`, async () => {
      const app = await inviteJoinFails(code);
      assert.equal(app.history.calls.at(-1), PAGES_PATH);
      assert.equal(app.window.location.hash, '');
    });
    it(`shows no invite banner after Solo for ${code}`, async () => {
      const app = await inviteJoinFails(code);
      app.press('solo');
      assert.equal(app.el('invite').hidden, true);
    });
  }

  it('drops a lowercase invite hash too for ROOM_NOT_FOUND', async () => {
    const app = await inviteJoinFails('ROOM_NOT_FOUND', '#room=k7qm2x');
    assert.equal(app.window.location.hash, '');
  });

  for (const code of ['ROOM_FULL', 'RACE_IN_PROGRESS']) {
    it(`keeps the hash for ${code}`, async () => {
      const app = await inviteJoinFails(code);
      assert.equal(app.window.location.hash, '#room=K7QM2X');
      assert.equal(app.history.calls.length, 0);
    });
    it(`shows the invite banner again after Solo for ${code}`, async () => {
      const app = await inviteJoinFails(code);
      app.press('solo');
      assert.equal(app.el('invite').hidden, false);
      assert.equal(app.el('invite-code').textContent, 'K7QM2X');
    });
  }

  it('drops the hash when the pre-filled code is submitted from the menu and is not found', async () => {
    const app = setupMp({ hash: '#room=K7QM2X' });
    app.press('multi');
    assert.equal(app.el('room-code-input').value, 'K7QM2X');
    app.submitJoin(app.el('room-code-input').value);
    await flush();
    app.socket().fire('connect');
    app.socket().last('room:join').cb(null, { ok: false, error: { code: 'ROOM_NOT_FOUND' } });
    assert.equal(app.window.location.hash, '');
  });

  it('leaves the hash alone when a different typed code is not found', async () => {
    const app = setupMp({ hash: '#room=K7QM2X' });
    app.press('multi');
    app.submitJoin('ABCDEF');
    await flush();
    app.socket().fire('connect');
    app.socket().last('room:join').cb(null, { ok: false, error: { code: 'ROOM_NOT_FOUND' } });
    assert.equal(app.window.location.hash, '#room=K7QM2X');
    assert.equal(app.history.calls.length, 0);
    app.press('solo');
    assert.equal(app.el('invite').hidden, false);
  });
});

/* ---------- 5. aria-disabled button styles ---------- */

describe('the aria-disabled button styles in style.css', () => {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  /** Rule bodies whose comma-separated selector list contains `selector` exactly. */
  const rulesFor = (selector) => [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1].split(',').map((s) => s.trim()).includes(selector))
    .map((m) => m[2]);
  const outlineOf = (body) => (body.match(/(?:^|;|\s)outline\s*:\s*([^;]+)/) || [])[1] || '';

  it('gives .primary-btn[aria-disabled="true"] a dashed outline', () => {
    const bodies = rulesFor('.primary-btn[aria-disabled="true"]');
    assert.ok(bodies.length > 0, 'rule exists');
    assert.ok(bodies.some((b) => /\bdashed\b/.test(outlineOf(b))), bodies.join('\n'));
  });

  it('overrides that outline with a solid ring on :focus-visible', () => {
    const bodies = rulesFor('.primary-btn[aria-disabled="true"]:focus-visible');
    assert.ok(bodies.length > 0, 'rule exists');
    const outline = outlineOf(bodies.at(-1));
    assert.ok(outline, 'sets outline');
    assert.doesNotMatch(outline, /\bdashed\b|\bnone\b/);
  });

  it('places the :focus-visible override after the dashed rule, so it wins', () => {
    assert.ok(CSS.lastIndexOf('.primary-btn[aria-disabled="true"]:focus-visible') >
      CSS.indexOf('.primary-btn[aria-disabled="true"]'));
  });

  it('has a .secondary-btn[aria-disabled="true"] rule', () => {
    assert.ok(rulesFor('.secondary-btn[aria-disabled="true"]').length > 0);
  });
});

/* ---------- 6. isInteractiveTarget with no global Element ---------- */

describe('the app with no global Element', () => {
  const load = () => {
    const app = loadApp({ withMultiplayer: true, withElement: false });
    assert.equal(app.error, null, app.error && app.error.stack);
    return app;
  };
  const keydown = (app, key, target) => {
    const event = {
      key, target, metaKey: false, ctrlKey: false, altKey: false, isComposing: false,
      getModifierState: () => false, preventDefault() {},
    };
    for (const fn of app.document.listeners.keydown || []) fn(event);
  };
  const get = (app, expr) => require('node:vm').runInContext(expr, app.ctx);

  it('loads with Element really undefined', () => {
    const app = load();
    assert.equal(get(app, 'typeof Element'), 'undefined');
  });

  it('isInteractiveTarget returns false instead of throwing', () => {
    const app = load();
    assert.equal(get(app, 'isInteractiveTarget(document.getElementById("restart-inline"))'), false);
  });

  it('still starts the solo test on the first typed character', () => {
    const app = load();
    assert.equal(get(app, 'state.phase'), 'idle');
    keydown(app, 'a', app.elements.get('hidden-input'));
    assert.equal(get(app, 'state.phase'), 'running');
  });

  it('still focuses the typing input on a tap on the passage', () => {
    const app = load();
    app.document.activeElement = null;
    const area = app.elements.get('typing-area');
    for (const fn of area.listeners.click || []) fn({ target: area });
    assert.equal(app.document.activeElement, app.elements.get('hidden-input'));
  });
});
