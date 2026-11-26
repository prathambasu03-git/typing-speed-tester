'use strict';

/* Room state machine and scoring. Everything here is pure: `now` is passed
   in and never read from a clock, and the passage is chosen by the caller.
   game.js owns sockets and timers; this file owns the rules.

   Lifecycle (PROTOCOL.md section 3): waiting -> countdown -> racing -> finished,
   then finished -> countdown (host start with the ready players) or
   finished -> waiting (everyone ready). Also countdown -> waiting (too few
   racers) and racing -> waiting (every racer gone, sat-out players remain).

   Per player: `joinSeq` (host succession order, never reused), `ready`
   (in the lobby for the next race) and `inRace` (in the current or last race).
   A player with inRace false during countdown/racing is sitting out and
   never affects the race. */

const { computeStats } = require('./shared');
const { BACKSPACE, ERROR_CODES } = require('./constants');

const WPM_MAX = 1000;
const RAW_WPM_MAX = 5000;
// Stats are computed over at least one second, so a burst in the first
// milliseconds cannot report absurd speeds (PROTOCOL.md section 5, race:update).
const MIN_STATS_ELAPSED_MS = 1000;

/* ---------- Creation and membership ---------- */

/** `code` is the room code; it doubles as the store key and Socket.io room name. */
function createRoom(code, { maxPlayers, minPlayers }) {
  return {
    id: code,
    phase: 'waiting',
    maxPlayers,
    minPlayers,
    players: [],
    hostId: null,
    lobbyDeadline: null,
    nextJoinSeq: 1,
    passage: null,
    startAt: null,
    finishCount: 0,
    dirty: false,
  };
}

function resetRaceFields(player, passageLength) {
  player.index = 0;
  player.results = new Array(passageLength).fill(null);
  player.totalKeystrokes = 0;
  player.correctKeystrokes = 0;
  player.correctCount = 0;
  player.incorrectCount = 0;
  player.lastSeq = 0;
  player.finishedAt = null;
  player.leftAt = null;
  player.place = null;
}

function createPlayer(id, socketId, slot, joinSeq) {
  const player = { id, socketId, slot, joinSeq, connected: true, ready: true, inRace: false };
  resetRaceFields(player, 0);
  return player;
}

function findPlayer(room, socketId) {
  return room.players.find((player) => player.socketId === socketId) || null;
}

function lowestFreeSlot(room) {
  const taken = new Set(room.players.map((player) => player.slot));
  let slot = 1;
  while (taken.has(slot)) slot += 1;
  return slot;
}

function sortBySlot(room) {
  room.players.sort((a, b) => a.slot - b.slot);
}

/** Error order from PROTOCOL.md: ALREADY_JOINED, ROOM_FULL, RACE_IN_PROGRESS. */
function addPlayer(room, { id, socketId }) {
  if (findPlayer(room, socketId)) return { ok: false, code: ERROR_CODES.ALREADY_JOINED };
  if (room.players.length >= room.maxPlayers) return { ok: false, code: ERROR_CODES.ROOM_FULL };
  if (room.phase === 'countdown' || room.phase === 'racing') {
    return { ok: false, code: ERROR_CODES.RACE_IN_PROGRESS };
  }
  const player = createPlayer(id, socketId, lowestFreeSlot(room), room.nextJoinSeq);
  room.nextJoinSeq += 1;
  room.players.push(player);
  sortBySlot(room);
  if (room.hostId === null) room.hostId = player.id;
  return { ok: true, player };
}

function isHost(room, playerId) {
  return room.hostId !== null && room.hostId === playerId;
}

/**
 * Keeps the host while it is a connected member; otherwise passes it to the
 * connected player who joined earliest (smallest joinSeq), or null. Join
 * order, not slot: slots are reused, so a later joiner in a freed slot must
 * not jump the queue. Returns true if hostId changed.
 */
function reassignHost(room) {
  const current = room.players.find((p) => p.id === room.hostId);
  if (current && current.connected) return false;

  let next = null;
  for (const player of room.players) {
    if (player.connected && (next === null || player.joinSeq < next.joinSeq)) next = player;
  }
  const nextId = next ? next.id : null;
  const changed = nextId !== room.hostId;
  room.hostId = nextId;
  return changed;
}

/**
 * During a race a racer stays in the room as disconnected, so their frozen
 * numbers still appear in the results. Anyone else (including a player
 * sitting out the race) is removed. `removed` is true when the player left
 * the array; `player` is null if the socket was not in the room. The host is
 * passed on in every branch.
 */
function removePlayer(room, socketId, now) {
  const player = findPlayer(room, socketId);
  if (!player) return { removed: false, player: null };

  if (room.phase === 'racing' && player.inRace) {
    player.connected = false;
    player.leftAt = now;
    room.dirty = true;
    reassignHost(room);
    return { removed: false, player };
  }
  room.players = room.players.filter((p) => p !== player);
  reassignHost(room);
  return { removed: true, player };
}

function setReady(room, socketId) {
  const player = findPlayer(room, socketId);
  if (!player) return { ok: false, code: ERROR_CODES.NOT_IN_ROOM };
  player.ready = true;
  return { ok: true };
}

function connectedPlayers(room) {
  return room.players.filter((player) => player.connected);
}

/** Players in the current (or last) race. */
function racers(room) {
  return room.players.filter((player) => player.inRace);
}

function hasConnectedRacer(room) {
  return room.players.some((player) => player.inRace && player.connected);
}

/** Entering waiting: nobody is in a race and everyone is a lobby player. */
function seatNobody(room) {
  for (const player of room.players) {
    player.inRace = false;
    player.ready = true;
  }
}

/* ---------- Phase transitions ---------- */

/** The return check from PROTOCOL.md section 3. It never starts a countdown. */
function shouldReturnToWaiting(room) {
  return (
    room.phase === 'finished' && room.players.length > 0 && room.players.every((player) => player.ready)
  );
}

/** The start check from PROTOCOL.md section 3, errors in protocol order. */
function canStart(room, playerId) {
  if (!isHost(room, playerId)) return { ok: false, code: ERROR_CODES.NOT_HOST };
  if (room.phase === 'countdown' || room.phase === 'racing') {
    return { ok: false, code: ERROR_CODES.RACE_IN_PROGRESS };
  }
  if (room.players.length < room.minPlayers) return { ok: false, code: ERROR_CODES.NOT_ENOUGH_PLAYERS };
  // The host's room:start counts as the host's own "Race again".
  if (
    room.phase === 'finished' &&
    room.players.filter((p) => p.ready || p.id === playerId).length < room.minPlayers
  ) {
    return { ok: false, code: ERROR_CODES.PLAYERS_NOT_READY };
  }
  return { ok: true };
}

/**
 * Seats the racers (the ready players plus the host; in waiting that is
 * everyone), then makes every player ready: players who had not pressed
 * "Race again" now sit out and are lobby players for the next race.
 * `passage` is a string; it is stored as an array of chars like generateChars.
 */
function beginCountdown(room, passage, now, countdownMs) {
  for (const player of room.players) {
    player.inRace = player.ready || player.id === room.hostId;
    player.ready = true;
  }
  room.phase = 'countdown';
  room.passage = passage.split('');
  room.startAt = now + countdownMs;
  room.finishCount = 0;
  room.dirty = false;
  for (const player of racers(room)) resetRaceFields(player, room.passage.length);
}

/** Back to waiting when too few racers are left during the countdown. */
function cancelCountdown(room) {
  room.phase = 'waiting';
  room.passage = null;
  room.startAt = null;
  room.finishCount = 0;
  seatNobody(room);
}

/**
 * `now` is optional: when given, the race clock starts at the real moment the
 * countdown timer fired, so a late timer does not shorten anyone's race.
 */
function beginRace(room, now) {
  room.phase = 'racing';
  if (typeof now === 'number') room.startAt = now;
  room.dirty = false;
}

function markWaiting(room) {
  room.phase = 'waiting';
  seatNobody(room);
}

/**
 * racing -> waiting when every racer has gone but players who sat out
 * remain. No results: the race simply stops.
 */
function abandonRace(room) {
  room.phase = 'waiting';
  room.passage = null;
  room.startAt = null;
  room.finishCount = 0;
  room.dirty = false;
  room.players = room.players.filter((player) => player.connected);
  seatNobody(room);
  reassignHost(room);
}

/* ---------- Typing ---------- */

function applyBackspace(player) {
  if (player.index === 0) return false;
  player.index -= 1;
  const previous = player.results[player.index];
  if (previous === 'correct') player.correctCount -= 1;
  else if (previous === 'incorrect') player.incorrectCount -= 1;
  player.results[player.index] = null;
  return true;
}

function applyCharacter(room, player, ch) {
  if (player.index >= room.passage.length) return false;
  const correct = ch === room.passage[player.index];
  player.results[player.index] = correct ? 'correct' : 'incorrect';
  if (correct) {
    player.correctCount += 1;
    player.correctKeystrokes += 1;
  } else {
    player.incorrectCount += 1;
  }
  player.totalKeystrokes += 1;
  player.index += 1;
  return true;
}

function hasCompletedPassage(room, player) {
  return player.index === room.passage.length && player.incorrectCount === 0;
}

/**
 * Replays keystrokes against the server's passage (mirrors handleCharacter
 * and handleBackspace in script.js). The server alone decides correctness,
 * position and the finish.
 */
function applyKeys(room, player, keys, now) {
  // A player sitting out can never move, finish or affect the race.
  if (room.phase !== 'racing' || !player.inRace || !player.connected || player.finishedAt !== null) {
    return { changed: false, finished: false };
  }

  let changed = false;
  for (const ch of keys) {
    const applied = ch === BACKSPACE ? applyBackspace(player) : applyCharacter(room, player, ch);
    if (applied) changed = true;
    if (hasCompletedPassage(room, player)) {
      room.finishCount += 1;
      player.finishedAt = now;
      player.place = room.finishCount;
      room.dirty = true;
      // Remaining keys in this event are ignored once the passage is done.
      return { changed: true, finished: true };
    }
  }
  if (changed) room.dirty = true;
  return { changed, finished: false };
}

/** At least one connected racer, and every connected racer has finished. */
function isRaceOver(room) {
  const live = racers(room).filter((player) => player.connected);
  return live.length > 0 && live.every((player) => player.finishedAt !== null);
}

/* ---------- Scoring ---------- */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Elapsed race time for one player, frozen at finish or leave (PROTOCOL.md section 6). */
function elapsedFor(room, player, now) {
  let end = now;
  if (player.finishedAt !== null) end = player.finishedAt;
  else if (player.leftAt !== null) end = player.leftAt;
  return Math.max(0, end - room.startAt);
}

function statsFor(room, player, now) {
  const elapsedMs = elapsedFor(room, player, now);
  const stats = computeStats(
    {
      results: player.results,
      totalKeystrokes: player.totalKeystrokes,
      correctKeystrokes: player.correctKeystrokes,
      duration: null,
    },
    Math.max(elapsedMs, MIN_STATS_ELAPSED_MS)
  );
  return {
    elapsedMs,
    wpm: clamp(stats.wpm, 0, WPM_MAX),
    rawWpm: clamp(stats.rawWpm, 0, RAW_WPM_MAX),
    accuracy: clamp(stats.accuracy, 0, 100),
    correctChars: stats.correctChars,
    incorrectChars: stats.incorrectChars,
  };
}

function progressPercent(room, player) {
  if (!room.passage || room.passage.length === 0) return 0;
  return clamp(Math.floor((player.correctCount * 100) / room.passage.length), 0, 100);
}

/** Payload for race:update (racers only). */
function buildProgress(room, now) {
  return {
    elapsedMs: Math.max(0, Math.round(now - room.startAt)),
    players: racers(room).map((player) => {
      const stats = statsFor(room, player, now);
      return {
        id: player.id,
        correctChars: player.correctCount,
        progress: progressPercent(room, player),
        wpm: stats.wpm,
        accuracy: stats.accuracy,
        finished: player.finishedAt !== null,
        place: player.place,
      };
    }),
  };
}

/** Payload for player:finish. */
function buildFinish(room, player) {
  const stats = statsFor(room, player, player.finishedAt);
  return {
    id: player.id,
    place: player.place,
    timeMs: Math.round(stats.elapsedMs),
    wpm: stats.wpm,
    accuracy: stats.accuracy,
  };
}

function statusFor(player) {
  if (player.finishedAt !== null) return 'finished';
  if (!player.connected) return 'left';
  return 'unfinished';
}

const STATUS_RANK = Object.freeze({ finished: 0, unfinished: 1, left: 2 });

function compareResults(a, b) {
  if (a.status !== b.status) return STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (a.status === 'finished') return a.finishPlace - b.finishPlace;
  if (a.correctChars !== b.correctChars) return b.correctChars - a.correctChars;
  if (a.accuracy !== b.accuracy) return b.accuracy - a.accuracy;
  return a.slot - b.slot;
}

/** Payload `results` for race:end (PROTOCOL.md section 6), racers only. */
function buildResults(room, now) {
  const entries = racers(room).map((player) => {
    const stats = statsFor(room, player, now);
    return {
      id: player.id,
      slot: player.slot,
      status: statusFor(player),
      finishPlace: player.place,
      wpm: stats.wpm,
      rawWpm: stats.rawWpm,
      accuracy: stats.accuracy,
      correctChars: stats.correctChars,
      incorrectChars: stats.incorrectChars,
      timeMs: Math.round(stats.elapsedMs),
    };
  });
  entries.sort(compareResults);
  return entries.map((entry, i) => ({
    id: entry.id,
    slot: entry.slot,
    place: i + 1,
    status: entry.status,
    wpm: entry.wpm,
    rawWpm: entry.rawWpm,
    accuracy: entry.accuracy,
    correctChars: entry.correctChars,
    incorrectChars: entry.incorrectChars,
    timeMs: entry.timeMs,
  }));
}

/**
 * Phase finished, drop disconnected players; every racer must press
 * "Race again". Players who sat out stay ready (already in the lobby).
 */
function endRace(room) {
  room.phase = 'finished';
  room.players = room.players.filter((player) => player.connected);
  for (const player of room.players) {
    if (player.inRace) player.ready = false;
  }
  room.dirty = false;
  reassignHost(room);
}

/**
 * RoomSnapshot (PROTOCOL.md section 5). Never includes socket ids, joinSeq
 * or IPs. `now` gives the lobby time left.
 */
function toSnapshot(room, now) {
  const expiresInMs =
    room.phase === 'waiting' && room.lobbyDeadline !== null
      ? Math.max(0, Math.round(room.lobbyDeadline - now))
      : null;
  return {
    code: room.id,
    phase: room.phase,
    maxPlayers: room.maxPlayers,
    minPlayers: room.minPlayers,
    hostId: room.hostId,
    expiresInMs,
    players: [...room.players]
      .sort((a, b) => a.slot - b.slot)
      .map((player) => ({
        id: player.id,
        slot: player.slot,
        connected: player.connected,
        ready: player.ready,
        inRace: player.inRace,
        // finishedAt can be left over from an earlier race; only a racer counts.
        finished: player.inRace && player.finishedAt !== null,
      })),
  };
}

module.exports = {
  createRoom,
  addPlayer,
  removePlayer,
  setReady,
  findPlayer,
  connectedPlayers,
  racers,
  hasConnectedRacer,
  isHost,
  reassignHost,
  shouldReturnToWaiting,
  canStart,
  beginCountdown,
  cancelCountdown,
  beginRace,
  markWaiting,
  abandonRace,
  applyKeys,
  isRaceOver,
  buildProgress,
  buildFinish,
  buildResults,
  endRace,
  toSnapshot,
};
