'use strict';

/* Per-IP token buckets for room:create and failed room:join (PROTOCOL.md
   section 4). Pure: `now` is passed in and there are no timers. Idle buckets
   are swept lazily, so memory is bounded by maxEntries. */

const { createBucket, refill, takeToken } = require('./rateLimit');
const {
  IP_LIMIT_MAX_ENTRIES,
  IP_LIMIT_SWEEP_MS,
  IP_LIMIT_FORCED_SWEEP_MIN_MS,
} = require('./constants');

function createIpLimiter({
  capacity,
  refillPerSec,
  maxEntries = IP_LIMIT_MAX_ENTRIES,
  sweepIntervalMs = IP_LIMIT_SWEEP_MS,
  forcedSweepMinMs = IP_LIMIT_FORCED_SWEEP_MIN_MS,
}) {
  const buckets = new Map();
  let lastSweepAt = -Infinity;
  let lastWarnAt = -Infinity;

  /** Drops buckets that have refilled to capacity: they behave like no bucket. */
  function sweep(now) {
    lastSweepAt = now;
    for (const [ip, bucket] of buckets) {
      refill(bucket, now);
      if (bucket.tokens >= bucket.capacity) buckets.delete(ip);
    }
  }

  function maybeSweep(now) {
    if (now - lastSweepAt >= sweepIntervalMs) sweep(now);
  }

  /**
   * The bucket for a new IP, or null when the table is full even after a
   * sweep. Failing open (untracked = allowed) is deliberate: failing closed
   * would let one attacker with many IPs block everyone.
   */
  function bucketForNewIp(ip, now) {
    if (buckets.size >= maxEntries) {
      // A full sweep walks every bucket. Without this gate an attacker keeping
      // the table full would make every new-IP request pay that cost.
      if (now - lastSweepAt >= forcedSweepMinMs) sweep(now);
      if (buckets.size >= maxEntries) {
        if (now - lastWarnAt >= sweepIntervalMs) {
          lastWarnAt = now;
          console.warn(`[ipLimiter] ${maxEntries} IPs tracked; allowing new IPs untracked`);
        }
        return null;
      }
    }
    const bucket = createBucket(capacity, refillPerSec, now);
    buckets.set(ip, bucket);
    return bucket;
  }

  /** At least one token, without taking it. An unknown IP has a full bucket. */
  function has(ip, now) {
    maybeSweep(now);
    const bucket = buckets.get(ip);
    if (!bucket) return capacity >= 1;
    refill(bucket, now);
    return bucket.tokens >= 1;
  }

  /** Takes one token if available. */
  function consume(ip, now) {
    maybeSweep(now);
    const bucket = buckets.get(ip) || bucketForNewIp(ip, now);
    if (!bucket) return true;
    return takeToken(bucket, now);
  }

  function size() {
    return buckets.size;
  }

  return { has, consume, sweep, size };
}

module.exports = { createIpLimiter };
