'use strict';

/* ==========================================================================
   Typing Speed Tester: multiplayer pure logic
   --------------------------------------------------------------------------
   Data in, values out. Nothing here touches the DOM, `window`, sockets or
   storage, so the same file runs as a classic browser script (loaded after
   stats.js and before script.js) and can be `require`d by Node tests.
   Every server payload shape comes from docs/PROTOCOL.md section 5.
   ========================================================================== */

/* ---------- 1. Constants ---------- */

/** Client-owned values from docs/PROTOCOL.md section 2. */
const MP_CONSTANTS = Object.freeze({
  progressIntervalMs: 150,
  maxKeysPerEvent: 64,
  connectTimeoutMs: 5000,
  passageMaxLength: 1000,
  seqMax: 2147483647,
  backspace: '\b',
  milestones: Object.freeze([50]),
  // The server's REMATCH_TIMEOUT_MS: after race:end, a player who has not
  // pressed "Race again" within this time is removed (IDLE_TIMEOUT).
  rematchTimeoutMs: 60000,
  // How long before that removal the client warns (WCAG 2.2.1).
  rematchWarningMs: 20000,
});

// Payload limits from PROTOCOL.md section 5. The server caps a room at 8, so
// no list in a payload can be longer than that.
const MP_LIMITS = Object.freeze({
  maxRoomPlayers: 8,
  idMaxLength: 64,
  startsInMsMax: 10000,
  raceTimeLimitMsMin: 1000,
  raceTimeLimitMsMax: 600000,
  wpmMax: 1000,
  rawWpmMax: 5000,
});

const ROOM_PHASES = Object.freeze(['waiting', 'countdown', 'racing', 'finished']);
const RESULT_STATUSES = Object.freeze(['finished', 'unfinished', 'left']);
const END_REASONS = Object.freeze(['all_finished', 'time_limit']);

// The server rejects keys with these characters (Backspace, U+0008, is the one
// allowed control character), and the passage never contains any of them.
const PASSAGE_CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

/* ---------- 2. Server URL and key buffering ---------- */

/**
 * The game server origin from the page's meta tag, or null. Only http(s) is
 * accepted, because the client runs a script loaded from this URL.
 */
function resolveServerUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

// Hostnames that only mean "this machine".
const LOOPBACK_HOSTNAMES = Object.freeze(['localhost', '127.0.0.1']);

/**
 * Whether a page on `pageHostname` can reach `serverUrl`. A loopback server is
 * only reachable from a page on the same machine, so the live site (or a
 * file:// page, hostname '') never offers a Multiplayer button that always
 * fails. Any other server URL is allowed.
 */
function isServerUsable(serverUrl, pageHostname) {
  if (typeof serverUrl !== 'string') return false;
  let hostname;
  try {
    hostname = new URL(serverUrl).hostname;
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTNAMES.includes(hostname)) return true;
  return LOOPBACK_HOSTNAMES.includes(pageHostname);
}

/**
 * Adds one key to the pending buffer. When the key would push the buffer past
 * `max` UTF-16 units, the old buffer must be sent now (`flush`) and the key
 * starts a new one, so no event ever exceeds the server's limit.
 */
function appendKey(buffer, key, max) {
  if (buffer.length + key.length > max) return { buffer: key, flush: buffer };
  return { buffer: buffer + key, flush: null };
}

/**
 * True for one typed code point the server will accept inside `keys`: no
 * control characters and no lone surrogate halves. Anything else would get
 * the whole event rejected and desync the server from the screen.
 */
function isSendableKey(key) {
  if (typeof key !== 'string' || key.length < 1 || key.length > 2) return false;
  if (PASSAGE_CONTROL_CHARS.test(key)) return false;
  const code = key.charCodeAt(0);
  if (key.length === 1) return code < 0xD800 || code > 0xDFFF;
  return key.codePointAt(0) > 0xFFFF; // a valid surrogate pair is one code point
}

/* ---------- 3. Payload validation ---------- */

// Each validator returns a clean copy with only the known fields, or null.

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIntInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function isNonNegativeInt(value) {
  return isIntInRange(value, 0, Number.MAX_SAFE_INTEGER);
}

function isPlayerId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= MP_LIMITS.idMaxLength;
}

function isWpm(value) {
  return isIntInRange(value, 0, MP_LIMITS.wpmMax);
}

function isPercent(value) {
  return isIntInRange(value, 0, 100);
}

function isRaceTimeLimit(value) {
  return isIntInRange(value, MP_LIMITS.raceTimeLimitMsMin, MP_LIMITS.raceTimeLimitMsMax);
}

/** Validates every item with `validateItem`; null if any fails or ids repeat. */
function validateList(list, maxLength, validateItem) {
  if (!Array.isArray(list) || list.length > maxLength) return null;
  const seen = new Set();
  const clean = [];
  for (const item of list) {
    const value = validateItem(item);
    // Ids key the progress rows, so a repeated id would break rendering.
    if (value === null || seen.has(value.id)) return null;
    seen.add(value.id);
    clean.push(value);
  }
  return clean;
}

function validatePlayerSummary(data, maxPlayers) {
  if (!isPlainObject(data)) return null;
  const { id, slot, connected, ready, finished } = data;
  if (!isPlayerId(id) || !isIntInRange(slot, 1, maxPlayers) ||
      typeof connected !== 'boolean' || typeof ready !== 'boolean' ||
      typeof finished !== 'boolean') return null;
  return { id, slot, connected, ready, finished };
}

/** RoomSnapshot (room:state, and inside the join and rematch acks). */
function validateRoomState(data) {
  if (!isPlainObject(data)) return null;
  const { phase, maxPlayers } = data;
  if (!ROOM_PHASES.includes(phase) || !isIntInRange(maxPlayers, 1, MP_LIMITS.maxRoomPlayers)) return null;
  const players = validateList(data.players, maxPlayers, (p) => validatePlayerSummary(p, maxPlayers));
  if (players === null) return null;
  players.sort((a, b) => a.slot - b.slot);
  return { phase, maxPlayers, players };
}

function validateCountdown(data) {
  if (!isPlainObject(data)) return null;
  const { passage, startsInMs, raceTimeLimitMs } = data;
  if (typeof passage !== 'string' || passage.length < 1 ||
      passage.length > MP_CONSTANTS.passageMaxLength || PASSAGE_CONTROL_CHARS.test(passage)) return null;
  if (!isIntInRange(startsInMs, 0, MP_LIMITS.startsInMsMax) || !isRaceTimeLimit(raceTimeLimitMs)) return null;
  return { passage, startsInMs, raceTimeLimitMs };
}

function validateRaceStart(data) {
  if (!isPlainObject(data) || !isRaceTimeLimit(data.raceTimeLimitMs)) return null;
  return { raceTimeLimitMs: data.raceTimeLimitMs };
}

function validateProgressEntry(data) {
  if (!isPlainObject(data)) return null;
  const { id, correctChars, progress, wpm, accuracy, finished, place } = data;
  if (!isPlayerId(id) || !isNonNegativeInt(correctChars) || !isPercent(progress) ||
      !isWpm(wpm) || !isPercent(accuracy) || typeof finished !== 'boolean') return null;
  if (place !== null && !isIntInRange(place, 1, Number.MAX_SAFE_INTEGER)) return null;
  return { id, correctChars, progress, wpm, accuracy, finished, place };
}

function validateRaceUpdate(data) {
  if (!isPlainObject(data) || !isNonNegativeInt(data.elapsedMs)) return null;
  const players = validateList(data.players, MP_LIMITS.maxRoomPlayers, validateProgressEntry);
  if (players === null) return null;
  return { elapsedMs: data.elapsedMs, players };
}

function validatePlayerFinish(data) {
  if (!isPlainObject(data)) return null;
  const { id, place, timeMs, wpm, accuracy } = data;
  if (!isPlayerId(id) || !isIntInRange(place, 1, Number.MAX_SAFE_INTEGER) ||
      !isNonNegativeInt(timeMs) || !isWpm(wpm) || !isPercent(accuracy)) return null;
  return { id, place, timeMs, wpm, accuracy };
}

function validateResultEntry(data) {
  if (!isPlainObject(data)) return null;
  const { id, slot, place, status, wpm, rawWpm, accuracy, correctChars, incorrectChars, timeMs } = data;
  if (!isPlayerId(id) || !isIntInRange(slot, 1, MP_LIMITS.maxRoomPlayers) ||
      !isIntInRange(place, 1, MP_LIMITS.maxRoomPlayers) || !RESULT_STATUSES.includes(status) ||
      !isWpm(wpm) || !isIntInRange(rawWpm, 0, MP_LIMITS.rawWpmMax) || !isPercent(accuracy) ||
      !isNonNegativeInt(correctChars) || !isNonNegativeInt(incorrectChars) ||
      !isNonNegativeInt(timeMs)) return null;
  return { id, slot, place, status, wpm, rawWpm, accuracy, correctChars, incorrectChars, timeMs };
}

function validateRaceEnd(data) {
  if (!isPlainObject(data) || !END_REASONS.includes(data.reason)) return null;
  const results = validateList(data.results, MP_LIMITS.maxRoomPlayers, validateResultEntry);
  if (results === null) return null;
  // Places are 1..n, unique, and the list is sorted by place.
  if (!results.every((entry, i) => entry.place === i + 1)) return null;
  return { reason: data.reason, results };
}

/** Failure acks keep only the code: the server's message is never shown. */
function validateAckError(data) {
  if (!isPlainObject(data.error)) return null;
  const { code } = data.error;
  if (typeof code !== 'string' || code.length < 1 || code.length > MP_LIMITS.idMaxLength) return null;
  return { ok: false, error: { code } };
}

function validateJoinAck(data) {
  if (!isPlainObject(data) || typeof data.ok !== 'boolean') return null;
  if (!data.ok) return validateAckError(data);
  const room = validateRoomState(data.room);
  if (!isPlayerId(data.playerId) || room === null) return null;
  return { ok: true, playerId: data.playerId, room };
}

function validateRematchAck(data) {
  if (!isPlainObject(data) || typeof data.ok !== 'boolean') return null;
  if (!data.ok) return validateAckError(data);
  const room = validateRoomState(data.room);
  if (room === null) return null;
  return { ok: true, room };
}

/* ---------- 4. Labels and text ---------- */

/**
 * The client names players itself, so no server string is ever rendered.
 * `players` is any list of `{ id, slot }`; opponents are numbered by slot only
 * when there is more than one.
 */
function labelFor(playerId, selfId, players) {
  if (playerId === selfId) return 'You';
  const opponents = (Array.isArray(players) ? players : [])
    .filter((player) => player && player.id !== selfId)
    .sort((a, b) => a.slot - b.slot);
  if (opponents.length <= 1) return 'Opponent';
  const position = opponents.findIndex((player) => player.id === playerId);
  return position === -1 ? 'Opponent' : `Opponent ${position + 1}`;
}

/** 1 -> '1st', 2 -> '2nd', 11 -> '11th', 22 -> '22nd'. */
function ordinal(n) {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/** The highest milestone m with previous < m <= current, else null. */
function crossedMilestone(previous, current, milestones) {
  let crossed = null;
  for (const m of milestones) {
    if (previous < m && m <= current && (crossed === null || m > crossed)) crossed = m;
  }
  return crossed;
}

// UNREACHABLE and DISCONNECTED are client-only codes, never sent by the server.
const ERROR_MESSAGES = Object.freeze({
  ROOM_FULL: 'The race room is full. Try again in a minute.',
  RACE_IN_PROGRESS: 'A race is already running. Try again in a minute.',
  RATE_LIMITED: 'Too many requests. Wait a moment and try again.',
  UNREACHABLE: 'Could not reach the multiplayer server. You are playing solo.',
  DISCONNECTED: 'Lost connection to the multiplayer server. You are playing solo.',
  IDLE_TIMEOUT: 'You were idle, so you left the race room. You are playing solo.',
});

function errorMessage(code) {
  return Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code)
    ? ERROR_MESSAGES[code]
    : 'Something went wrong with multiplayer.';
}

/** 41300 -> '41.3s'. */
function formatRaceTime(ms) {
  const seconds = Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0;
  return `${seconds.toFixed(1)}s`;
}

/* ---------- 5. Node export (ignored in the browser) ---------- */

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MP_CONSTANTS,
    resolveServerUrl,
    isServerUsable,
    appendKey,
    isSendableKey,
    validateRoomState,
    validateCountdown,
    validateRaceStart,
    validateRaceUpdate,
    validatePlayerFinish,
    validateRaceEnd,
    validateJoinAck,
    validateRematchAck,
    labelFor,
    ordinal,
    crossedMilestone,
    errorMessage,
    formatRaceTime,
  };
}
