'use strict';

/* Room state machine and scoring. Everything here is pure: `now` is passed
   in and never read from a clock, and the passage is chosen by the caller.
   game.js owns sockets and timers; this file owns the rules.

   Lifecycle (PROTOCOL.md section 3): waiting -> countdown -> racing -> finished,
   then finished -> countdown (rematch) or finished -> waiting. */

const { computeStats } = require('./shared');
const { BACKSPACE, ERROR_CODES } = require('./constants');

const WPM_MAX = 1000;
const RAW_WPM_MAX = 5000;
// Stats are computed over at least one second, so a burst in the first
// milliseconds cannot report absurd speeds (PROTOCOL.md section 5, race:update).
const MIN_STATS_ELAPSED_MS = 1000;

/* ---------- Creation and membership ---------- */

function createRoom(id, { maxPlayers, minPlayers }) {
  return {
    id,
    phase: 'waiting',
    maxPlayers,
    minPlayers,
    players: [],
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

function createPlayer(id, socketId, slot) {
  const player = { id, socketId, slot, connected: true, ready: true };
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
  const player = createPlayer(id, socketId, lowestFreeSlot(room));
  room.players.push(player);
  sortBySlot(room);
  return { ok: true, player };
}

/**
 * During a race the player stays in the room as disconnected, so their
 * frozen numbers still appear in the results. Otherwise they are removed.
 * `removed` is true when the player left the array; `player` is null if
 * the socket was not in the room.
 */
function removePlayer(room, socketId, now) {
  const player = findPlayer(room, socketId);
  if (!player) return { removed: false, player: null };

  if (room.phase === 'racing') {
    player.connected = false;
    player.leftAt = now;
    room.dirty = true;
    return { removed: false, player };
  }
  room.players = room.players.filter((p) => p !== player);
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

/* ---------- Phase transitions ---------- */

/** The start check from PROTOCOL.md section 3. */
function shouldStartCountdown(room) {
  if (room.phase !== 'waiting' && room.phase !== 'finished') return null;
  const allReady = room.players.length > 0 && room.players.every((player) => player.ready);
  if (allReady && room.players.length >= room.minPlayers) return 'countdown';
  if (room.phase === 'finished' && allReady) return 'waiting';
  return null;
}

/** `passage` is a string; it is stored as an array of chars like generateChars. */
function beginCountdown(room, passage, now, countdownMs) {
  room.phase = 'countdown';
  room.passage = passage.split('');
  room.startAt = now + countdownMs;
  room.finishCount = 0;
  room.dirty = false;
  for (const player of room.players) resetRaceFields(player, room.passage.length);
}

/** Back to waiting when a player leaves during the countdown. */
function cancelCountdown(room) {
  room.phase = 'waiting';
  room.passage = null;
  room.startAt = null;
  room.finishCount = 0;
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
  if (room.phase !== 'racing' || !player.connected || player.finishedAt !== null) {
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

/** At least one connected player, and every connected player has finished. */
function isRaceOver(room) {
  const connected = connectedPlayers(room);
  return connected.length > 0 && connected.every((player) => player.finishedAt !== null);
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

/** Payload for race:update. */
function buildProgress(room, now) {
  return {
    elapsedMs: Math.max(0, Math.round(now - room.startAt)),
    players: room.players.map((player) => {
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

/** Payload `results` for race:end (PROTOCOL.md section 6). */
function buildResults(room, now) {
  const entries = room.players.map((player) => {
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

/** Phase finished, drop disconnected players, everyone must press rematch. */
function endRace(room) {
  room.phase = 'finished';
  room.players = room.players.filter((player) => player.connected);
  for (const player of room.players) player.ready = false;
  room.dirty = false;
}

/** RoomSnapshot (PROTOCOL.md section 5). Never includes socket ids. */
function toSnapshot(room) {
  return {
    phase: room.phase,
    maxPlayers: room.maxPlayers,
    players: [...room.players]
      .sort((a, b) => a.slot - b.slot)
      .map((player) => ({
        id: player.id,
        slot: player.slot,
        connected: player.connected,
        ready: player.ready,
        finished: player.finishedAt !== null,
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
  shouldStartCountdown,
  beginCountdown,
  cancelCountdown,
  beginRace,
  markWaiting,
  applyKeys,
  isRaceOver,
  buildProgress,
  buildFinish,
  buildResults,
  endRace,
  toSnapshot,
};
