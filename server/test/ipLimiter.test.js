'use strict';

/* Per-IP token buckets (server/src/ipLimiter.js). Fake `now` values; the
   limiter has no timers. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createIpLimiter } = require('../src/ipLimiter');

const IP = '203.0.113.1';
const OTHER = '203.0.113.2';

function createLimit(extra = {}) {
  return createIpLimiter({ capacity: 3, refillPerSec: 0.05, ...extra });
}

test('three consumes pass, the fourth fails and one more passes 20 s later', () => {
  const limiter = createLimit();
  for (let i = 0; i < 3; i += 1) assert.equal(limiter.consume(IP, 0), true, `consume ${i + 1}`);
  assert.equal(limiter.consume(IP, 0), false);
  assert.equal(limiter.consume(IP, 19999), false);
  assert.equal(limiter.consume(IP, 20000), true);
  assert.equal(limiter.consume(IP, 20000), false);
});

test('an unknown IP counts as a full bucket and has is true', () => {
  const limiter = createLimit();
  assert.equal(limiter.has(IP, 0), true);
  assert.equal(limiter.size(), 0, 'has does not create a bucket');
});

test('has never takes a token', () => {
  const limiter = createLimit();
  limiter.consume(IP, 0);
  limiter.consume(IP, 0);
  for (let i = 0; i < 10; i += 1) assert.equal(limiter.has(IP, 0), true);
  assert.equal(limiter.consume(IP, 0), true);
  assert.equal(limiter.has(IP, 0), false);
});

test('has turns true again once the bucket refills one token', () => {
  const limiter = createLimit();
  for (let i = 0; i < 3; i += 1) limiter.consume(IP, 0);
  assert.equal(limiter.has(IP, 10000), false);
  assert.equal(limiter.has(IP, 20000), true);
});

test('IPs have independent buckets', () => {
  const limiter = createLimit();
  for (let i = 0; i < 3; i += 1) limiter.consume(IP, 0);
  assert.equal(limiter.consume(IP, 0), false);
  assert.equal(limiter.has(OTHER, 0), true);
  assert.equal(limiter.consume(OTHER, 0), true);
});

test('sweep removes buckets that have refilled to capacity and keeps the rest', () => {
  const limiter = createLimit();
  limiter.consume(IP, 0); // needs 20 s to refill
  for (let i = 0; i < 3; i += 1) limiter.consume(OTHER, 0); // needs 60 s
  assert.equal(limiter.size(), 2);
  limiter.sweep(20000);
  assert.equal(limiter.size(), 1);
  limiter.sweep(60000);
  assert.equal(limiter.size(), 0);
});

test('a swept IP starts again with a full bucket', () => {
  const limiter = createLimit();
  for (let i = 0; i < 3; i += 1) limiter.consume(IP, 0);
  limiter.sweep(60000);
  for (let i = 0; i < 3; i += 1) assert.equal(limiter.consume(IP, 60000), true);
  assert.equal(limiter.consume(IP, 60000), false);
});

test('has and consume sweep lazily once the sweep interval has passed', () => {
  const limiter = createLimit({ sweepIntervalMs: 1000 });
  limiter.consume(IP, 0);
  limiter.consume(OTHER, 0);
  assert.equal(limiter.size(), 2);
  // 20 s later both buckets are full again; the next call sweeps them.
  assert.equal(limiter.has('198.51.100.7', 20000), true);
  assert.equal(limiter.size(), 0);
});

test('with maxEntries 2 a third IP is allowed untracked when nothing can be swept', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const limiter = createLimit({ maxEntries: 2 });
  limiter.consume(IP, 0);
  limiter.consume(OTHER, 0);
  assert.equal(limiter.consume('198.51.100.7', 0), true);
  assert.equal(limiter.size(), 2);
  assert.equal(limiter.has('198.51.100.7', 0), true);
  assert.equal(warn.mock.callCount(), 1);
});

test('a full table warns at most once per sweep interval', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const limiter = createIpLimiter({ capacity: 3, refillPerSec: 0, maxEntries: 1, sweepIntervalMs: 1000 });
  limiter.consume(IP, 0);
  for (let i = 0; i < 5; i += 1) limiter.consume(`198.51.100.${i}`, 10);
  assert.equal(warn.mock.callCount(), 1);
  limiter.consume('198.51.100.99', 2000);
  assert.equal(warn.mock.callCount(), 2);
});

test('a full table forces a sweep for a new IP at most once per forcedSweepMinMs', (t) => {
  t.mock.method(console, 'warn', () => {});
  // capacity 1 at 10 per second: a used bucket is full again after 100 ms.
  const limiter = createIpLimiter({ capacity: 1, refillPerSec: 10, maxEntries: 1, forcedSweepMinMs: 1000 });
  limiter.consume(IP, 0); // lazy sweep at 0, then IP is tracked
  // At 500 ms IP's bucket is refillable, but the forced sweep is gated: OTHER is untracked.
  assert.equal(limiter.consume(OTHER, 500), true);
  assert.equal(limiter.size(), 1);
  assert.equal(limiter.consume(OTHER, 500), true, 'untracked means never limited');
  // At 1000 ms the gate opens: the sweep frees IP and the new IP is tracked.
  assert.equal(limiter.consume('198.51.100.7', 1000), true);
  assert.equal(limiter.size(), 1);
  assert.equal(limiter.consume('198.51.100.7', 1000), false, 'now tracked with an empty bucket');
});

test('the forced sweep interval defaults to IP_LIMIT_FORCED_SWEEP_MIN_MS of 1000 ms', () => {
  assert.equal(require('../src/constants').IP_LIMIT_FORCED_SWEEP_MIN_MS, 1000);
});

test('a full table makes room for a new IP when a sweep frees an entry', (t) => {
  t.mock.method(console, 'warn', () => {});
  const limiter = createLimit({ maxEntries: 1 });
  limiter.consume(IP, 0);
  // 20 s later IP's bucket is full again, so the sweep frees its entry.
  assert.equal(limiter.consume(OTHER, 20000), true);
  assert.equal(limiter.size(), 1);
  assert.equal(console.warn.mock.callCount(), 0);
});
