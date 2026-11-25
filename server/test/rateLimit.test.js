'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBucket, takeToken } = require('../src/rateLimit');

test('a new bucket allows 20 takes at once and refuses the 21st', () => {
  const bucket = createBucket(20, 10, 0);
  for (let i = 0; i < 20; i += 1) assert.equal(takeToken(bucket, 0), true, `take ${i + 1}`);
  assert.equal(takeToken(bucket, 0), false);
});

test('an empty bucket allows one more take after 100 ms at 10 per second', () => {
  const bucket = createBucket(20, 10, 0);
  for (let i = 0; i < 20; i += 1) takeToken(bucket, 0);
  assert.equal(takeToken(bucket, 50), false);
  assert.equal(takeToken(bucket, 100), true);
  assert.equal(takeToken(bucket, 100), false);
});

test('a bucket never holds more than its capacity after a long idle', () => {
  const bucket = createBucket(20, 10, 0);
  takeToken(bucket, 0);
  let allowed = 0;
  while (takeToken(bucket, 1e9)) allowed += 1;
  assert.equal(allowed, 20);
});

test('a bucket with zero refill never refills', () => {
  const bucket = createBucket(3, 0, 0);
  for (let i = 0; i < 3; i += 1) assert.equal(takeToken(bucket, 0), true);
  assert.equal(takeToken(bucket, 1e9), false);
});

test('a clock that goes backwards does not refill the bucket', () => {
  const bucket = createBucket(2, 10, 1000);
  assert.equal(takeToken(bucket, 500), true);
  assert.equal(takeToken(bucket, 500), true);
  assert.equal(takeToken(bucket, 400), false);
});
