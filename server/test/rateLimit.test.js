'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBucket, refill, takeToken } = require('../src/rateLimit');

test('refill alone never takes a token and never exceeds capacity', () => {
  const bucket = createBucket(3, 1, 0);
  refill(bucket, 0);
  assert.equal(bucket.tokens, 3);
  refill(bucket, 1e9);
  assert.equal(bucket.tokens, 3);
});

test('refill adds the tokens earned since the last update', () => {
  const bucket = createBucket(3, 0.05, 0);
  for (let i = 0; i < 3; i += 1) takeToken(bucket, 0);
  refill(bucket, 10000);
  assert.equal(bucket.tokens, 0.5);
  refill(bucket, 20000);
  assert.equal(bucket.tokens, 1);
  assert.equal(bucket.updatedAt, 20000);
});

test('refill with a clock that goes backwards adds nothing', () => {
  const bucket = createBucket(2, 10, 1000);
  takeToken(bucket, 1000);
  refill(bucket, 500);
  assert.equal(bucket.tokens, 1);
});

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
