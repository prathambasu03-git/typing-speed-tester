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
  isLoopbackUrl,
  connectBudgetMs,
  retryDelayWithin,
  pickServerUrl,
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
  return { id: 'p1', slot: 1, connected: true, ready: true, inRace: false, finished: false, ...overrides };
}

function roomState(overrides = {}) {
  return {
    code: 'K7QM2X',
    phase: 'waiting',
    maxPlayers: 2,
    minPlayers: 2,
    hostId: 'p1',
    expiresInMs: 600000,
    players: [player(), player({ id: 'p2', slot: 2 })],
    ...overrides,
  };
}

/** A snapshot in a phase other than waiting: no lobby timer. */
function roomInPhase(phase, overrides = {}) {
  return roomState({ phase, expiresInMs: phase === 'waiting' ? 600000 : null, ...overrides });
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
  return { ok: true, room: roomInPhase('finished'), ...overrides };
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
      assert.equal(vm.runInContext(`typeof ${name}`, ctx), typeof mp[name], name);
    }
  });

  it('exports a function for every name except the constants', () => {
    const constants = ['MP_CONSTANTS', 'ROOM_CODE_PATTERN', 'ROOM_CODE_FORMAT_MESSAGE', 'SOLO_TIP', 'SIT_OUT_MESSAGE'];
    for (const [name, value] of Object.entries(mp)) {
      if (constants.includes(name)) continue;
      assert.equal(typeof value, 'function', name);
    }
  });

  it('defines ROOM_CODE_PATTERN in the vm as a RegExp with the same source', () => {
    const ctx = load();
    assert.equal(vm.runInContext('ROOM_CODE_PATTERN instanceof RegExp', ctx), true);
    assert.equal(vm.runInContext('ROOM_CODE_PATTERN.source', ctx), mp.ROOM_CODE_PATTERN.source);
  });

  it('defines SOLO_TIP and SIT_OUT_MESSAGE in the vm as the exported strings', () => {
    const ctx = load();
    assert.equal(vm.runInContext('SOLO_TIP', ctx), mp.SOLO_TIP);
    assert.equal(vm.runInContext('SIT_OUT_MESSAGE', ctx), mp.SIT_OUT_MESSAGE);
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
  it('has no connectTimeoutMs, which milestone D removed', () => {
    assert.equal(Object.prototype.hasOwnProperty.call(MP_CONSTANTS, 'connectTimeoutMs'), false);
  });
  it('sets wakeTimeoutMs to 90000', () => assert.equal(MP_CONSTANTS.wakeTimeoutMs, 90000));
  it('sets localConnectTimeoutMs to 5000', () => assert.equal(MP_CONSTANTS.localConnectTimeoutMs, 5000));
  it('sets wakeRetryDelayMs to 3000', () => assert.equal(MP_CONSTANTS.wakeRetryDelayMs, 3000));
  it('sets wakeNoticeDelayMs to 3000', () => assert.equal(MP_CONSTANTS.wakeNoticeDelayMs, 3000));
  it('sets joinAckTimeoutMs to 10000', () => assert.equal(MP_CONSTANTS.joinAckTimeoutMs, 10000));
  it('sets ackTimeoutMs to 5000', () => assert.equal(MP_CONSTANTS.ackTimeoutMs, 5000));
  it("sets localServerUrl to 'http://localhost:3000'", () => {
    assert.equal(MP_CONSTANTS.localServerUrl, 'http://localhost:3000');
  });
  it('cannot have its wake timeout changed at runtime', () => {
    assert.throws(() => { MP_CONSTANTS.wakeTimeoutMs = 1; }, TypeError);
    assert.equal(MP_CONSTANTS.wakeTimeoutMs, 90000);
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

describe('pickServerUrl', () => {
  const pages = {
    pages: { protocol: 'https:', hostname: 'prathambasu03-git.github.io' },
    localhost: { protocol: 'http:', hostname: 'localhost' },
    loopbackIp: { protocol: 'http:', hostname: '127.0.0.1' },
    file: { protocol: 'file:', hostname: '' },
    lan: { protocol: 'http:', hostname: '192.168.1.5' },
  };
  const rows = [
    ['REPLACE_WITH_RENDER_URL', 'pages', null],
    ['https://typing-speed-tester-server.onrender.com', 'pages', 'https://typing-speed-tester-server.onrender.com'],
    ['https://x.onrender.com/path/', 'pages', 'https://x.onrender.com'],
    ['http://localhost:3000', 'pages', null],
    ['http://x.onrender.com', 'pages', null],
    [undefined, 'pages', null],
    ['', 'pages', null],
    ['javascript:alert(1)', 'pages', null],
    ['REPLACE_WITH_RENDER_URL', 'localhost', 'http://localhost:3000'],
    ['https://x.onrender.com', 'loopbackIp', 'http://localhost:3000'],
    ['https://x.onrender.com', 'file', null],
    ['https://x.onrender.com', 'lan', 'https://x.onrender.com'],
  ];
  for (const [meta, page, expected] of rows) {
    const p = pages[page];
    it(`returns ${label(expected)} for meta ${label(meta)} on a ${p.protocol}//${p.hostname || '(no host)'} page`, () => {
      assert.equal(pickServerUrl(meta, { ...p }), expected);
    });
  }
  for (const loc of [null, undefined]) {
    it(`returns null when the page location is ${label(loc)}`, () => {
      assert.equal(pickServerUrl('https://x.onrender.com', loc), null);
    });
  }
});

describe('isLoopbackUrl', () => {
  for (const url of ['http://localhost:3000', 'http://127.0.0.1:3000']) {
    it(`is true for ${label(url)}`, () => assert.equal(isLoopbackUrl(url), true));
  }
  for (const url of ['https://x.onrender.com', 'not a url', null, 42]) {
    it(`is false for ${label(url)}`, () => assert.equal(isLoopbackUrl(url), false));
  }
});

describe('connectBudgetMs', () => {
  it("gives 5000 ms to 'http://localhost:3000'", () => assert.equal(connectBudgetMs('http://localhost:3000'), 5000));
  it("gives 90000 ms to 'https://x.onrender.com'", () => assert.equal(connectBudgetMs('https://x.onrender.com'), 90000));
  it('gives 5000 ms to null', () => assert.equal(connectBudgetMs(null), 5000));
  it('gives 5000 ms to an invalid URL', () => assert.equal(connectBudgetMs('not a url'), 5000));
});

describe('retryDelayWithin', () => {
  const rows = [
    [0, 90000, 3000, 3000],
    [86999, 90000, 3000, 3000],
    [87000, 90000, 3000, null],
    [95000, 90000, 3000, null],
  ];
  for (const [now, deadline, delay, expected] of rows) {
    it(`returns ${label(expected)} for (${now}, ${deadline}, ${delay})`, () => {
      assert.equal(retryDelayWithin(now, deadline, delay), expected);
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
    assert.deepEqual(validateRoomState(roomState({ players: [], hostId: null })).players, []);
  });
  for (const phase of ['waiting', 'countdown', 'racing', 'finished']) {
    it(`accepts phase ${label(phase)}`, () => assert.equal(validateRoomState(roomInPhase(phase)).phase, phase));
  }
  for (const phase of ['lobby', 'WAITING', '', null, 1]) {
    it(`rejects unknown phase ${label(phase)}`, () => assert.equal(validateRoomState(roomState({ phase })), null));
  }
  for (const maxPlayers of [0, 9, 1.5, '2', NaN, null]) {
    it(`rejects maxPlayers ${label(maxPlayers)}`, () => {
      assert.equal(validateRoomState(roomState({ maxPlayers, minPlayers: 1, hostId: null, players: [] })), null);
    });
  }
  it('rejects a players field that is not an array', () => {
    assert.equal(validateRoomState(roomState({ players: {} })), null);
  });
  it('rejects more players than maxPlayers', () => {
    const players = [player(), player({ id: 'p2', slot: 2 })];
    assert.equal(validateRoomState(roomState({ maxPlayers: 1, minPlayers: 1, players })), null);
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
    const id = 'x'.repeat(64);
    assert.notEqual(validateRoomState(roomState({ hostId: id, players: [player({ id })] })), null);
  });
  for (const field of ['connected', 'ready', 'inRace', 'finished']) {
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
  it('labels the other player in a two-player room by slot, "Player 2"', () => {
    assert.equal(labelFor('a', 'me', two), 'Player 2');
  });
  it('labels the slot 1 player "Player 1" whatever the list order', () => {
    assert.equal(labelFor('a', 'me', three), 'Player 1');
  });
  it('labels the slot 3 player "Player 3"', () => assert.equal(labelFor('b', 'me', three), 'Player 3'));
  it('keeps "Player 3" after lower slots have left', () => {
    assert.equal(labelFor('b', 'me', [{ id: 'me', slot: 1 }, { id: 'b', slot: 3 }]), 'Player 3');
  });
  it('falls back to "Player" when players is not an array', () => {
    assert.equal(labelFor('a', 'me', null), 'Player');
  });
  it('falls back to "Player" for an unknown id', () => {
    assert.equal(labelFor('zzz', 'me', three), 'Player');
  });
  it('falls back to "Player" when the entry has no integer slot', () => {
    assert.equal(labelFor('a', 'me', [{ id: 'a', slot: '2' }]), 'Player');
  });
  it('never uses the word "Opponent"', () => {
    for (const id of ['a', 'b', 'zzz']) assert.doesNotMatch(labelFor(id, 'me', three), /Opponent/);
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
  it('tells the player to try again in the UNREACHABLE text', () => {
    assert.match(errorMessage('UNREACHABLE'), /try again/i);
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

/* ======================================================================== */
/* ---------- Milestone M2: lobby and room codes (PLAN.md 5.4, 9) ---------- */
/* ======================================================================== */

const {
  ROOM_CODE_PATTERN,
  ROOM_CODE_FORMAT_MESSAGE,
  SOLO_TIP,
  SIT_OUT_MESSAGE,
  normalizeRoomCode,
  isValidRoomCode,
  roomCodeInputError,
  parseRoomHash,
  buildShareLink,
  spellRoomCode,
  validateRoomAck,
  validateStartAck,
  findSelf,
  isSittingOut,
  readyCount,
  canStartRace,
  startHint,
  isAloneInLobby,
  hostChangeText,
} = mp;

const HINT_ALONE = 'Waiting for at least one more player.';
const HINT_NOT_READY = 'Waiting for at least one more player to press Race again.';
const HINT_RACE_ON = 'A race is on. You can start the next one when it ends.';

/**
 * A validated-shape room for the rule helpers. Slots follow `ids` order; the
 * host is 'h' unless given. `ready`/`inRace` list the ids that have the flag
 * (default: everyone ready, nobody in a race).
 */
function lobby({ phase = 'waiting', hostId = 'h', ids = ['h', 'b'], ready = null, inRace = null, minPlayers = 2 } = {}) {
  const players = ids.map((id, i) => ({
    id,
    slot: i + 1,
    connected: true,
    ready: ready === null ? true : ready.includes(id),
    inRace: inRace === null ? false : inRace.includes(id),
    finished: false,
  }));
  return {
    code: 'K7QM2X', phase, maxPlayers: 4, minPlayers, hostId,
    expiresInMs: phase === 'waiting' ? 600000 : null, players,
  };
}

describe('M2 constants', () => {
  it('ROOM_CODE_PATTERN is a RegExp', () => assert.ok(ROOM_CODE_PATTERN instanceof RegExp));
  it('ROOM_CODE_PATTERN is exactly /^[A-HJKMNP-TV-Z2-9]{6}$/', () => {
    assert.equal(ROOM_CODE_PATTERN.source, '^[A-HJKMNP-TV-Z2-9]{6}$');
    assert.equal(ROOM_CODE_PATTERN.flags, '');
  });
  it('sets roomCodeLength to 6', () => assert.equal(MP_CONSTANTS.roomCodeLength, 6));
  it('uses the 30-character alphabet with no 0, 1, I, L, O or U', () => {
    assert.equal(MP_CONSTANTS.roomCodeAlphabet, 'ABCDEFGHJKMNPQRSTVWXYZ23456789');
    assert.equal(new Set(MP_CONSTANTS.roomCodeAlphabet).size, 30);
    assert.doesNotMatch(MP_CONSTANTS.roomCodeAlphabet, /[01ILOU]/);
  });
  it('agrees with ROOM_CODE_PATTERN for every alphabet character', () => {
    for (const ch of MP_CONSTANTS.roomCodeAlphabet) {
      assert.equal(ROOM_CODE_PATTERN.test(ch.repeat(MP_CONSTANTS.roomCodeLength)), true, ch);
    }
  });
  it('makes ROOM_CODE_PATTERN reject every uppercase letter and digit outside the alphabet', () => {
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') {
      if (MP_CONSTANTS.roomCodeAlphabet.includes(ch)) continue;
      assert.equal(ROOM_CODE_PATTERN.test(ch.repeat(6)), false, ch);
    }
  });
  it('sets lobbyWarningMs to 60000', () => assert.equal(MP_CONSTANTS.lobbyWarningMs, 60000));
  it('sets lobbyWarningMarginMs to 3000', () => assert.equal(MP_CONSTANTS.lobbyWarningMarginMs, 3000));
  it('is still frozen with the M2 fields', () => {
    assert.equal(Object.isFrozen(MP_CONSTANTS), true);
    assert.throws(() => { MP_CONSTANTS.lobbyWarningMs = 1; }, TypeError);
    assert.equal(MP_CONSTANTS.lobbyWarningMs, 60000);
  });
  it('SOLO_TIP is the exact planned text', () => {
    assert.equal(SOLO_TIP, 'Racing alone? Open the invite link in a second tab to try it out.');
  });
  it('SIT_OUT_MESSAGE is the exact planned text', () => {
    assert.equal(SIT_OUT_MESSAGE, "The host started a new race. You'll join the next one.");
  });
  it('ROOM_CODE_FORMAT_MESSAGE is the exact planned text', () => {
    assert.equal(ROOM_CODE_FORMAT_MESSAGE,
      'Room codes have 6 letters and numbers, like K7QM2X. They never use 0, 1, I, L, O or U.');
  });
  it('uses a valid example code in ROOM_CODE_FORMAT_MESSAGE', () => {
    assert.equal(isValidRoomCode(ROOM_CODE_FORMAT_MESSAGE.match(/like (\w+)\./)[1]), true);
  });
});

describe('normalizeRoomCode', () => {
  const rows = [
    [' k7q-m2x ', 'K7QM2X'],
    ['K7 QM 2X', 'K7QM2X'],
    ['k7qm2x', 'K7QM2X'],
    ['K7QM2X', 'K7QM2X'],
    ['\tk7\nqm-2x\u00A0', 'K7QM2X'],
    ['--k-7-q--', 'K7Q'],
    ['', ''],
    ['   ', ''],
    ['k7qm0x', 'K7QM0X'],
  ];
  for (const [input, expected] of rows) {
    it(`turns ${label(input)} into ${label(expected)}`, () => assert.equal(normalizeRoomCode(input), expected));
  }
  for (const value of [null, undefined, 5, {}, ['K7QM2X']]) {
    it(`returns '' for the non-string ${label(value)}`, () => assert.equal(normalizeRoomCode(value), ''));
  }
});

describe('isValidRoomCode', () => {
  it("accepts 'K7QM2X'", () => assert.equal(isValidRoomCode('K7QM2X'), true));
  it("accepts 'AAAAAA' and '999999'", () => {
    assert.equal(isValidRoomCode('AAAAAA'), true);
    assert.equal(isValidRoomCode('999999'), true);
  });
  for (const value of ['k7qm2x', 'K7QM2', 'K7QM2XX', 'K7QM0X', 'K7QMOX', 'K7QM1X', 'K7QMIX', 'K7QMLX',
    'K7QMUX', 'K7Q-M2', 'K7QM2 ', ' K7QM2', '', null, undefined, 123456, ['K7QM2X']]) {
    it(`rejects ${label(value)}`, () => assert.equal(isValidRoomCode(value), false));
  }
});

describe('roomCodeInputError', () => {
  it("asks for a code when the input is ''", () => assert.equal(roomCodeInputError(''), 'Enter a room code.'));
  it('asks for a code when the input is only spaces', () => assert.equal(roomCodeInputError('  '), 'Enter a room code.'));
  it('asks for a code when the input is only hyphens', () => assert.equal(roomCodeInputError('--'), 'Enter a room code.'));
  it('asks for a code for a non-string input', () => assert.equal(roomCodeInputError(null), 'Enter a room code.'));
  it("gives the format message for the short 'k7qm2'", () => {
    assert.equal(roomCodeInputError('k7qm2'), ROOM_CODE_FORMAT_MESSAGE);
  });
  it("gives the format message for 'K7QM0X', which uses a 0", () => {
    assert.equal(roomCodeInputError('K7QM0X'), ROOM_CODE_FORMAT_MESSAGE);
  });
  it("gives the format message for 'k7q'", () => assert.equal(roomCodeInputError('k7q'), ROOM_CODE_FORMAT_MESSAGE));
  it("gives '' for 'k7q-m2x', which normalises to a valid code", () => {
    assert.equal(roomCodeInputError('k7q-m2x'), '');
  });
  it("gives '' for a valid canonical code", () => assert.equal(roomCodeInputError('K7QM2X'), ''));
});

describe('parseRoomHash', () => {
  const valid = [
    ['#room=k7qm2x', 'K7QM2X'],
    ['#room=K7QM2X', 'K7QM2X'],
    ['#room=K7Q-M2X', 'K7QM2X'],
    ['#room=K7Q M2X', 'K7QM2X'],
  ];
  for (const [hash, expected] of valid) {
    it(`reads ${label(hash)} as ${label(expected)}`, () => assert.equal(parseRoomHash(hash), expected));
  }
  for (const hash of ['', '#', '#room=', '#room=K7QM2', '#room=K7QM2X&x=1', '#ROOM=K7QM2X', '#room=<b>',
    '#room=K7QM0X', 'room=K7QM2X', '#room=K7QM2X#', `#room=${'A'.repeat(17)}`, '#xroom=K7QM2X',
    '#room=K7QM2X\n']) {
    it(`returns null for ${label(hash)}`, () => assert.equal(parseRoomHash(hash), null));
  }
  for (const value of [null, undefined, 42, {}]) {
    it(`returns null for the non-string ${label(value)}`, () => assert.equal(parseRoomHash(value), null));
  }
});

describe('buildShareLink', () => {
  const PAGES = 'https://prathambasu03-git.github.io/typing-speed-tester/';
  it('adds #room=CODE to the Pages URL', () => {
    assert.equal(buildShareLink(PAGES, 'K7QM2X'), `${PAGES}#room=K7QM2X`);
  });
  it('replaces an old #room= hash', () => {
    assert.equal(buildShareLink(`${PAGES}#room=AAAAAA`, 'K7QM2X'), `${PAGES}#room=K7QM2X`);
  });
  it('replaces any other old hash', () => {
    assert.equal(buildShareLink(`${PAGES}#top`, 'K7QM2X'), `${PAGES}#room=K7QM2X`);
  });
  it('keeps the path and query of a localhost page', () => {
    assert.equal(buildShareLink('http://localhost:8080/index.html?x=1', 'K7QM2X'),
      'http://localhost:8080/index.html?x=1#room=K7QM2X');
  });
  it('returns null for a file: page', () => assert.equal(buildShareLink('file:///C:/index.html', 'K7QM2X'), null));
  it("returns null for 'not a url'", () => assert.equal(buildShareLink('not a url', 'K7QM2X'), null));
  for (const code of ['k7qm2x', 'K7QM0X', '', null, 'K7QM2X&x=1']) {
    it(`returns null for the invalid code ${label(code)}`, () => assert.equal(buildShareLink(PAGES, code), null));
  }
  it('round-trips through parseRoomHash', () => {
    const link = buildShareLink(PAGES, 'K7QM2X');
    assert.equal(parseRoomHash(new URL(link).hash), 'K7QM2X');
  });
});

describe('spellRoomCode', () => {
  it("spells 'K7QM2X' as 'K 7 Q M 2 X'", () => assert.equal(spellRoomCode('K7QM2X'), 'K 7 Q M 2 X'));
  it("gives '' for ''", () => assert.equal(spellRoomCode(''), ''));
  for (const value of [null, undefined, 42]) {
    it(`gives '' for the non-string ${label(value)}`, () => assert.equal(spellRoomCode(value), ''));
  }
});

describe('findSelf', () => {
  it('returns the player with the given id', () => {
    const room = lobby();
    assert.equal(findSelf(room, 'b'), room.players[1]);
  });
  it('returns null for an id not in the room', () => assert.equal(findSelf(lobby(), 'zzz'), null));
  it('returns null for a null room', () => assert.equal(findSelf(null, 'h'), null));
  it('returns null for a room without a players array', () => assert.equal(findSelf({ players: 'x' }, 'h'), null));
});

describe('isSittingOut', () => {
  it('is true in countdown when self has inRace false', () => {
    assert.equal(isSittingOut(lobby({ phase: 'countdown', ids: ['h', 'b', 'c'], inRace: ['h', 'b'] }), 'c'), true);
  });
  it('is true in racing when self has inRace false', () => {
    assert.equal(isSittingOut(lobby({ phase: 'racing', ids: ['h', 'b', 'c'], inRace: ['h', 'b'] }), 'c'), true);
  });
  it('is false in countdown when self has inRace true', () => {
    assert.equal(isSittingOut(lobby({ phase: 'countdown', ids: ['h', 'b', 'c'], inRace: ['h', 'b'] }), 'b'), false);
  });
  it('is false in finished, even with inRace false', () => {
    assert.equal(isSittingOut(lobby({ phase: 'finished', ids: ['h', 'b', 'c'] }), 'c'), false);
  });
  it('is false in waiting', () => assert.equal(isSittingOut(lobby(), 'b'), false));
  it('is false when self is not in the room', () => {
    assert.equal(isSittingOut(lobby({ phase: 'racing', inRace: ['h', 'b'] }), 'zzz'), false);
  });
  it('is false for a null room', () => assert.equal(isSittingOut(null, 'b'), false));
});

describe('readyCount', () => {
  it('counts every ready player', () => assert.equal(readyCount(lobby({ ids: ['h', 'b', 'c'] }), 'h'), 3));
  it('adds self when self is not ready (the host Start counts as Race again)', () => {
    assert.equal(readyCount(lobby({ phase: 'finished', ids: ['h', 'b', 'c'], ready: ['b'] }), 'h'), 2);
  });
  it('does not add self twice when self is ready', () => {
    assert.equal(readyCount(lobby({ phase: 'finished', ids: ['h', 'b', 'c'], ready: ['h'] }), 'h'), 1);
  });
  it('does not add an id that is not in the room', () => {
    assert.equal(readyCount(lobby({ phase: 'finished', ids: ['h', 'b'], ready: ['b'] }), 'zzz'), 1);
  });
});

describe('canStartRace', () => {
  it('is true for the host with 2 players in waiting', () => assert.equal(canStartRace(lobby(), 'h'), true));
  it('is false for a non-host with 2 players in waiting', () => assert.equal(canStartRace(lobby(), 'b'), false));
  it('is false for the host alone', () => assert.equal(canStartRace(lobby({ ids: ['h'] }), 'h'), false));
  for (const phase of ['countdown', 'racing']) {
    it(`is false in ${phase}`, () => {
      assert.equal(canStartRace(lobby({ phase, inRace: ['h', 'b'] }), 'h'), false);
    });
  }
  it('is true in finished with 3 players when the host and B are ready', () => {
    assert.equal(canStartRace(lobby({ phase: 'finished', ids: ['h', 'b', 'c'], ready: ['h', 'b'] }), 'h'), true);
  });
  it('is true in finished when the host is not ready but B is', () => {
    assert.equal(canStartRace(lobby({ phase: 'finished', ids: ['h', 'b', 'c'], ready: ['b'] }), 'h'), true);
  });
  it('is false in finished when only the host is ready', () => {
    assert.equal(canStartRace(lobby({ phase: 'finished', ids: ['h', 'b', 'c'], ready: ['h'] }), 'h'), false);
  });
  it('is false for a null room', () => assert.equal(canStartRace(null, 'h'), false));
  it('respects minPlayers 3', () => {
    assert.equal(canStartRace(lobby({ minPlayers: 3 }), 'h'), false);
    assert.equal(canStartRace(lobby({ minPlayers: 3, ids: ['h', 'b', 'c'] }), 'h'), true);
  });
});

describe('startHint', () => {
  it('tells the host alone in waiting to wait for one more player', () => {
    assert.equal(startHint(lobby({ ids: ['h'] }), 'h'), HINT_ALONE);
  });
  it('tells the host in finished with only the host ready to wait for Race again', () => {
    assert.equal(startHint(lobby({ phase: 'finished', ids: ['h', 'b', 'c'], ready: ['h'] }), 'h'), HINT_NOT_READY);
  });
  it('tells the host alone in finished to wait for one more player', () => {
    assert.equal(startHint(lobby({ phase: 'finished', ids: ['h'], ready: [] }), 'h'), HINT_ALONE);
  });
  it('tells the host during racing that a race is on', () => {
    assert.equal(startHint(lobby({ phase: 'racing', inRace: ['h', 'b'] }), 'h'), HINT_RACE_ON);
  });
  it('tells the host during countdown that a race is on', () => {
    assert.equal(startHint(lobby({ phase: 'countdown', inRace: ['h', 'b'] }), 'h'), HINT_RACE_ON);
  });
  it("gives '' when the host can start", () => assert.equal(startHint(lobby(), 'h'), ''));
  it("gives '' to a non-host, even when the room cannot start", () => {
    assert.equal(startHint(lobby({ phase: 'finished', ids: ['h', 'b', 'c'], ready: ['h'] }), 'b'), '');
  });
  it("gives '' for a null room", () => assert.equal(startHint(null, 'h'), ''));
});

describe('isAloneInLobby', () => {
  it('is true in waiting with 1 player', () => assert.equal(isAloneInLobby(lobby({ ids: ['h'] })), true));
  it('is false in waiting with 2 players', () => assert.equal(isAloneInLobby(lobby()), false));
  it('is false in finished with 1 player', () => {
    assert.equal(isAloneInLobby(lobby({ phase: 'finished', ids: ['h'] })), false);
  });
  it('is false for a null room', () => assert.equal(isAloneInLobby(null), false));
});

describe('hostChangeText', () => {
  // The old host 'a' left; 'me' (slot 2) or 'c' (slot 3) takes over.
  const prev = lobby({ hostId: 'a', ids: ['a', 'me', 'c'] });

  it("gives '' when prev is null", () => {
    assert.equal(hostChangeText(null, lobby({ hostId: 'me', ids: ['me', 'c'] }), 'me', 'waiting'), '');
  });
  it("gives '' when the host is the same", () => assert.equal(hostChangeText(prev, prev, 'me', 'waiting'), ''));
  it("gives '' when the new hostId is null", () => {
    assert.equal(hostChangeText(prev, lobby({ hostId: null, ids: [] }), 'me', 'waiting'), '');
  });
  it('tells a new host in client waiting with 2 players that they can start', () => {
    assert.equal(hostChangeText(prev, lobby({ hostId: 'me', ids: ['me', 'c'] }), 'me', 'waiting'),
      'You are now the host. You can start the race.');
  });
  it('tells a new host alone in client waiting to wait for one more player', () => {
    assert.equal(hostChangeText(prev, lobby({ hostId: 'me', ids: ['me'] }), 'me', 'waiting'),
      'You are now the host. Waiting for at least one more player.');
  });
  it('tells a new host in client waiting with too few ready to wait for Race again', () => {
    const room = lobby({ phase: 'finished', hostId: 'me', ids: ['me', 'c', 'd'], ready: ['me'] });
    assert.equal(hostChangeText(prev, room, 'me', 'waiting'),
      'You are now the host. Waiting for at least one more player to press Race again.');
  });
  it('tells a new host in client finished to press Race again, then Start race', () => {
    const room = lobby({ phase: 'finished', hostId: 'me', ids: ['me', 'c'], ready: [] });
    assert.equal(hostChangeText(prev, room, 'me', 'finished'), 'You are now the host. Press Race again, then Start race.');
  });
  it('tells a new host in client running only that they are the host', () => {
    const room = lobby({ phase: 'racing', hostId: 'me', ids: ['me', 'c'], inRace: ['me', 'c'] });
    assert.equal(hostChangeText(prev, room, 'me', 'running'), 'You are now the host.');
  });
  it('tells a new host in client countdown only that they are the host', () => {
    const room = lobby({ phase: 'countdown', hostId: 'me', ids: ['me', 'c'], inRace: ['me', 'c'] });
    assert.equal(hostChangeText(prev, room, 'me', 'countdown'), 'You are now the host.');
  });
  it('tells a sitting-out new host they can start the next race when this one ends', () => {
    const room = lobby({ phase: 'racing', hostId: 'me', ids: ['me', 'c', 'd'], inRace: ['c', 'd'] });
    assert.equal(hostChangeText(prev, room, 'me', 'waiting'),
      'You are now the host. You can start the next race when this one ends.');
  });
  for (const clientPhase of ['waiting', 'finished']) {
    it(`tells others in client ${clientPhase} that "Player 3 is now the host."`, () => {
      const room = lobby({ hostId: 'c', ids: ['x', 'me', 'c'] }); // c is slot 3
      assert.equal(hostChangeText(prev, room, 'me', clientPhase), 'Player 3 is now the host.');
    });
  }
  for (const clientPhase of ['running', 'countdown']) {
    it(`says nothing to others in client ${clientPhase}`, () => {
      const room = lobby({ phase: 'racing', hostId: 'c', ids: ['x', 'me', 'c'], inRace: ['x', 'me', 'c'] });
      assert.equal(hostChangeText(prev, room, 'me', clientPhase), '');
    });
  }
});

describe('validateRoomState (M2 fields)', () => {
  it('accepts a full M2 snapshot and returns every field', () => {
    const input = roomState({ maxPlayers: 4, players: [player(), player({ id: 'p2', slot: 3 })] });
    assert.deepEqual(validateRoomState(input), input);
  });
  it('accepts expiresInMs null in waiting', () => {
    assert.equal(validateRoomState(roomState({ expiresInMs: null })).expiresInMs, null);
  });
  it('accepts expiresInMs 0 and 3600000', () => {
    assert.notEqual(validateRoomState(roomState({ expiresInMs: 0 })), null);
    assert.notEqual(validateRoomState(roomState({ expiresInMs: 3600000 })), null);
  });
  it('accepts inRace true in racing', () => {
    const out = validateRoomState(roomInPhase('racing', { players: [player({ inRace: true }), player({ id: 'p2', slot: 2 })] }));
    assert.equal(out.players[0].inRace, true);
  });
  it('accepts hostId null with no players', () => {
    assert.notEqual(validateRoomState(roomState({ hostId: null, players: [] })), null);
  });
  it('accepts minPlayers equal to maxPlayers', () => {
    assert.notEqual(validateRoomState(roomState({ minPlayers: 2, maxPlayers: 2 })), null);
  });
  it('rejects a missing code', () => {
    const input = roomState();
    delete input.code;
    assert.equal(validateRoomState(input), null);
  });
  for (const code of ['k7qm2x', 'K7QM0X', 'K7QM2', '', null, 123456, '<b>xx</b>']) {
    it(`rejects the bad code ${label(code)}`, () => assert.equal(validateRoomState(roomState({ code })), null));
  }
  it('rejects a hostId that is not among the players', () => {
    assert.equal(validateRoomState(roomState({ hostId: 'p9' })), null);
  });
  it('rejects hostId null while there are players', () => {
    assert.equal(validateRoomState(roomState({ hostId: null })), null);
  });
  it('rejects a missing hostId', () => {
    const input = roomState();
    delete input.hostId;
    assert.equal(validateRoomState(input), null);
  });
  it('rejects minPlayers above maxPlayers', () => {
    assert.equal(validateRoomState(roomState({ minPlayers: 3, maxPlayers: 2 })), null);
  });
  for (const minPlayers of [0, 1.5, '2', null, undefined]) {
    it(`rejects minPlayers ${label(minPlayers)}`, () => {
      assert.equal(validateRoomState(roomState({ minPlayers })), null);
    });
  }
  for (const expiresInMs of [-1, 3600001, 1.5, '600000', NaN, Infinity, undefined]) {
    it(`rejects expiresInMs ${label(expiresInMs)}`, () => {
      assert.equal(validateRoomState(roomState({ expiresInMs })), null);
    });
  }
  for (const phase of ['countdown', 'racing', 'finished']) {
    it(`rejects a non-null expiresInMs in ${phase}`, () => {
      assert.equal(validateRoomState(roomState({ phase, expiresInMs: 600000 })), null);
    });
  }
  it('rejects a player without inRace', () => {
    const p = player();
    delete p.inRace;
    assert.equal(validateRoomState(roomState({ players: [p] })), null);
  });
  it('rejects a player with inRace true while the room is waiting', () => {
    assert.equal(validateRoomState(roomState({ players: [player(), player({ id: 'p2', slot: 2, inRace: true })] })), null);
  });
});

describe('validateJoinAck (create and join)', () => {
  it('accepts a room:create success ack: one player who is host, with a lobby timer', () => {
    const ack = { ok: true, playerId: 'p1', room: roomState({ maxPlayers: 4, players: [player()] }) };
    assert.deepEqual(validateJoinAck(ack), ack);
  });
  it('accepts a room:join success ack into a finished room (joiner ready, not in race)', () => {
    const room = roomInPhase('finished', {
      maxPlayers: 4,
      players: [player({ ready: false }), player({ id: 'p2', slot: 2, ready: false }), player({ id: 'p3', slot: 3 })],
    });
    const ack = { ok: true, playerId: 'p3', room };
    assert.deepEqual(validateJoinAck(ack), ack);
  });
  for (const code of ['BAD_CODE', 'ROOM_NOT_FOUND', 'ROOM_FULL', 'RACE_IN_PROGRESS', 'TOO_MANY_ROOMS']) {
    it(`reduces a ${code} failure to its code`, () => {
      assert.deepEqual(validateJoinAck({ ok: false, error: { code, message: 'x' } }), { ok: false, error: { code } });
    });
  }
  it('rejects a success ack whose room has a bad code', () => {
    assert.equal(validateJoinAck(joinAck({ room: roomState({ code: 'bad' }) })), null);
  });
  it('rejects a success ack whose room lacks M2 fields', () => {
    const room = roomState();
    delete room.minPlayers;
    assert.equal(validateJoinAck(joinAck({ room })), null);
  });
  it('rejects a playerId over 64 characters', () => {
    assert.equal(validateJoinAck(joinAck({ playerId: 'x'.repeat(65) })), null);
  });
});

describe('validateRoomAck', () => {
  const roomAck = (overrides = {}) => ({ ok: true, room: roomState(), ...overrides });
  commonValidatorChecks(validateRoomAck, roomAck);

  it('is the same function as validateRematchAck', () => assert.equal(validateRematchAck, validateRoomAck));
  it('reduces a NOT_WAITING failure to its code', () => {
    assert.deepEqual(validateRoomAck({ ok: false, error: { code: 'NOT_WAITING', message: 'x' } }),
      { ok: false, error: { code: 'NOT_WAITING' } });
  });
  it('rejects a success ack with no room', () => assert.equal(validateRoomAck({ ok: true }), null));
  it('rejects a success ack with an invalid room', () => {
    assert.equal(validateRoomAck(roomAck({ room: roomState({ hostId: 'nobody' }) })), null);
  });
  it('rejects a failure ack with no error object', () => assert.equal(validateRoomAck({ ok: false }), null));
  it('rejects a non-boolean ok', () => assert.equal(validateRoomAck(roomAck({ ok: 'yes' })), null));
  it('copies the nested room', () => {
    const input = roomAck();
    assert.notStrictEqual(validateRoomAck(input).room, input.room);
  });
});

describe('validateStartAck', () => {
  commonValidatorChecks(validateStartAck, () => ({ ok: true }));

  it('drops a room from a success ack', () => {
    assert.deepEqual(validateStartAck({ ok: true, room: roomState() }), { ok: true });
  });
  for (const code of ['NOT_HOST', 'NOT_ENOUGH_PLAYERS', 'PLAYERS_NOT_READY', 'RACE_IN_PROGRESS']) {
    it(`reduces a ${code} failure to its code`, () => {
      assert.deepEqual(validateStartAck({ ok: false, error: { code, message: 'm' } }), { ok: false, error: { code } });
    });
  }
  it('rejects a failure ack with no error object', () => assert.equal(validateStartAck({ ok: false }), null));
  it('rejects a failure ack with a non-string code', () => {
    assert.equal(validateStartAck({ ok: false, error: { code: 1 } }), null);
  });
  it('rejects a non-boolean ok', () => assert.equal(validateStartAck({ ok: 1 }), null));
});

describe('errorMessage (M2 codes)', () => {
  const fallback = errorMessage('NO_SUCH_CODE');
  const expected = {
    BAD_CODE: ROOM_CODE_FORMAT_MESSAGE,
    ROOM_NOT_FOUND: 'No room has that code. Check it, or ask for a new link: rooms close when everyone leaves.',
    ROOM_FULL: 'That room is full (4 players). Ask the host for a new room or try another code.',
    RACE_IN_PROGRESS: 'That room is in a race right now. Try again when it ends.',
    TOO_MANY_ROOMS: 'The game server is busy. Try again in a few minutes.',
    NOT_HOST: 'Only the host can start the race.',
    NOT_ENOUGH_PLAYERS: 'You need at least 2 players to start.',
    PLAYERS_NOT_READY: 'At least one more player needs to press Race again before you can start.',
    NOT_WAITING: 'The room is not waiting for a race.',
    ROOM_EXPIRED: 'The room closed because no race started for 10 minutes. You are playing solo.',
  };
  for (const [code, text] of Object.entries(expected)) {
    it(`gives ${code} the planned text`, () => assert.equal(errorMessage(code), text));
  }
  it('gives every M2 code its own text, distinct from the default and from each other', () => {
    const texts = Object.keys(expected).map(errorMessage);
    assert.ok(!texts.includes(fallback));
    assert.equal(new Set(texts).size, texts.length);
  });
  it('tells the player they are solo after ROOM_EXPIRED', () => assert.match(errorMessage('ROOM_EXPIRED'), /solo/i));
});
