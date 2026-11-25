'use strict';

const path = require('node:path');

const DEFAULT_CONFIG = Object.freeze({
  port: 3000,
  corsOrigins: Object.freeze(['https://prathambasu03.github.io']),
  allowLocalhost: true,
  allowNullOrigin: false,
  maxConnectionsPerIp: 10,
});

const ENV_FILE = path.join(__dirname, '..', '.env');

function loadEnvFileIfPresent() {
  // A missing .env is normal (production sets real env vars), so ignore errors.
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    // no .env file
  }
}

function parseBoolean(name, raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  console.warn(`[config] ${name} must be "true" or "false"; using ${fallback}`);
  return fallback;
}

function parseIntInRange(name, raw, min, max, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const text = String(raw).trim();
  const value = Number(text);
  if (/^\d+$/.test(text) && value >= min && value <= max) return value;
  console.warn(`[config] ${name} must be an integer in ${min}..${max}; using ${fallback}`);
  return fallback;
}

function parseOrigins(raw, fallback) {
  if (raw === undefined) return fallback;
  return Object.freeze(
    String(raw)
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0)
  );
}

/** Reads the environment into a frozen config; bad values fall back to defaults. */
function loadConfig(env = process.env) {
  // Only touch the real .env file when reading the real environment, so tests
  // that pass their own `env` object stay pure.
  if (env === process.env) loadEnvFileIfPresent();

  return Object.freeze({
    port: parseIntInRange('PORT', env.PORT, 0, 65535, DEFAULT_CONFIG.port),
    corsOrigins: parseOrigins(env.CORS_ORIGINS, DEFAULT_CONFIG.corsOrigins),
    allowLocalhost: parseBoolean('ALLOW_LOCALHOST', env.ALLOW_LOCALHOST, DEFAULT_CONFIG.allowLocalhost),
    allowNullOrigin: parseBoolean('ALLOW_NULL_ORIGIN', env.ALLOW_NULL_ORIGIN, DEFAULT_CONFIG.allowNullOrigin),
    maxConnectionsPerIp: parseIntInRange(
      'MAX_CONNECTIONS_PER_IP',
      env.MAX_CONNECTIONS_PER_IP,
      1,
      10000,
      DEFAULT_CONFIG.maxConnectionsPerIp
    ),
  });
}

module.exports = { loadConfig, DEFAULT_CONFIG };
