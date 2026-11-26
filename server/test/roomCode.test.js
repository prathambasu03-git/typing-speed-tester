'use strict';

/* Room codes (server/src/roomCode.js): alphabet, generation with injected
   randomness, the canonical-form check and collision retries. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomInt } = require('node:crypto');
const {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_PATTERN,
  isValidRoomCode,
  generateRoomCode,
  createUniqueCode,
} = require('../src/roomCode');
const constants = require('../src/constants');

/** A randomInt stub that returns the given indexes in order, then repeats the last. */
function sequence(values) {
  let i = 0;
  return (min, max) => {
    assert.equal(min, 0);
    assert.equal(max, 30);
    const value = values[Math.min(i, values.length - 1)];
    i += 1;
    return value;
  };
}

test('the alphabet has 30 unique characters', () => {
  assert.equal(ROOM_CODE_ALPHABET.length, 30);
  assert.equal(new Set(ROOM_CODE_ALPHABET).size, 30);
});

test('the alphabet leaves out 0, 1, I, L, O and U', () => {
  for (const ch of '01ILOU') assert.ok(!ROOM_CODE_ALPHABET.includes(ch), ch);
});

test('every alphabet character matches the code pattern character class', () => {
  for (const ch of ROOM_CODE_ALPHABET) assert.match(ch, /^[A-HJKMNP-TV-Z2-9]$/, ch);
});

test('the pattern accepts exactly the alphabet: no other printable ASCII character', () => {
  for (let code = 32; code < 127; code += 1) {
    const ch = String.fromCharCode(code);
    assert.equal(ROOM_CODE_PATTERN.test(ch.repeat(6)), ROOM_CODE_ALPHABET.includes(ch), JSON.stringify(ch));
  }
});

test('the module alphabet is the one in constants', () => {
  assert.equal(ROOM_CODE_ALPHABET, constants.ROOM_CODE_ALPHABET);
});

test('generateRoomCode with randomInt always 0 gives AAAAAA', () => {
  assert.equal(generateRoomCode(() => 0), 'AAAAAA');
});

test('generateRoomCode with randomInt always 29 gives 999999', () => {
  assert.equal(generateRoomCode(() => 29), '999999');
});

test('generateRoomCode asks randomInt for an index in 0..30 once per character', () => {
  const calls = [];
  generateRoomCode((min, max) => {
    calls.push([min, max]);
    return 0;
  });
  assert.deepEqual(calls, Array(6).fill([0, 30]));
});

test('1000 codes from crypto.randomInt are all valid', () => {
  for (let i = 0; i < 1000; i += 1) {
    const code = generateRoomCode();
    assert.ok(isValidRoomCode(code), code);
  }
});

test('the default generator is crypto.randomInt-shaped and gives valid codes', () => {
  assert.ok(isValidRoomCode(generateRoomCode(randomInt)));
});

test('isValidRoomCode accepts a canonical code', () => {
  assert.equal(isValidRoomCode('K7QM2X'), true);
});

test('isValidRoomCode rejects lowercase, wrong length, forbidden characters and non-strings', () => {
  for (const value of ['k7qm2x', 'K7QM2', 'K7QM2XX', 'K7QM0X', 'K7QMOX', 'K7Q-M2', 'K7QM2 ', ' K7QM2X', '', null, undefined, 123456, ['K7QM2X']]) {
    assert.equal(isValidRoomCode(value), false, JSON.stringify(value));
  }
});

test('createUniqueCode skips a taken code and returns the next free one', () => {
  // First code AAAAAA (taken), second code BBBBBB (free).
  const rand = sequence([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
  const seen = [];
  const code = createUniqueCode((c) => {
    seen.push(c);
    return c === 'AAAAAA';
  }, rand);
  assert.equal(code, 'BBBBBB');
  assert.deepEqual(seen, ['AAAAAA', 'BBBBBB']);
});

test('createUniqueCode returns null after exactly 10 taken codes', () => {
  let calls = 0;
  const code = createUniqueCode(() => {
    calls += 1;
    return true;
  }, () => 0);
  assert.equal(code, null);
  assert.equal(calls, 10);
});

test('createUniqueCode honours a custom maximum number of attempts', () => {
  let calls = 0;
  assert.equal(createUniqueCode(() => (calls += 1) > 0, () => 0, 3), null);
  assert.equal(calls, 3);
});

test('createUniqueCode uses crypto randomness by default', () => {
  assert.ok(isValidRoomCode(createUniqueCode(() => false)));
});
