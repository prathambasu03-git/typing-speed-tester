'use strict';

/* Proxy-aware client address for the per-IP cap (PLAN.md D4.3, D8). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { getClientIp, normalizeIp } = require('../src/clientIp');

/* ---------- getClientIp: the D8 table ---------- */

const CASES = [
  ['1.2.3.4', undefined, 0, '1.2.3.4', 'returns the peer when there is no header and no trusted hop'],
  ['10.0.0.1', '203.0.113.5', 0, '10.0.0.1', 'ignores the header when no hops are trusted'],
  ['10.0.0.1', '203.0.113.5', 1, '203.0.113.5', 'reads the only entry with one trusted hop'],
  [
    '10.0.0.1',
    '6.6.6.6, 198.51.100.7, 203.0.113.5',
    1,
    '203.0.113.5',
    'reads the rightmost entry with one trusted hop, ignoring client-written entries',
  ],
  ['10.0.0.1', '198.51.100.7, 203.0.113.5', 2, '198.51.100.7', 'reads the second entry from the right with two hops'],
  ['10.0.0.1', '203.0.113.5', 3, '203.0.113.5', 'uses the first entry when there are fewer entries than hops'],
  ['10.0.0.1', 'garbage', 1, '10.0.0.1', 'falls back to the peer when the picked entry is garbage'],
  ['10.0.0.1', '', 1, '10.0.0.1', 'falls back to the peer when the header is empty'],
  ['10.0.0.1', '203.0.113.5, ', 1, '10.0.0.1', 'falls back to the peer when the picked entry is empty'],
  ['10.0.0.1', '203.0.113.5:4711', 1, '10.0.0.1', 'falls back to the peer when the picked entry has a port'],
  ['10.0.0.1', '2001:DB8::1', 1, '2001:db8::1', 'lowercases an IPv6 entry'],
  ['::ffff:10.0.0.1', undefined, 0, '10.0.0.1', 'strips the IPv4-mapped prefix from the peer'],
  ['10.0.0.1', '::ffff:203.0.113.5', 1, '203.0.113.5', 'strips the IPv4-mapped prefix from the picked entry'],
  [undefined, undefined, 0, 'unknown', 'returns unknown when the peer address is missing'],
  ['10.0.0.1', ['203.0.113.5'], 1, '10.0.0.1', 'treats a non-string header as absent'],
];

for (const [remote, xff, hops, expected, sentence] of CASES) {
  test(`getClientIp ${sentence}`, () => {
    assert.equal(getClientIp(remote, xff, hops), expected);
  });
}

/* ---------- getClientIp: hops that are not a positive integer ---------- */

for (const hops of [1.5, -1, NaN, '1', undefined, null, Infinity]) {
  test(`getClientIp returns the peer when trustProxyHops is ${String(hops)} (${typeof hops})`, () => {
    assert.equal(getClientIp('10.0.0.1', '203.0.113.5', hops), '10.0.0.1');
  });
}

test('getClientIp returns unknown for an invalid peer when the header is ignored', () => {
  assert.equal(getClientIp('not-an-ip', '203.0.113.5', 0), 'unknown');
});

test('getClientIp returns unknown for an invalid peer and an invalid picked entry', () => {
  assert.equal(getClientIp('not-an-ip', 'garbage', 1), 'unknown');
});

/* ---------- normalizeIp ---------- */

test('normalizeIp trims surrounding whitespace', () => {
  assert.equal(normalizeIp('  203.0.113.5 \t'), '203.0.113.5');
});

test('normalizeIp lowercases IPv6 addresses', () => {
  assert.equal(normalizeIp('2001:DB8::ABCD'), '2001:db8::abcd');
});

test('normalizeIp strips a leading ::ffff: from an IPv4-mapped address', () => {
  assert.equal(normalizeIp('::ffff:127.0.0.1'), '127.0.0.1');
});

test('normalizeIp strips an uppercase ::FFFF: prefix too', () => {
  assert.equal(normalizeIp('::FFFF:127.0.0.1'), '127.0.0.1');
});

test('normalizeIp keeps a plain IPv6 address that starts with ::ffff: but is not IPv4-mapped', () => {
  assert.equal(normalizeIp('::ffff:abcd'), '::ffff:abcd');
});

test('normalizeIp returns null for garbage strings', () => {
  for (const s of ['', '   ', 'garbage', '203.0.113.5:4711', '256.1.1.1', '1.2.3', 'localhost']) {
    assert.equal(normalizeIp(s), null, JSON.stringify(s));
  }
});

test('normalizeIp returns null for non-strings', () => {
  for (const v of [undefined, null, 1234, {}, ['1.2.3.4'], true]) {
    assert.equal(normalizeIp(v), null, String(v));
  }
});
