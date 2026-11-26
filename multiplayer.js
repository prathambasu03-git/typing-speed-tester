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
  // Budget for the first connection to a remote server (script load plus
  // socket connect, with retries), from the Create or Join press. A free-tier
  // host can take about a minute to wake from sleep.
  wakeTimeoutMs: 90000,
  // The same budget for a loopback server: it never sleeps, so a stopped one
  // should fail fast.
  localConnectTimeoutMs: 5000,
  // Pause before retrying a failed attempt. While waking, the host may answer
  // early with an error page instead of holding the request.
  wakeRetryDelayMs: 3000,
  // A warm server connects well within this, so the waking message only
  // shows when the server is almost certainly asleep.
  wakeNoticeDelayMs: 3000,
  // room:create / room:join ack: the first request after a wake can be slow.
  joinAckTimeoutMs: 10000,
  // race:rematch, room:start and room:extend acks.
  ackTimeoutMs: 5000,
  // Server used by loopback pages, whatever the meta tag says.
  localServerUrl: 'http://localhost:3000',
  passageMaxLength: 1000,
  seqMax: 2147483647,
  backspace: '\b',
  milestones: Object.freeze([50]),
  // The server's REMATCH_TIMEOUT_MS: after race:end, a player who has not
  // pressed "Race again" within this time is removed (IDLE_TIMEOUT).
  rematchTimeoutMs: 60000,
  // How long before that removal the client warns (WCAG 2.2.1).
  rematchWarningMs: 20000,
  // The warning fires this much earlier: the server's timer starts before
  // race:end reaches us, and background tabs can delay timers.
  rematchWarningMarginMs: 3000,
  roomCodeLength: 6,
  // No 0, 1, I, L, O or U: they are easy to misread, and dropping U avoids
  // accidental words. Must agree with ROOM_CODE_PATTERN.
  roomCodeAlphabet: 'ABCDEFGHJKMNPQRSTVWXYZ23456789',
  // How long before an idle lobby closes (ROOM_EXPIRED) the client warns and
  // offers "Stay in room" (WCAG 2.2.1).
  lobbyWarningMs: 60000,
  // As for the rematch warning: the server's clock started a little earlier.
  lobbyWarningMarginMs: 3000,
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
  expiresInMsMax: 3600000,
});

/** A canonical room code (PROTOCOL.md section 2). */
const ROOM_CODE_PATTERN = /^[A-HJKMNP-TV-Z2-9]{6}$/;

const ROOM_CODE_FORMAT_MESSAGE =
  'Room codes have 6 letters and numbers, like K7QM2X. They never use 0, 1, I, L, O or U.';

// Shown in the room lobby while you are the only player.
const SOLO_TIP = 'Racing alone? Open the invite link in a second tab to try it out.';

// Shown to a player still on their results when the host starts without them.
const SIT_OUT_MESSAGE = "The host started a new race. You'll join the next one.";

const ROOM_PHASES = Object.freeze(['waiting', 'countdown', 'racing', 'finished']);
const RESULT_STATUSES = Object.freeze(['finished', 'unfinished', 'left']);
const END_REASONS = Object.freeze(['all_finished', 'time_limit']);

// The server rejects keys with these characters (Backspace, U+0008, is the one
// allowed control character), and the passage never contains any of them.
const PASSAGE_CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

/* ---------- 2. Server URL, connection timing, room codes and key buffering ---------- */

// Which server a page uses (pickServerUrl), how long the first connection may
// take (connectBudgetMs: long for a remote server that may be asleep, short
// for a local one) and whether another attempt still fits (retryDelayWithin).
// Room codes typed by the user or read from a #room= invite link are
// canonicalised and checked here before any connection is made.

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

/** True when `url` is a valid URL whose hostname means "this machine". */
function isLoopbackUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    return LOOPBACK_HOSTNAMES.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Time allowed for the first connection, in ms. Anything that is not a valid
 * remote URL gets the short local budget, so a bad value never waits 90 s.
 */
function connectBudgetMs(serverUrl) {
  if (typeof serverUrl !== 'string' || isLoopbackUrl(serverUrl)) return MP_CONSTANTS.localConnectTimeoutMs;
  try {
    new URL(serverUrl); // throws for an invalid URL
  } catch {
    return MP_CONSTANTS.localConnectTimeoutMs;
  }
  return MP_CONSTANTS.wakeTimeoutMs;
}

/** `delayMs` if another attempt can start before the deadline, else null. */
function retryDelayWithin(nowMs, deadlineMs, delayMs) {
  return nowMs + delayMs < deadlineMs ? delayMs : null;
}

/**
 * The game server for a page at `pageLocation` ({ protocol, hostname }), or
 * null for solo only.
 * - file:// (or anything not http(s)) is solo only: hosts refuse Origin null.
 * - Loopback pages always use the local server, so local work needs no edit.
 * - Otherwise the meta URL, unless it is missing (or the placeholder), a
 *   loopback server, or http: on an https: page (mixed content is blocked).
 */
function pickServerUrl(metaContent, pageLocation) {
  if (!pageLocation || (pageLocation.protocol !== 'http:' && pageLocation.protocol !== 'https:')) return null;
  const hostname = pageLocation.hostname;
  if (LOOPBACK_HOSTNAMES.includes(hostname)) return MP_CONSTANTS.localServerUrl;
  const url = resolveServerUrl(metaContent);
  if (url === null || !isServerUsable(url, hostname)) return null;
  if (pageLocation.protocol === 'https:' && url.startsWith('http:')) return null;
  return url;
}

/**
 * The canonical form of a typed code: no whitespace or hyphens, uppercase
 * (' k7q-m2x ' -> 'K7QM2X'). The server accepts only this form.
 */
function normalizeRoomCode(input) {
  if (typeof input !== 'string') return '';
  return input.replace(/[\s-]/g, '').toUpperCase();
}

function isValidRoomCode(code) {
  return typeof code === 'string' && ROOM_CODE_PATTERN.test(code);
}

/** The message for a typed code that cannot be sent, or '' when it is fine. */
function roomCodeInputError(input) {
  const code = normalizeRoomCode(input);
  if (isValidRoomCode(code)) return '';
  return code === '' ? 'Enter a room code.' : ROOM_CODE_FORMAT_MESSAGE;
}

// Strict on purpose: anything else in the hash is not an invite.
const ROOM_HASH_PATTERN = /^#room=([A-Za-z0-9 -]{1,16})$/;

/** The room code in an invite hash ('#room=k7qm2x' -> 'K7QM2X'), or null. */
function parseRoomHash(hash) {
  if (typeof hash !== 'string') return null;
  const match = ROOM_HASH_PATTERN.exec(hash);
  if (match === null) return null;
  const code = normalizeRoomCode(match[1]);
  return isValidRoomCode(code) ? code : null;
}

/**
 * The invite link for `code` on the page at `pageHref`: same path and query,
 * any old hash replaced. Null for a bad code or a page that is not http(s).
 * The code lives in the hash, so it never reaches the page host's logs.
 */
function buildShareLink(pageHref, code) {
  if (!isValidRoomCode(code)) return null;
  let url;
  try {
    url = new URL(pageHref);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = `room=${code}`;
  return url.href;
}

/** 'K7QM2X' -> 'K 7 Q M 2 X', so screen readers read one character at a time. */
function spellRoomCode(code) {
  return typeof code === 'string' ? code.split('').join(' ') : '';
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
  const { id, slot, connected, ready, inRace, finished } = data;
  if (!isPlayerId(id) || !isIntInRange(slot, 1, maxPlayers) ||
      typeof connected !== 'boolean' || typeof ready !== 'boolean' ||
      typeof inRace !== 'boolean' || typeof finished !== 'boolean') return null;
  return { id, slot, connected, ready, inRace, finished };
}

/** RoomSnapshot (room:state, and inside the create, join, rematch and extend acks). */
function validateRoomState(data) {
  if (!isPlainObject(data)) return null;
  const { code, phase, maxPlayers, minPlayers, hostId, expiresInMs } = data;
  // The code is the one server string the client renders, so it must be canonical.
  if (!isValidRoomCode(code) || !ROOM_PHASES.includes(phase) ||
      !isIntInRange(maxPlayers, 1, MP_LIMITS.maxRoomPlayers) ||
      !isIntInRange(minPlayers, 1, maxPlayers)) return null;
  const players = validateList(data.players, maxPlayers, (p) => validatePlayerSummary(p, maxPlayers));
  if (players === null) return null;
  // Slots name players ("Player 2"), so two players on one slot would share a label.
  if (new Set(players.map((player) => player.slot)).size !== players.length) return null;
  // The host is one of the players; only an empty room has none.
  if (hostId === null) {
    if (players.length > 0) return null;
  } else if (!players.some((player) => player.id === hostId)) {
    return null;
  }
  // Only a waiting room has a lobby timer.
  if (expiresInMs !== null &&
      (!isIntInRange(expiresInMs, 0, MP_LIMITS.expiresInMsMax) || phase !== 'waiting')) return null;
  if (phase === 'waiting' && players.some((player) => player.inRace)) return null;
  players.sort((a, b) => a.slot - b.slot);
  return { code, phase, maxPlayers, minPlayers, hostId, expiresInMs, players };
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

/** room:create and room:join acks (the same shape). */
function validateJoinAck(data) {
  if (!isPlainObject(data) || typeof data.ok !== 'boolean') return null;
  if (!data.ok) return validateAckError(data);
  const room = validateRoomState(data.room);
  if (!isPlayerId(data.playerId) || room === null) return null;
  // The room this player just entered must list them, or getSelfId finds no one.
  if (!room.players.some((player) => player.id === data.playerId)) return null;
  return { ok: true, playerId: data.playerId, room };
}

/** room:extend and race:rematch acks: `{ ok: true, room }` or the error form. */
function validateRoomAck(data) {
  if (!isPlainObject(data) || typeof data.ok !== 'boolean') return null;
  if (!data.ok) return validateAckError(data);
  const room = validateRoomState(data.room);
  if (room === null) return null;
  return { ok: true, room };
}

// Same shape; the old name is kept for callers and tests.
const validateRematchAck = validateRoomAck;

/** room:start ack: `{ ok: true }` or the error form. */
function validateStartAck(data) {
  if (!isPlainObject(data) || typeof data.ok !== 'boolean') return null;
  if (!data.ok) return validateAckError(data);
  return { ok: true };
}

/* ---------- 4. Room rules, labels and text ---------- */

// What the lobby shows from a validated RoomSnapshot and this player's id:
// who is host, who sits out, whether Start race is enabled and why not, and
// the host-change announcement. Labels are built here, never taken from the
// server.

function findSelf(room, selfId) {
  if (!room || !Array.isArray(room.players)) return null;
  return room.players.find((player) => player.id === selfId) || null;
}

/** The host started a race without this player (they had not pressed Race again). */
function isSittingOut(room, selfId) {
  if (!room || (room.phase !== 'countdown' && room.phase !== 'racing')) return false;
  const self = findSelf(room, selfId);
  return self !== null && self.inRace === false;
}

/**
 * Players who would race if the host started now. The host's Start counts as
 * its own Race again, so the host is counted even when not ready yet.
 */
function readyCount(room, selfId) {
  const ready = room.players.filter((player) => player.ready === true).length;
  const self = findSelf(room, selfId);
  return self !== null && !self.ready ? ready + 1 : ready;
}

/** Mirrors the server's start check (PROTOCOL.md section 3) for this player. */
function canStartRace(room, selfId) {
  if (!room || room.hostId !== selfId) return false;
  if (room.phase !== 'waiting' && room.phase !== 'finished') return false;
  return room.players.length >= room.minPlayers && readyCount(room, selfId) >= room.minPlayers;
}

/** Why Start race is disabled for the host; '' when it is enabled or self is not host. */
function startHint(room, selfId) {
  if (!room || room.hostId !== selfId || canStartRace(room, selfId)) return '';
  if (room.phase === 'countdown' || room.phase === 'racing') {
    return 'A race is on. You can start the next one when it ends.';
  }
  if (room.players.length < room.minPlayers) return 'Waiting for at least one more player.';
  return 'Waiting for at least one more player to press Race again.';
}

/** Only then does the "open the link in a second tab" tip help. */
function isAloneInLobby(room) {
  return Boolean(room) && room.phase === 'waiting' && room.players.length === 1;
}

/**
 * The one host announcement for a new snapshot, or ''. `clientPhase` is the
 * client's own phase. Others hear about a new host only outside the
 * countdown and race, where it does not affect them.
 */
function hostChangeText(prev, room, selfId, clientPhase) {
  if (!prev || !room || prev.hostId === room.hostId || room.hostId === null) return '';
  if (room.hostId === selfId) {
    const lead = 'You are now the host.';
    if (clientPhase === 'waiting') {
      if (isSittingOut(room, selfId)) return `${lead} You can start the next race when this one ends.`;
      if (canStartRace(room, selfId)) return `${lead} You can start the race.`;
      const hint = startHint(room, selfId);
      return hint ? `${lead} ${hint}` : lead;
    }
    if (clientPhase === 'finished') return `${lead} Press Race again, then Start race.`;
    return lead;
  }
  if (clientPhase !== 'waiting' && clientPhase !== 'finished') return '';
  return `${labelFor(room.hostId, selfId, room.players)} is now the host.`;
}

/**
 * The client names players itself, so no server string is ever rendered.
 * `players` is any list of `{ id, slot }`. Slots stay with a player while
 * others leave, so "Player 3" stays "Player 3".
 */
function labelFor(playerId, selfId, players) {
  if (playerId === selfId) return 'You';
  const player = (Array.isArray(players) ? players : [])
    .find((item) => item && item.id === playerId);
  return player && Number.isInteger(player.slot) ? `Player ${player.slot}` : 'Player';
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
// ROOM_FULL names 4 players as a fixed string: a failed join does not tell
// the client the room's size.
const ERROR_MESSAGES = Object.freeze({
  BAD_CODE: ROOM_CODE_FORMAT_MESSAGE,
  ROOM_NOT_FOUND: 'No room has that code. Check it, or ask for a new link: rooms close when everyone leaves.',
  ROOM_FULL: 'That room is full (4 players). Ask the host for a new room or try another code.',
  RACE_IN_PROGRESS: 'That room is in a race right now. Try again when it ends.',
  TOO_MANY_ROOMS: 'The game server is busy. Try again in a few minutes.',
  NOT_HOST: 'Only the host can start the race.',
  NOT_ENOUGH_PLAYERS: 'You need at least 2 players to start.',
  PLAYERS_NOT_READY: 'At least one more player needs to press Race again before you can start.',
  NOT_WAITING: 'The room is not waiting for a race.',
  ROOM_EXPIRED: 'The room closed because no race started for 10 minutes. You are playing solo.',
  RATE_LIMITED: 'Too many requests. Wait a moment and try again.',
  UNREACHABLE: 'Could not reach the multiplayer server. It may still be starting up, so try again in a minute. You are playing solo.',
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
    ROOM_CODE_PATTERN,
    ROOM_CODE_FORMAT_MESSAGE,
    SOLO_TIP,
    SIT_OUT_MESSAGE,
    resolveServerUrl,
    isServerUsable,
    isLoopbackUrl,
    connectBudgetMs,
    retryDelayWithin,
    pickServerUrl,
    normalizeRoomCode,
    isValidRoomCode,
    roomCodeInputError,
    parseRoomHash,
    buildShareLink,
    spellRoomCode,
    appendKey,
    isSendableKey,
    validateRoomState,
    validateCountdown,
    validateRaceStart,
    validateRaceUpdate,
    validatePlayerFinish,
    validateRaceEnd,
    validateJoinAck,
    validateRoomAck,
    validateRematchAck,
    validateStartAck,
    findSelf,
    isSittingOut,
    readyCount,
    canStartRace,
    startHint,
    isAloneInLobby,
    hostChangeText,
    labelFor,
    ordinal,
    crossedMilestone,
    errorMessage,
    formatRaceTime,
  };
}
