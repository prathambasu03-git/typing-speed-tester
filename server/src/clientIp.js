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

/** Eight 16-bit groups of a valid IPv6 address (zone id already removed). */
function expandIpv6(ip) {
  let text = ip;
  // An embedded IPv4 tail (e.g. 64:ff9b::1.2.3.4) is two hextets.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (net.isIPv4(tail)) {
    const [a, b, c, d] = tail.split('.').map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const rest = halves.length > 1 && halves[1] !== '' ? halves[1].split(':') : [];
  const zeros = new Array(8 - head.length - rest.length).fill('0');
  return [...head, ...zeros, ...rest].map((group) => parseInt(group, 16));
}

/**
 * The key for every per-IP limit (connection cap, create and join-failure
 * limiters). One host is usually given a whole IPv6 /64, so keying on the
 * full address would hand it billions of "IPs"; IPv6 is therefore cut to its
 * /64 prefix, written as the first four hextets in lowercase minimal form
 * plus "::/64" (2001:db8:1:2::/64). The prefix is never compressed further,
 * so ::1 becomes 0:0:0:0::/64. IPv4, 'unknown' and anything that is not an
 * IP come back unchanged.
 */
function limiterKey(ip) {
  if (typeof ip !== 'string') return ip;
  const normal = normalizeIp(ip.split('%')[0]);
  if (normal === null || net.isIPv4(normal)) return normal ?? ip;
  const prefix = expandIpv6(normal).slice(0, 4).map((group) => group.toString(16));
  return `${prefix.join(':')}::/64`;
}

module.exports = { getClientIp, normalizeIp, limiterKey };
