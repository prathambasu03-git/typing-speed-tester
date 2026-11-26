'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isPlainObject,
  validateCreate,
  validateJoin,
  validateStart,
  validateExtend,
  validateRematch,
  validateProgress,
} = require('../src/validate');

function assertBad(result, label) {
  assert.equal(result.ok, false, label);
  assert.equal(result.code, 'BAD_PAYLOAD', label);
  assert.equal(typeof result.message, 'string', label);
}

test('isPlainObject accepts objects and rejects null, arrays and primitives', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject({ a: 1 }), true);
  for (const value of [null, undefined, [], 'x', 1, true, () => {}]) {
    assert.equal(isPlainObject(value), false, `value ${String(value)}`);
  }
});

test('validateProgress accepts a one-key event', () => {
  assert.deepEqual(validateProgress({ seq: 1, keys: 'a' }), { ok: true, value: { seq: 1, keys: 'a' } });
});

test('validateProgress accepts the largest seq and a 64-unit keys string', () => {
  const keys = 'a'.repeat(64);
  assert.deepEqual(validateProgress({ seq: 2147483647, keys }), { ok: true, value: { seq: 2147483647, keys } });
});

test('validateProgress accepts a Backspace inside keys', () => {
  assert.equal(validateProgress({ seq: 3, keys: 'ab\bc' }).ok, true);
});

test('validateProgress accepts non-ASCII text such as an accent and an emoji', () => {
  assert.equal(validateProgress({ seq: 1, keys: 'é😀' }).ok, true);
});

test('validateProgress drops client-sent scores and flags from the value', () => {
  const result = validateProgress({ seq: 1, keys: 'a', wpm: 999, finished: true, timeMs: 1 });
  assert.deepEqual(result, { ok: true, value: { seq: 1, keys: 'a' } });
});

test('validateProgress rejects payloads that are not plain objects', () => {
  for (const payload of [null, undefined, [], 'x', 1, true]) assertBad(validateProgress(payload), String(payload));
});

test('validateProgress rejects an object with missing fields', () => {
  assertBad(validateProgress({}));
  assertBad(validateProgress({ seq: 1 }));
  assertBad(validateProgress({ keys: 'a' }));
});

test('validateProgress rejects a seq that is not an integer in 1..SEQ_MAX', () => {
  for (const seq of [0, -1, 1.5, '1', 2147483648, NaN, Infinity, null, true]) {
    assertBad(validateProgress({ seq, keys: 'a' }), `seq ${String(seq)}`);
  }
});

test('validateProgress rejects keys that are empty, 65 units long or not a string', () => {
  for (const keys of ['', 'a'.repeat(65), 123, null, ['a'], { 0: 'a' }]) {
    assertBad(validateProgress({ seq: 1, keys }), `keys ${JSON.stringify(keys)}`);
  }
});

test('validateProgress rejects a huge keys string', () => {
  assertBad(validateProgress({ seq: 1, keys: 'a'.repeat(100000) }));
});

test('validateProgress rejects control characters other than Backspace', () => {
  for (const keys of ['a\nb', 'a\u0000', '\u007f', '\t', '\r', '\u0007', '\u001b', '\u0085', '\u009f']) {
    assertBad(validateProgress({ seq: 1, keys }), JSON.stringify(keys));
  }
});

test('validateProgress rejects a lone surrogate', () => {
  assertBad(validateProgress({ seq: 1, keys: '\ud800' }));
  assertBad(validateProgress({ seq: 1, keys: 'a\udc00' }));
});

const EMPTY_PAYLOAD_VALIDATORS = [validateCreate, validateStart, validateExtend, validateRematch];

test('validateCreate, validateStart, validateExtend and validateRematch accept an empty object and undefined', () => {
  for (const fn of EMPTY_PAYLOAD_VALIDATORS) {
    assert.deepEqual(fn({}), { ok: true, value: {} }, fn.name);
    assert.deepEqual(fn(undefined), { ok: true, value: {} }, fn.name);
  }
});

test('the empty-payload validators ignore extra fields', () => {
  for (const fn of EMPTY_PAYLOAD_VALIDATORS) {
    assert.deepEqual(fn({ ready: false, code: 'K7QM2X' }), { ok: true, value: {} }, fn.name);
  }
});

test('the empty-payload validators reject null, arrays, strings and numbers', () => {
  for (const fn of EMPTY_PAYLOAD_VALIDATORS) {
    for (const payload of [null, [], 'x', 1, true]) assertBad(fn(payload), `${fn.name} ${JSON.stringify(payload)}`);
  }
});

test('validateJoin accepts a canonical code and returns only the code', () => {
  assert.deepEqual(validateJoin({ code: 'K7QM2X' }), { ok: true, value: { code: 'K7QM2X' } });
  assert.deepEqual(validateJoin({ code: 'K7QM2X', name: 'x' }), { ok: true, value: { code: 'K7QM2X' } });
});

test('validateJoin checks only the shape, so a short or lowercase code passes', () => {
  assert.deepEqual(validateJoin({ code: 'x' }), { ok: true, value: { code: 'x' } });
  assert.deepEqual(validateJoin({ code: 'k7qm2x' }), { ok: true, value: { code: 'k7qm2x' } });
});

test('validateJoin accepts a 16-character code and rejects a 17-character one', () => {
  assert.equal(validateJoin({ code: 'a'.repeat(16) }).ok, true);
  assertBad(validateJoin({ code: 'a'.repeat(17) }));
});

test('validateJoin rejects a missing, empty, non-string or huge code', () => {
  for (const payload of [{}, { code: '' }, { code: 123 }, { code: null }, { code: ['K7QM2X'] }, { code: 'A'.repeat(100000) }]) {
    assertBad(validateJoin(payload), JSON.stringify(payload).slice(0, 40));
  }
});

test('validateJoin rejects payloads that are not plain objects', () => {
  for (const payload of [null, [], undefined, 'K7QM2X', 1, true]) assertBad(validateJoin(payload), String(payload));
});
