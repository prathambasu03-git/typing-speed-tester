'use strict';

/* Room codes (PROTOCOL.md sections 2 and 4). Pure: the random source is
   injected, so tests can drive it; the default is crypto.randomInt, which is
   uniform (no modulo bias) and cryptographically random, so codes cannot be
   predicted from earlier ones. */

const { randomInt: cryptoRandomInt } = require('node:crypto');
const { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, ROOM_CODE_MAX_ATTEMPTS } = require('./constants');

// Must accept exactly the characters of ROOM_CODE_ALPHABET (a test checks it).
const ROOM_CODE_PATTERN = /^[A-HJKMNP-TV-Z2-9]{6}$/;

/** Canonical form only: the server never normalises (the client does). */
function isValidRoomCode(value) {
  return typeof value === 'string' && ROOM_CODE_PATTERN.test(value);
}

function generateRoomCode(randomInt = cryptoRandomInt) {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    code += ROOM_CODE_ALPHABET[randomInt(0, ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

/** A code for which isTaken(code) is false, or null after maxAttempts taken codes. */
function createUniqueCode(isTaken, randomInt = cryptoRandomInt, maxAttempts = ROOM_CODE_MAX_ATTEMPTS) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const code = generateRoomCode(randomInt);
    if (!isTaken(code)) return code;
  }
  return null;
}

module.exports = { ROOM_CODE_ALPHABET, ROOM_CODE_PATTERN, isValidRoomCode, generateRoomCode, createUniqueCode };
