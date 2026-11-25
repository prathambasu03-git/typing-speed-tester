'use strict';

/* Proxy-aware client address for the per-IP connection cap. Pure functions,
   so they can be tested without sockets. */

const net = require('node:net');

const IPV4_MAPPED_PREFIX = '::ffff:';

/**
 * Trimmed, lowercased IP with an IPv4-mapped prefix removed, so one client
 * cannot get two counters; null when `s` is not a valid IP.
 */
function normalizeIp(s) {
  if (typeof s !== 'string') return null;
  let ip = s.trim().toLowerCase();
  if (ip.startsWith(IPV4_MAPPED_PREFIX)) {
    const rest = ip.slice(IPV4_MAPPED_PREFIX.length);
    if (net.isIPv4(rest)) ip = rest;
  }
  return net.isIP(ip) !== 0 ? ip : null;
}

/**
 * The address used for the per-IP cap. With N trusted hops it reads the Nth
 * X-Forwarded-For entry from the right: a client can only add entries to the
 * left of what the trusted proxies append, so this cannot be spoofed while N
 * is not larger than the real number of proxies.
 */
function getClientIp(remoteAddress, forwardedFor, trustProxyHops) {
  const peer = normalizeIp(remoteAddress) ?? 'unknown';
  if (!Number.isInteger(trustProxyHops) || trustProxyHops <= 0) return peer;
  // Node joins repeated headers into one string; anything else counts as absent.
  if (typeof forwardedFor !== 'string' || forwardedFor === '') return peer;

  // Empty entries are kept on purpose: they shift positions, and an empty
  // pick falls back to the peer instead of reading a client-written entry.
  const entries = forwardedFor.split(',').map((s) => s.trim());
  const candidate =
    entries.length >= trustProxyHops ? entries[entries.length - trustProxyHops] : entries[0];

  // net.isIP rejects empty strings, host:port and garbage.
  if (net.isIP(candidate) === 0) return peer;
  return normalizeIp(candidate) ?? peer;
}

module.exports = { getClientIp, normalizeIp };
