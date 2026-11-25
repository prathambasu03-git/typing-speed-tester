'use strict';

// Exact localhost origins only, so "http://localhost.evil.com" does not match.
const LOCALHOST_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/** PROTOCOL.md section 1. Pure: decides from the origin string and config only. */
function isAllowedOrigin(origin, { corsOrigins = [], allowLocalhost = false, allowNullOrigin = false } = {}) {
  // Non-browser clients (tests, curl) send no Origin. CORS only protects
  // browsers, so refusing them would add no security.
  if (origin === undefined) return true;
  if (typeof origin !== 'string') return false;
  if (origin === 'null') return allowNullOrigin === true;
  if (corsOrigins.includes(origin)) return true;
  return allowLocalhost === true && LOCALHOST_ORIGIN.test(origin);
}

module.exports = { isAllowedOrigin, LOCALHOST_ORIGIN };
