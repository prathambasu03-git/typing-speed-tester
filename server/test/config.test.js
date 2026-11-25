'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, DEFAULT_CONFIG } = require('../src/config');

test('an empty environment gives the default config without warnings', (t) => {
  t.mock.method(console, 'warn', () => {});
  const config = loadConfig({});
  assert.deepEqual(
    { ...config, corsOrigins: [...config.corsOrigins] },
    {
      port: 3000,
      corsOrigins: ['https://prathambasu03-git.github.io'],
      allowLocalhost: true,
      allowNullOrigin: false,
      maxConnectionsPerIp: 10,
    }
  );
  assert.equal(console.warn.mock.callCount(), 0);
});

test('valid environment values are parsed', () => {
  const config = loadConfig({
    PORT: '4000',
    CORS_ORIGINS: 'https://a.example, https://b.example ,',
    ALLOW_LOCALHOST: 'false',
    ALLOW_NULL_ORIGIN: 'true',
    MAX_CONNECTIONS_PER_IP: '3',
  });
  assert.equal(config.port, 4000);
  assert.deepEqual([...config.corsOrigins], ['https://a.example', 'https://b.example']);
  assert.equal(config.allowLocalhost, false);
  assert.equal(config.allowNullOrigin, true);
  assert.equal(config.maxConnectionsPerIp, 3);
});

test('invalid environment values fall back to defaults with one warning each', (t) => {
  t.mock.method(console, 'warn', () => {});
  const config = loadConfig({
    PORT: 'abc',
    ALLOW_LOCALHOST: 'yes',
    ALLOW_NULL_ORIGIN: '1',
    MAX_CONNECTIONS_PER_IP: '0',
  });
  assert.equal(config.port, DEFAULT_CONFIG.port);
  assert.equal(config.allowLocalhost, DEFAULT_CONFIG.allowLocalhost);
  assert.equal(config.allowNullOrigin, DEFAULT_CONFIG.allowNullOrigin);
  assert.equal(config.maxConnectionsPerIp, DEFAULT_CONFIG.maxConnectionsPerIp);
  assert.equal(console.warn.mock.callCount(), 4);
});

test('out-of-range and fractional numbers fall back to defaults', (t) => {
  t.mock.method(console, 'warn', () => {});
  assert.equal(loadConfig({ PORT: '70000' }).port, 3000);
  assert.equal(loadConfig({ PORT: '-1' }).port, 3000);
  assert.equal(loadConfig({ MAX_CONNECTIONS_PER_IP: '2.5' }).maxConnectionsPerIp, 10);
  assert.equal(loadConfig({ MAX_CONNECTIONS_PER_IP: '10001' }).maxConnectionsPerIp, 10);
});

test('an empty CORS_ORIGINS gives an empty origin list', () => {
  assert.deepEqual([...loadConfig({ CORS_ORIGINS: '' }).corsOrigins], []);
});

test('the loaded config is frozen', () => {
  const config = loadConfig({});
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.corsOrigins));
});
