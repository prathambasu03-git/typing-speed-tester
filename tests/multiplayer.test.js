'use strict';

/*
 * Unit tests for multiplayer.js, the DOM-free multiplayer logic of the client.
 * Payload samples come from docs/PROTOCOL.md section 5.
 * Run from the repo root with:  node --test tests/
 * Only Node built-ins are used.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MP_SRC = fs.readFileSync(path.join(ROOT, 'multiplayer.js'), 'utf8');

const mp = require('../multiplayer.js');
const {
  MP_CONSTANTS,
  resolveServerUrl,
  isServerUsable,
  appendKey,
  isSendableKey,
  validateRoomState,
  validateCountdown,
  validateRaceStart,
  validateRaceUpdate,
  validatePlayerFinish,
  validateRaceEnd,
  validateJoinAck,
  validateRematchAck,
  labelFor,
  ordinal,
  crossedMilestone,
  errorMessage,
  formatRaceTime,
} = mp;

/** Readable label for a test value. */
function label(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Number.isNaN(value)) return 'NaN';
  if (Array.isArray(value)) return '[]';
  return String(value);
}

/* ---------- Well-formed samples (PROTOCOL.md section 5) ---------- */

function player(overrides = {}) {
  return { id: 'p1', slot: 1, connected: true, ready: true, finished: false, ...overrides };
}

function roomState(overrides = {}) {
  return {
    phase: 'waiting',
    maxPlayers: 2,
    players: [player(), player({ id: 'p2', slot: 2 })],
    ...overrides,
  };
}

function countdown(overrides = {}) {
  return { passage: 'the quick brown fox', startsInMs: 3000, raceTimeLimitMs: 120000, ...overrides };
}

function progressEntry(overrides = {}) {
  return { id: 'p1', correctChars: 40, progress: 25, wpm: 60, accuracy: 97, finished: false, place: null, ...overrides };
}

function raceUpdate(overrides = {}) {
  return {
    elapsedMs: 5000,
    players: [progressEntry(), progressEntry({ id: 'p2', correctChars: 10, progress: 6 })],
    ...overrides,
  };
}

function playerFinish(overrides = {}) {
  return { id: 'p1', place: 1, timeMs: 41300, wpm: 72, accuracy: 98, ...overrides };
}

function resultEntry(overrides = {}) {
  return {
    id: 'p1', slot: 1, place: 1, status: 'finished', wpm: 72, rawWpm: 75, accuracy: 98,
    correctChars: 160, incorrectChars: 3, timeMs: 41300, ...overrides,
  };
}

function raceEnd(overrides = {}) {
  return {
    reason: 'all_finished',
    results: [resultEntry(), resultEntry({ id: 'p2', slot: 2, place: 2, status: 'unfinished' })],
    ...overrides,
  };
}

function joinAck(overrides = {}) {
  return { ok: true, playerId: 'p1', room: roomState(), ...overrides };
}

function rematchAck(overrides = {}) {
  return { ok: true, room: roomState({ phase: 'finished' }), ...overrides };
}

/* ------------------------------------------------------------------------ */

describe('loading multiplayer.js as a browser-style classic script', () => {
  // Only the URL constructor, which every browser has, is provided. No DOM.
  function load() {
    const ctx = vm.createContext({ URL });
    vm.runInContext(MP_SRC, ctx, { filename: 'multiplayer.js' });
    return ctx;
  }

  it('runs in a vm context with no document or window, proving it is DOM-free', () => {
    const ctx = vm.createContext({});
    assert.doesNotThrow(() => vm.runInContext(MP_SRC, ctx, { filename: 'multiplayer.js' }));
    assert.equal(vm.runInContext('typeof document', ctx), 'undefined');
    assert.equal(vm.runInContext('typeof window', ctx), 'undefined');
  });

  it('defines every exported name as a global for later classic scripts', () => {
    const ctx = load();
    for (const name of Object.keys(mp)) {
      const expected = name === 'MP_CONSTANTS' ? 'object' : 'function';
      assert.equal(vm.runInContext(`typeof ${name}`, ctx), expected, name);
    }
  });

  it('skips the Node export when there is no module (the browser case)', () => {
    const ctx = load();
    assert.equal(vm.runInContext('typeof module', ctx), 'undefined');
  });

  it('gives the same results in the vm as through require', () => {
    const ctx = load();
    assert.equal(vm.runInContext('ordinal(22)', ctx), '22nd');
    assert.equal(vm.runInContext('resolveServerUrl("https://example.com/x")', ctx), 'https://example.com');
  });
});

describe('MP_CONSTANTS', () => {
  it('is frozen', () => assert.equal(Object.isFrozen(MP_CONSTANTS), true));
  it('has a frozen milestones list', () => assert.equal(Object.isFrozen(MP_CONSTANTS.milestones), true));
  it('sets rematchTimeoutMs to 60000, matching the server REMATCH_TIMEOUT_MS', () => {
    assert.equal(MP_CONSTANTS.rematchTimeoutMs, 60000);
  });
  it('sets rematchWarningMs to 20000', () => assert.equal(MP_CONSTANTS.rematchWarningMs, 20000));
  it('warns before the rematch timeout fires', () => {
    assert.ok(MP_CONSTANTS.rematchWarningMs < MP_CONSTANTS.rematchTimeoutMs);
  });
  it('sets maxKeysPerEvent to 64', () => assert.equal(MP_CONSTANTS.maxKeysPerEvent, 64));
  it('sets progressIntervalMs to 150', () => assert.equal(MP_CONSTANTS.progressIntervalMs, 150));
  it('sets passageMaxLength to 1000', () => assert.equal(MP_CONSTANTS.passageMaxLength, 1000));
  it('uses U+0008 as the Backspace marker', () => assert.equal(MP_CONSTANTS.backspace, '\u0008'));
  it('has no defaultServerUrl', () => {
    assert.equal(Object.prototype.hasOwnProperty.call(MP_CONSTANTS, 'defaultServerUrl'), false);
  });
  it('cannot be changed at runtime', () => {
    assert.throws(() => { MP_CONSTANTS.maxKeysPerEvent = 1000; }, TypeError);
    assert.equal(MP_CONSTANTS.maxKeysPerEvent, 64);
  });
});

describe('resolveServerUrl', () => {
  it('keeps a plain localhost origin', () => {
    assert.equal(resolveServerUrl('http://localhost:3000'), 'http://localhost:3000');
  });
  it('reduces a URL with a path to its origin', () => {
    assert.equal(resolveServerUrl('https://example.com/path/'), 'https://example.com');
  });
  it('trims surrounding whitespace', () => {
    assert.equal(resolveServerUrl('  https://example.com  '), 'https://example.com');
  });
  for (const value of ['', '   ', undefined, null, 42, 'not a url', 'javascript:alert(1)',
    'data:text/html,x', 'file:///C:/x', 'ftp://x']) {
    it(`returns null for ${label(value)}`, () => assert.equal(resolveServerUrl(value), null));
  }
});

describe('isServerUsable', () => {
  it('allows a localhost server from a localhost page', () => {
    assert.equal(isServerUsable('http://localhost:3000', 'localhost'), true);
  });
  it('allows a localhost server from a 127.0.0.1 page', () => {
    assert.equal(isServerUsable('http://localhost:3000', '127.0.0.1'), true);
  });
  it('allows a 127.0.0.1 server from a localhost page', () => {
    assert.equal(isServerUsable('http://127.0.0.1:3000', 'localhost'), true);
  });
  it('rejects a localhost server from a file:// page (empty hostname)', () => {
    assert.equal(isServerUsable('http://localhost:3000', ''), false);
  });
  it('rejects a 127.0.0.1 server from a file:// page (empty hostname)', () => {
    assert.equal(isServerUsable('http://127.0.0.1:3000', ''), false);
  });
  it('rejects a localhost server from the live site', () => {
    assert.equal(isServerUsable('http://localhost:3000', 'example.github.io'), false);
  });
  it('allows a non-localhost server from the live site', () => {
    assert.equal(isServerUsable('https://game.example.com', 'example.github.io'), true);
  });
  it('allows a non-localhost server from a file:// page', () => {
    assert.equal(isServerUsable('https://game.example.com', ''), true);
  });
  it('allows a non-localhost server from a localhost page', () => {
    assert.equal(isServerUsable('https://game.example.com', 'localhost'), true);
  });
  it('rejects a string that is not a URL', () => {
    assert.equal(isServerUsable('not a url', 'localhost'), false);
  });
  for (const value of [undefined, null, 42, {}]) {
    it(`rejects a non-string server URL (${label(value)})`, () => {
      assert.equal(isServerUsable(value, 'localhost'), false);
    });
  }
});

describe('appendKey', () => {
  it('adds a key to an empty buffer without flushing', () => {
    assert.deepEqual(appendKey('', 'a', 64), { buffer: 'a', flush: null });
  });
  it('fills the buffer up to exactly max without flushing', () => {
    assert.deepEqual(appendKey('a'.repeat(63), 'b', 64), { buffer: 'a'.repeat(63) + 'b', flush: null });
  });
  it('flushes a full buffer and starts a new one with the key', () => {
    assert.deepEqual(appendKey('a'.repeat(64), 'b', 64), { buffer: 'b', flush: 'a'.repeat(64) });
  });
  it('flushes before a two-unit emoji that would overflow the buffer', () => {
    assert.deepEqual(appendKey('a'.repeat(63), '😀', 64), { buffer: '😀', flush: 'a'.repeat(63) });
  });
  it('appends the Backspace marker like any other key', () => {
    assert.deepEqual(appendKey('ab', '\b', 64), { buffer: 'ab\b', flush: null });
  });
});

describe('isSendableKey', () => {
  for (const key of ['a', 'Z', '7', ' ', '.', 'é', 'ß', '\u00A0', '中']) {
    it(`accepts the single character ${label(key)}`, () => assert.equal(isSendableKey(key), true));
  }
  it('accepts a surrogate pair (one astral code point)', () => assert.equal(isSendableKey('😀'), true));
  it('rejects the Backspace marker, which is sent by a separate path', () => {
    assert.equal(isSendableKey('\b'), false);
  });
  for (const key of ['\u0000', '\t', '\n', '\r', '\u001F', '\u007F', '\u0080', '\u009F']) {
    it(`rejects the control character ${label(key)}`, () => assert.equal(isSendableKey(key), false));
  }
  it('rejects a lone high surrogate', () => assert.equal(isSendableKey('\uD83D'), false));
  it('rejects a lone low surrogate', () => assert.equal(isSendableKey('\uDE00'), false));
  it('rejects two high surrogates', () => assert.equal(isSendableKey('\uD83D\uD83D'), false));
  it('rejects a low surrogate followed by a high one', () => assert.equal(isSendableKey('\uDE00\uD83D'), false));
  it('rejects two ordinary characters', () => assert.equal(isSendableKey('ab'), false));
  it('rejects the empty string', () => assert.equal(isSendableKey(''), false));
  it('rejects a string longer than two units', () => assert.equal(isSendableKey('abc'), false));
  for (const value of [undefined, null, 97, ['a']]) {
    it(`rejects a non-string (${label(value)})`, () => assert.equal(isSendableKey(value), false));
  }
});

/* ---------- Validators ---------- */

/** Shared checks every validator must pass. */
function commonValidatorChecks(validate, sample) {
  it('accepts a well-formed payload', () => assert.deepEqual(validate(sample()), sample()));
  it('returns a copy, never the input object', () => {
    const input = sample();
    const out = validate(input);
    assert.notEqual(out, null);
    assert.notStrictEqual(out, input);
  });
  it('strips unknown top-level fields', () => {
    const out = validate({ ...sample(), extra: 'x', __proto__evil: 1 });
    assert.deepEqual(out, sample());
  });
  for (const value of [null, undefined, [], 'string', 42, true]) {
    it(`rejects ${label(value)}`, () => assert.equal(validate(value), null));
  }
  it('rejects an array wrapping a valid payload', () => assert.equal(validate([sample()]), null));
}

describe('validateRoomState', () => {
  commonValidatorChecks(validateRoomState, roomState);

  it('copies each player rather than reusing the input objects', () => {
    const input = roomState();
    const out = validateRoomState(input);
    assert.notStrictEqual(out.players, input.players);
    assert.notStrictEqual(out.players[0], input.players[0]);
  });
  it('strips unknown fields from players', () => {
    const out = validateRoomState(roomState({ players: [player({ name: '<b>x</b>' })] }));
    assert.deepEqual(out.players, [player()]);
  });
  it('sorts players by slot', () => {
    const out = validateRoomState(roomState({ players: [player({ id: 'p2', slot: 2 }), player()] }));
    assert.deepEqual(out.players.map((p) => p.slot), [1, 2]);
  });
  it('accepts an empty players list', () => {
    assert.deepEqual(validateRoomState(roomState({ players: [] })).players, []);
  });
  for (const phase of ['waiting', 'countdown', 'racing', 'finished']) {
    it(`accepts phase ${label(phase)}`, () => assert.equal(validateRoomState(roomState({ phase })).phase, phase));
  }
  for (const phase of ['lobby', 'WAITING', '', null, 1]) {
    it(`rejects unknown phase ${label(phase)}`, () => assert.equal(validateRoomState(roomState({ phase })), null));
  }
  for (const maxPlayers of [0, 9, 1.5, '2', NaN, null]) {
    it(`rejects maxPlayers ${label(maxPlayers)}`, () => {
      assert.equal(validateRoomState(roomState({ maxPlayers, players: [] })), null);
    });
  }
  it('rejects a players field that is not an array', () => {
    assert.equal(validateRoomState(roomState({ players: {} })), null);
  });
  it('rejects more players than maxPlayers', () => {
    const players = [player(), player({ id: 'p2', slot: 2 })];
    assert.equal(validateRoomState(roomState({ maxPlayers: 1, players })), null);
  });
  it('rejects duplicate player ids', () => {
    assert.equal(validateRoomState(roomState({ players: [player(), player({ slot: 2 })] })), null);
  });
  it('rejects a player slot above maxPlayers', () => {
    assert.equal(validateRoomState(roomState({ players: [player({ slot: 3 })] })), null);
  });
  it('rejects a player slot of 0', () => {
    assert.equal(validateRoomState(roomState({ players: [player({ slot: 0 })] })), null);
  });
  it('rejects an empty player id', () => {
    assert.equal(validateRoomState(roomState({ players: [player({ id: '' })] })), null);
  });
  it('rejects a player id longer than 64 characters', () => {
    assert.equal(validateRoomState(roomState({ players: [player({ id: 'x'.repeat(65) })] })), null);
  });
  it('accepts a player id of exactly 64 characters', () => {
    assert.notEqual(validateRoomState(roomState({ players: [player({ id: 'x'.repeat(64) })] })), null);
  });
  for (const field of ['connected', 'ready', 'finished']) {
    it(`rejects a non-boolean player ${field}`, () => {
      assert.equal(validateRoomState(roomState({ players: [player({ [field]: 'true' })] })), null);
    });
  }
  it('rejects a null player entry', () => {
    assert.equal(validateRoomState(roomState({ players: [null] })), null);
  });
});

describe('validateCountdown', () => {
  commonValidatorChecks(validateCountdown, countdown);

  it('accepts a passage of exactly 1000 characters', () => {
    assert.notEqual(validateCountdown(countdown({ passage: 'a'.repeat(1000) })), null);
  });
  it('rejects a passage of 1001 characters', () => {
    assert.equal(validateCountdown(countdown({ passage: 'a'.repeat(1001) })), null);
  });
  it('rejects an empty passage', () => assert.equal(validateCountdown(countdown({ passage: '' })), null));
  for (const ch of ['\n', '\t', '\r', '\u0000', '\b', '\u007F', '\u0085']) {
    it(`rejects a passage containing the control character ${label(ch)}`, () => {
      assert.equal(validateCountdown(countdown({ passage: `the${ch}fox` })), null);
    });
  }
  it('rejects a non-string passage', () => assert.equal(validateCountdown(countdown({ passage: ['a'] })), null));
  it('accepts startsInMs of 0 and 10000', () => {
    assert.notEqual(validateCountdown(countdown({ startsInMs: 0 })), null);
    assert.notEqual(validateCountdown(countdown({ startsInMs: 10000 })), null);
  });
  for (const startsInMs of [-1, 10001, 2.5, '3000', NaN, Infinity, null]) {
    it(`rejects startsInMs ${label(startsInMs)}`, () => {
      assert.equal(validateCountdown(countdown({ startsInMs })), null);
    });
  }
  for (const raceTimeLimitMs of [999, 600001, 0, -1, 1.5, '120000', null]) {
    it(`rejects raceTimeLimitMs ${label(raceTimeLimitMs)}`, () => {
      assert.equal(validateCountdown(countdown({ raceTimeLimitMs })), null);
    });
  }
});

describe('validateRaceStart', () => {
  commonValidatorChecks(validateRaceStart, () => ({ raceTimeLimitMs: 120000 }));

  it('accepts the bounds 1000 and 600000', () => {
    assert.deepEqual(validateRaceStart({ raceTimeLimitMs: 1000 }), { raceTimeLimitMs: 1000 });
    assert.deepEqual(validateRaceStart({ raceTimeLimitMs: 600000 }), { raceTimeLimitMs: 600000 });
  });
  for (const raceTimeLimitMs of [999, 600001, '120000', NaN, undefined]) {
    it(`rejects raceTimeLimitMs ${label(raceTimeLimitMs)}`, () => {
      assert.equal(validateRaceStart({ raceTimeLimitMs }), null);
    });
  }
});

describe('validateRaceUpdate', () => {
  commonValidatorChecks(validateRaceUpdate, raceUpdate);

  it('strips unknown fields from progress entries', () => {
    const out = validateRaceUpdate(raceUpdate({ players: [progressEntry({ name: 'x' })] }));
    assert.deepEqual(out.players, [progressEntry()]);
  });
  it('copies progress entries rather than reusing the input objects', () => {
    const input = raceUpdate();
    const out = validateRaceUpdate(input);
    assert.notStrictEqual(out.players[0], input.players[0]);
  });
  it('accepts a finished entry with a place', () => {
    const entry = progressEntry({ finished: true, place: 1, progress: 100 });
    assert.deepEqual(validateRaceUpdate(raceUpdate({ players: [entry] })).players, [entry]);
  });
  it('rejects progress 101', () => {
    assert.equal(validateRaceUpdate(raceUpdate({ players: [progressEntry({ progress: 101 })] })), null);
  });
  it('rejects progress -1', () => {
    assert.equal(validateRaceUpdate(raceUpdate({ players: [progressEntry({ progress: -1 })] })), null);
  });
  it('rejects place 0', () => {
    assert.equal(validateRaceUpdate(raceUpdate({ players: [progressEntry({ place: 0 })] })), null);
  });
  it('rejects a missing place (must be an integer or null)', () => {
    const entry = progressEntry();
    delete entry.place;
    assert.equal(validateRaceUpdate(raceUpdate({ players: [entry] })), null);
  });
  it('rejects accuracy -1', () => {
    assert.equal(validateRaceUpdate(raceUpdate({ players: [progressEntry({ accuracy: -1 })] })), null);
  });
  it('rejects accuracy 101', () => {
    assert.equal(validateRaceUpdate(raceUpdate({ players: [progressEntry({ accuracy: 101 })] })), null);
  });
  it('rejects wpm 1001', () => {
    assert.equal(validateRaceUpdate(raceUpdate({ players: [progressEntry({ wpm: 1001 })] })), null);
  });
  it('rejects negative correctChars', () => {
    assert.equal(validateRaceUpdate(raceUpdate({ players: [progressEntry({ correctChars: -1 })] })), null);
  });
  it('rejects a non-boolean finished', () => {
    assert.equal(validateRaceUpdate(raceUpdate({ players: [progressEntry({ finished: 1 })] })), null);
  });
  it('rejects a string number for wpm', () => {
    assert.equal(validateRaceUpdate(raceUpdate({ players: [progressEntry({ wpm: '60' })] })), null);
  });
  for (const elapsedMs of [-1, 1.5, '5000', NaN, undefined]) {
    it(`rejects elapsedMs ${label(elapsedMs)}`, () => {
      assert.equal(validateRaceUpdate(raceUpdate({ elapsedMs })), null);
    });
  }
  it('rejects duplicate player ids', () => {
    assert.equal(validateRaceUpdate(raceUpdate({ players: [progressEntry(), progressEntry()] })), null);
  });
  it('rejects more than 8 entries', () => {
    const players = Array.from({ length: 9 }, (_, i) => progressEntry({ id: `p${i}` }));
    assert.equal(validateRaceUpdate(raceUpdate({ players })), null);
  });
  it('rejects a players field that is not an array', () => {
    assert.equal(validateRaceUpdate(raceUpdate({ players: null })), null);
  });
});

describe('validatePlayerFinish', () => {
  commonValidatorChecks(validatePlayerFinish, playerFinish);

  it('rejects place 0', () => assert.equal(validatePlayerFinish(playerFinish({ place: 0 })), null));
  it('rejects a null place', () => assert.equal(validatePlayerFinish(playerFinish({ place: null })), null));
  it('rejects accuracy -1', () => assert.equal(validatePlayerFinish(playerFinish({ accuracy: -1 })), null));
  it('rejects wpm 1001', () => assert.equal(validatePlayerFinish(playerFinish({ wpm: 1001 })), null));
  it('rejects a negative timeMs', () => assert.equal(validatePlayerFinish(playerFinish({ timeMs: -1 })), null));
  it('rejects a NaN timeMs', () => assert.equal(validatePlayerFinish(playerFinish({ timeMs: NaN })), null));
  it('rejects a non-string id', () => assert.equal(validatePlayerFinish(playerFinish({ id: 1 })), null));
  it('accepts timeMs 0', () => assert.notEqual(validatePlayerFinish(playerFinish({ timeMs: 0 })), null));
});

describe('validateRaceEnd', () => {
  commonValidatorChecks(validateRaceEnd, raceEnd);

  it('accepts reason time_limit', () => {
    assert.equal(validateRaceEnd(raceEnd({ reason: 'time_limit' })).reason, 'time_limit');
  });
  for (const reason of ['abandoned', '', null, undefined]) {
    it(`rejects unknown reason ${label(reason)}`, () => assert.equal(validateRaceEnd(raceEnd({ reason })), null));
  }
  for (const status of ['finished', 'unfinished', 'left']) {
    it(`accepts status ${label(status)}`, () => {
      assert.notEqual(validateRaceEnd(raceEnd({ results: [resultEntry({ status })] })), null);
    });
  }
  for (const status of ['dnf', 'FINISHED', null]) {
    it(`rejects unknown status ${label(status)}`, () => {
      assert.equal(validateRaceEnd(raceEnd({ results: [resultEntry({ status })] })), null);
    });
  }
  it('strips unknown fields from result entries', () => {
    const out = validateRaceEnd(raceEnd({ results: [resultEntry({ name: 'x' })] }));
    assert.deepEqual(out.results, [resultEntry()]);
  });
  it('copies result entries rather than reusing the input objects', () => {
    const input = raceEnd();
    assert.notStrictEqual(validateRaceEnd(input).results[0], input.results[0]);
  });
  it('rejects place 0', () => {
    assert.equal(validateRaceEnd(raceEnd({ results: [resultEntry({ place: 0 })] })), null);
  });
  it('rejects results that are not sorted by place', () => {
    const results = [resultEntry({ id: 'p2', slot: 2, place: 2 }), resultEntry()];
    assert.equal(validateRaceEnd(raceEnd({ results })), null);
  });
  it('rejects repeated places', () => {
    const results = [resultEntry(), resultEntry({ id: 'p2', slot: 2, place: 1 })];
    assert.equal(validateRaceEnd(raceEnd({ results })), null);
  });
  it('rejects a gap in places', () => {
    const results = [resultEntry(), resultEntry({ id: 'p2', slot: 2, place: 3 })];
    assert.equal(validateRaceEnd(raceEnd({ results })), null);
  });
  it('rejects accuracy -1', () => {
    assert.equal(validateRaceEnd(raceEnd({ results: [resultEntry({ accuracy: -1 })] })), null);
  });
  it('rejects rawWpm 5001', () => {
    assert.equal(validateRaceEnd(raceEnd({ results: [resultEntry({ rawWpm: 5001 })] })), null);
  });
  it('accepts rawWpm 5000', () => {
    assert.notEqual(validateRaceEnd(raceEnd({ results: [resultEntry({ rawWpm: 5000 })] })), null);
  });
  it('rejects wpm 1001', () => {
    assert.equal(validateRaceEnd(raceEnd({ results: [resultEntry({ wpm: 1001 })] })), null);
  });
  it('rejects slot 9', () => {
    assert.equal(validateRaceEnd(raceEnd({ results: [resultEntry({ slot: 9 })] })), null);
  });
  it('rejects negative incorrectChars', () => {
    assert.equal(validateRaceEnd(raceEnd({ results: [resultEntry({ incorrectChars: -1 })] })), null);
  });
  it('rejects duplicate ids', () => {
    const results = [resultEntry(), resultEntry({ slot: 2, place: 2 })];
    assert.equal(validateRaceEnd(raceEnd({ results })), null);
  });
  it('rejects a results field that is not an array', () => {
    assert.equal(validateRaceEnd(raceEnd({ results: 'x' })), null);
  });
});

describe('validateJoinAck', () => {
  commonValidatorChecks(validateJoinAck, joinAck);

  it('reduces a failure ack to its code, dropping the server message', () => {
    const out = validateJoinAck({ ok: false, error: { code: 'ROOM_FULL', message: 'Room is full' } });
    assert.deepEqual(out, { ok: false, error: { code: 'ROOM_FULL' } });
  });
  it('rejects a failure ack with no error object', () => {
    assert.equal(validateJoinAck({ ok: false }), null);
  });
  it('rejects a failure ack whose error is an array', () => {
    assert.equal(validateJoinAck({ ok: false, error: [] }), null);
  });
  it('rejects a failure ack with an empty code', () => {
    assert.equal(validateJoinAck({ ok: false, error: { code: '' } }), null);
  });
  it('rejects a failure ack with a code over 64 characters', () => {
    assert.equal(validateJoinAck({ ok: false, error: { code: 'X'.repeat(65) } }), null);
  });
  it('rejects a failure ack with a non-string code', () => {
    assert.equal(validateJoinAck({ ok: false, error: { code: 404 } }), null);
  });
  it('rejects a non-boolean ok', () => assert.equal(validateJoinAck(joinAck({ ok: 'true' })), null));
  it('rejects a success ack with no playerId', () => {
    assert.equal(validateJoinAck(joinAck({ playerId: undefined })), null);
  });
  it('rejects a success ack with an invalid room', () => {
    assert.equal(validateJoinAck(joinAck({ room: roomState({ phase: 'lobby' }) })), null);
  });
  it('copies the nested room', () => {
    const input = joinAck();
    assert.notStrictEqual(validateJoinAck(input).room, input.room);
  });
});

describe('validateRematchAck', () => {
  commonValidatorChecks(validateRematchAck, rematchAck);

  it('reduces a failure ack to its code', () => {
    const out = validateRematchAck({ ok: false, error: { code: 'RATE_LIMITED', message: 'slow down' } });
    assert.deepEqual(out, { ok: false, error: { code: 'RATE_LIMITED' } });
  });
  it('rejects a failure ack with no error object', () => assert.equal(validateRematchAck({ ok: false }), null));
  it('rejects a success ack with no room', () => assert.equal(validateRematchAck({ ok: true }), null));
  it('rejects a non-boolean ok', () => assert.equal(validateRematchAck(rematchAck({ ok: 1 })), null));
  it('drops an unexpected playerId from a success ack', () => {
    assert.deepEqual(validateRematchAck(rematchAck({ playerId: 'p1' })), rematchAck());
  });
});

/* ---------- Labels and text ---------- */

describe('ordinal', () => {
  const cases = [[1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], [11, '11th'], [12, '12th'],
    [13, '13th'], [21, '21st'], [22, '22nd'], [101, '101st'], [111, '111th']];
  for (const [n, expected] of cases) {
    it(`turns ${n} into ${expected}`, () => assert.equal(ordinal(n), expected));
  }
});

describe('crossedMilestone', () => {
  it('returns 50 when progress goes from 40 to 55', () => assert.equal(crossedMilestone(40, 55, [50]), 50));
  it('returns null when the milestone was already reached before', () => {
    assert.equal(crossedMilestone(50, 60, [50]), null);
  });
  it('returns the highest milestone when several are crossed at once', () => {
    assert.equal(crossedMilestone(0, 100, [25, 50, 75]), 75);
  });
  it('returns null when progress goes backwards', () => assert.equal(crossedMilestone(60, 40, [50]), null));
  it('counts landing exactly on the milestone as crossing it', () => {
    assert.equal(crossedMilestone(49, 50, [50]), 50);
  });
  it('returns null for an empty milestone list', () => assert.equal(crossedMilestone(0, 100, []), null));
});

describe('labelFor', () => {
  const two = [{ id: 'me', slot: 1 }, { id: 'a', slot: 2 }];
  const three = [{ id: 'b', slot: 3 }, { id: 'me', slot: 2 }, { id: 'a', slot: 1 }];

  it('labels the local player "You"', () => assert.equal(labelFor('me', 'me', two), 'You'));
  it('labels a single opponent "Opponent"', () => assert.equal(labelFor('a', 'me', two), 'Opponent'));
  it('numbers the lower-slot opponent "Opponent 1" when there are two', () => {
    assert.equal(labelFor('a', 'me', three), 'Opponent 1');
  });
  it('numbers the higher-slot opponent "Opponent 2" when there are two', () => {
    assert.equal(labelFor('b', 'me', three), 'Opponent 2');
  });
  it('falls back to "Opponent" when players is not an array', () => {
    assert.equal(labelFor('a', 'me', null), 'Opponent');
  });
  it('falls back to "Opponent" for an unknown id among several opponents', () => {
    assert.equal(labelFor('zzz', 'me', three), 'Opponent');
  });
});

describe('errorMessage', () => {
  const known = ['ROOM_FULL', 'RACE_IN_PROGRESS', 'RATE_LIMITED', 'UNREACHABLE', 'DISCONNECTED', 'IDLE_TIMEOUT'];
  const fallback = errorMessage('NO_SUCH_CODE');

  it('gives a default message for an unknown code', () => {
    assert.equal(typeof fallback, 'string');
    assert.ok(fallback.length > 0);
  });
  for (const code of known) {
    it(`gives ${code} its own text, not the default`, () => {
      const text = errorMessage(code);
      assert.equal(typeof text, 'string');
      assert.ok(text.length > 0);
      assert.notEqual(text, fallback);
    });
  }
  it('gives every known code a different text', () => {
    const texts = known.map(errorMessage);
    assert.equal(new Set(texts).size, texts.length);
  });
  it('mentions being idle in the IDLE_TIMEOUT text', () => {
    assert.match(errorMessage('IDLE_TIMEOUT'), /idle/i);
  });
  it('tells the player to wait in the RATE_LIMITED text', () => {
    assert.match(errorMessage('RATE_LIMITED'), /wait|too many/i);
  });
  it('tells the player they are solo after UNREACHABLE', () => {
    assert.match(errorMessage('UNREACHABLE'), /solo/i);
  });
  for (const code of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    it(`gives the default for the inherited property name ${label(code)}`, () => {
      assert.equal(errorMessage(code), fallback);
    });
  }
  for (const code of [undefined, null, 42]) {
    it(`gives the default for a non-string code (${label(code)})`, () => {
      assert.equal(errorMessage(code), fallback);
    });
  }
});

describe('formatRaceTime', () => {
  it('formats 41300 ms as "41.3s"', () => assert.equal(formatRaceTime(41300), '41.3s'));
  it('formats 0 ms as "0.0s"', () => assert.equal(formatRaceTime(0), '0.0s'));
  it('formats 120000 ms as "120.0s"', () => assert.equal(formatRaceTime(120000), '120.0s'));
  for (const value of [-500, NaN, Infinity, undefined, '41300']) {
    it(`formats ${label(value)} as "0.0s"`, () => assert.equal(formatRaceTime(value), '0.0s'));
  }
});
