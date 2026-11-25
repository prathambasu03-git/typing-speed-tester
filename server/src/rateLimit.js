'use strict';

/* Token bucket with the clock injected, so it is pure and has no timers. */

function createBucket(capacity, refillPerSec, now) {
  return { tokens: capacity, updatedAt: now, capacity, refillPerSec };
}

/** Refills from elapsed time (capped at capacity), then takes one token if available. */
function takeToken(bucket, now) {
  const elapsedSec = Math.max(0, now - bucket.updatedAt) / 1000;
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsedSec * bucket.refillPerSec);
  bucket.updatedAt = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

module.exports = { createBucket, takeToken };
