'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isAllowedOrigin } = require('../src/origin');

const PAGES = 'https://prathambasu03.github.io';
const strict = { corsOrigins: [PAGES], allowLocalhost: false, allowNullOrigin: false };
const local = { corsOrigins: [PAGES], allowLocalhost: true, allowNullOrigin: false };
const nullOk = { corsOrigins: [PAGES], allowLocalhost: false, allowNullOrigin: true };

test('the GitHub Pages origin is allowed', () => {
  assert.equal(isAllowedOrigin(PAGES, strict), true);
});

test('the GitHub Pages origin with a trailing slash is refused', () => {
  assert.equal(isAllowedOrigin(`${PAGES}/`, local), false);
});

test('another github.io origin is refused', () => {
  assert.equal(isAllowedOrigin('https://evil.github.io', local), false);
});

test('the http version of the GitHub Pages origin is refused', () => {
  assert.equal(isAllowedOrigin('http://prathambasu03.github.io', local), false);
});

test('localhost origins are allowed only when allowLocalhost is true', () => {
  for (const origin of ['http://localhost:8080', 'http://127.0.0.1', 'http://localhost']) {
    assert.equal(isAllowedOrigin(origin, local), true, origin);
    assert.equal(isAllowedOrigin(origin, strict), false, origin);
  }
});

test('lookalike localhost origins are refused', () => {
  for (const origin of [
    'http://localhost.evil.com',
    'http://localhost:8080.evil.com',
    'https://localhost:8080',
    'http://127.0.0.1.evil.com',
    'http://localhost:123456',
    'http://evil.com?http://localhost',
  ]) {
    assert.equal(isAllowedOrigin(origin, local), false, origin);
  }
});

test('the null origin is allowed only when allowNullOrigin is true', () => {
  assert.equal(isAllowedOrigin('null', nullOk), true);
  assert.equal(isAllowedOrigin('null', local), false);
});

test('a missing origin is allowed', () => {
  assert.equal(isAllowedOrigin(undefined, strict), true);
});

test('a non-string origin is refused', () => {
  assert.equal(isAllowedOrigin(['http://localhost'], local), false);
  assert.equal(isAllowedOrigin(null, nullOk), false);
});

test('an empty config refuses every browser origin', () => {
  assert.equal(isAllowedOrigin(PAGES), false);
  assert.equal(isAllowedOrigin('http://localhost'), false);
});
