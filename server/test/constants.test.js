'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const constants = require('../src/constants');

test('the default countdown before a race is 3000 ms', () => {
  assert.equal(constants.COUNTDOWN_MS, 3000);
});

test('the protocol constants match PROTOCOL.md section 2', () => {
  assert.equal(constants.ROOM_ID, 'main');
  assert.equal(constants.MAX_PLAYERS, 2);
  assert.equal(constants.MIN_PLAYERS, 2);
  assert.equal(constants.RACE_TIME_LIMIT_MS, 120000);
  assert.equal(constants.PASSAGE_WORD_COUNT, 30);
  assert.equal(constants.PASSAGE_MAX_LENGTH, 1000);
  assert.equal(constants.MAX_KEYS_PER_EVENT, 64);
  assert.equal(constants.BROADCAST_INTERVAL_MS, 200);
  assert.equal(constants.RATE_LIMIT_CAPACITY, 20);
  assert.equal(constants.RATE_LIMIT_REFILL_PER_SEC, 10);
  assert.equal(constants.RATE_LIMIT_ERROR_INTERVAL_MS, 1000);
  assert.equal(constants.SEQ_MAX, 2147483647);
  assert.equal(constants.BACKSPACE, '\u0008');
  assert.equal(constants.MAX_HTTP_BUFFER_SIZE, 4096);
  assert.equal(constants.REMATCH_TIMEOUT_MS, 60000);
  assert.equal(constants.JOIN_TIMEOUT_MS, 10000);
});

test('the error codes list every code in PROTOCOL.md section 7', () => {
  assert.deepEqual(Object.keys(constants.ERROR_CODES).sort(), [
    'ALREADY_JOINED',
    'BAD_PAYLOAD',
    'IDLE_TIMEOUT',
    'INTERNAL',
    'NOT_FINISHED',
    'NOT_IN_ROOM',
    'RACE_IN_PROGRESS',
    'RATE_LIMITED',
    'ROOM_FULL',
  ]);
  for (const [key, value] of Object.entries(constants.ERROR_CODES)) assert.equal(key, value);
});

test('the constants and error codes are frozen', () => {
  assert.ok(Object.isFrozen(constants));
  assert.ok(Object.isFrozen(constants.ERROR_CODES));
});
