'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const constants = require('../src/constants');

test('the default countdown before a race is 3000 ms', () => {
  assert.equal(constants.COUNTDOWN_MS, 3000);
});

test('the protocol constants match PROTOCOL.md section 2', () => {
  assert.equal(constants.MAX_PLAYERS, 4);
  assert.equal(constants.MIN_PLAYERS, 2);
  assert.equal(constants.MAX_ROOMS, 200);
  assert.equal(constants.ROOM_CODE_LENGTH, 6);
  assert.equal(constants.ROOM_CODE_ALPHABET, 'ABCDEFGHJKMNPQRSTVWXYZ23456789');
  assert.equal(constants.ROOM_CODE_INPUT_MAX, 16);
  assert.equal(constants.ROOM_CODE_MAX_ATTEMPTS, 10);
  assert.equal(constants.LOBBY_TIMEOUT_MS, 600000);
  assert.equal(constants.CREATE_LIMIT_CAPACITY, 3);
  assert.equal(constants.CREATE_LIMIT_REFILL_PER_SEC, 0.05);
  assert.equal(constants.JOIN_FAIL_LIMIT_CAPACITY, 10);
  assert.equal(constants.JOIN_FAIL_LIMIT_REFILL_PER_SEC, 1 / 6);
  assert.equal(constants.IP_LIMIT_MAX_ENTRIES, 10000);
  assert.equal(constants.IP_LIMIT_SWEEP_MS, 60000);
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

test('the single shared room id from M1 is gone', () => {
  assert.equal('ROOM_ID' in constants, false);
});

test('the error codes list every code in PROTOCOL.md section 7', () => {
  assert.deepEqual(Object.keys(constants.ERROR_CODES).sort(), [
    'ALREADY_JOINED',
    'BAD_CODE',
    'BAD_PAYLOAD',
    'IDLE_TIMEOUT',
    'INTERNAL',
    'NOT_ENOUGH_PLAYERS',
    'NOT_FINISHED',
    'NOT_HOST',
    'NOT_IN_ROOM',
    'NOT_WAITING',
    'PLAYERS_NOT_READY',
    'RACE_IN_PROGRESS',
    'RATE_LIMITED',
    'ROOM_EXPIRED',
    'ROOM_FULL',
    'ROOM_NOT_FOUND',
    'TOO_MANY_ROOMS',
  ]);
  for (const [key, value] of Object.entries(constants.ERROR_CODES)) assert.equal(key, value);
});

test('the constants and error codes are frozen', () => {
  assert.ok(Object.isFrozen(constants));
  assert.ok(Object.isFrozen(constants.ERROR_CODES));
});
