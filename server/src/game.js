'use strict';

/* Socket.io wiring: handlers, timers and broadcasts. The rules live in
   race.js; this file turns socket events into calls on it and emits the
   results in the exact order docs/PROTOCOL.md gives. */

const { randomUUID } = require('node:crypto');
const constants = require('./constants');
const race = require('./race');
const { validateJoin, validateProgress, validateRematch } = require('./validate');
const { createBucket, takeToken } = require('./rateLimit');
const { createMemoryRoomStore } = require('./roomStore');
const { generateChars, WORDS } = require('./shared');

const { ROOM_ID, ERROR_CODES, PASSAGE_MAX_LENGTH, RATE_LIMIT_ERROR_INTERVAL_MS } = constants;

// Same control-character rule the client applies to the passage.
const PASSAGE_FORBIDDEN_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

function defaultPickPassage() {
  return generateChars(constants.PASSAGE_WORD_COUNT, WORDS).join('');
}

/** Guards against a bad pickPassage override before any room state changes. */
function assertValidPassage(passage) {
  if (
    typeof passage !== 'string' ||
    passage.length < 1 ||
    passage.length > PASSAGE_MAX_LENGTH ||
    PASSAGE_FORBIDDEN_CHARS.test(passage)
  ) {
    throw new Error('pickPassage returned an invalid passage');
  }
}

function errorBody(code, message) {
  return { code, message };
}

function failAck(code, message) {
  return { ok: false, error: errorBody(code, message) };
}

/** Splits a trailing ack function off the handler arguments. */
function takeAck(args) {
  if (args.length > 0 && typeof args[args.length - 1] === 'function') {
    return { ack: args[args.length - 1], payload: args.length > 1 ? args[0] : undefined };
  }
  return { ack: null, payload: args[0] };
}

/** Wraps an ack so the error path knows whether it was already answered. */
function onceAck(ack) {
  const wrapped = (response) => {
    if (wrapped.called) return;
    wrapped.called = true;
    ack(response);
  };
  wrapped.called = false;
  return wrapped;
}

function registerGame(io, options = {}) {
  const store = options.store || createMemoryRoomStore();
  const now = options.now || (() => performance.now());
  const pickPassage = options.pickPassage || defaultPickPassage;
  const countdownMs = options.countdownMs ?? constants.COUNTDOWN_MS;
  const raceTimeLimitMs = options.raceTimeLimitMs ?? constants.RACE_TIME_LIMIT_MS;
  const broadcastIntervalMs = options.broadcastIntervalMs ?? constants.BROADCAST_INTERVAL_MS;
  const rematchTimeoutMs = options.rematchTimeoutMs ?? constants.REMATCH_TIMEOUT_MS;
  const joinTimeoutMs = options.joinTimeoutMs ?? constants.JOIN_TIMEOUT_MS;
  const rateLimit = {
    capacity: options.rateLimit?.capacity ?? constants.RATE_LIMIT_CAPACITY,
    refillPerSec: options.rateLimit?.refillPerSec ?? constants.RATE_LIMIT_REFILL_PER_SEC,
  };
  const roomLimits = {
    maxPlayers: options.maxPlayers ?? constants.MAX_PLAYERS,
    minPlayers: options.minPlayers ?? constants.MIN_PLAYERS,
  };

  // roomId -> { countdown, raceLimit, broadcast, rematch }. Every entry is removed by
  // clearRoomTimers, so this map never outgrows the number of live rooms.
  const timers = new Map();

  /* ---------- Timers ---------- */

  function roomTimers(roomId) {
    let entry = timers.get(roomId);
    if (!entry) {
      entry = { countdown: null, raceLimit: null, broadcast: null, rematch: null };
      timers.set(roomId, entry);
    }
    return entry;
  }

  function clearRoomTimers(roomId) {
    const entry = timers.get(roomId);
    if (!entry) return;
    clearTimeout(entry.countdown);
    clearTimeout(entry.raceLimit);
    clearInterval(entry.broadcast);
    clearTimeout(entry.rematch);
    timers.delete(roomId);
  }

  function clearAllTimers() {
    for (const roomId of [...timers.keys()]) clearRoomTimers(roomId);
  }

  // Timer callbacks have no socket to answer, so errors are only logged.
  function safeTimer(fn) {
    return () => {
      try {
        fn();
      } catch (err) {
        console.error('[game] timer error', err);
      }
    };
  }

  /* ---------- Emitting ---------- */

  function emitError(socket, code, message) {
    socket.emit('game:error', errorBody(code, message));
  }

  function emitRoomState(room) {
    io.to(room.id).emit('room:state', race.toSnapshot(room));
  }

  function deleteRoom(roomId) {
    clearRoomTimers(roomId);
    store.deleteRoom(roomId);
  }

  /* ---------- Phase changes ---------- */

  /** A broken custom picker must not leave the room stuck, so fall back. */
  function choosePassage() {
    try {
      const passage = pickPassage();
      assertValidPassage(passage);
      return passage;
    } catch (err) {
      console.error('[game] pickPassage failed; using the default picker', err);
    }
    const passage = defaultPickPassage();
    assertValidPassage(passage);
    return passage;
  }

  function startCountdown(room) {
    const passage = choosePassage();

    race.beginCountdown(room, passage, now(), countdownMs);
    store.saveRoom(room);
    clearRoomTimers(room.id);
    roomTimers(room.id).countdown = setTimeout(safeTimer(() => onCountdownDone(room.id)), countdownMs);

    emitRoomState(room);
    io.to(room.id).emit('race:countdown', { passage, startsInMs: countdownMs, raceTimeLimitMs });
  }

  function onCountdownDone(roomId) {
    const entry = timers.get(roomId);
    if (entry) entry.countdown = null;
    const room = store.getRoom(roomId);
    if (!room || room.phase !== 'countdown') return;

    race.beginRace(room, now());
    store.saveRoom(room);
    const roomEntry = roomTimers(roomId);
    roomEntry.raceLimit = setTimeout(safeTimer(() => finishRace(roomId, 'time_limit')), raceTimeLimitMs);
    roomEntry.broadcast = setInterval(safeTimer(() => broadcastIfDirty(roomId)), broadcastIntervalMs);

    emitRoomState(room);
    io.to(roomId).emit('race:start', { raceTimeLimitMs });
  }

  function broadcastIfDirty(roomId) {
    const room = store.getRoom(roomId);
    if (!room || room.phase !== 'racing' || !room.dirty) return;
    room.dirty = false;
    store.saveRoom(room);
    io.to(roomId).emit('race:update', race.buildProgress(room, now()));
  }

  /** "Ending a race" in PROTOCOL.md section 3. */
  function finishRace(roomId, reason) {
    const room = store.getRoom(roomId);
    if (!room || room.phase !== 'racing') return;
    clearRoomTimers(roomId);

    const endedAt = now();
    io.to(roomId).emit('race:update', race.buildProgress(room, endedAt));
    const results = race.buildResults(room, endedAt);
    race.endRace(room);
    store.saveRoom(room);
    // Without this, one idle tab keeps the only room in 'finished' forever.
    roomTimers(roomId).rematch = setTimeout(safeTimer(() => onRematchTimeout(roomId)), rematchTimeoutMs);

    io.to(roomId).emit('race:end', { reason, results });
    emitRoomState(room);
  }

  /** Disconnects every player who has not pressed "Race again". */
  function onRematchTimeout(roomId) {
    const entry = timers.get(roomId);
    if (entry) entry.rematch = null;
    const room = store.getRoom(roomId);
    if (!room || room.phase !== 'finished') return;

    // Collect first: each disconnect runs onDisconnect, which edits room.players.
    const idleSocketIds = room.players.filter((player) => !player.ready).map((player) => player.socketId);
    for (const socketId of idleSocketIds) {
      const socket = io.sockets.sockets.get(socketId);
      if (!socket || !socket.connected) continue;
      // Engine.io flushes queued packets before closing, so the error arrives first.
      emitError(socket, ERROR_CODES.IDLE_TIMEOUT, 'You were idle after the race and left the room');
      socket.disconnect(true);
    }
  }

  /** The start check; runs after every join, leave and rematch in waiting/finished. */
  function runStartCheck(room) {
    const next = race.shouldStartCountdown(room);
    if (next === 'countdown') {
      startCountdown(room);
    } else if (next === 'waiting') {
      // Leaving 'finished': the rematch timer is the only one running.
      clearRoomTimers(room.id);
      race.markWaiting(room);
      store.saveRoom(room);
      emitRoomState(room);
    }
  }

  /* ---------- Handlers ---------- */

  function clearJoinTimers(socket) {
    clearTimeout(socket.data.joinTimer);
    clearImmediate(socket.data.kickTimer);
    socket.data.joinTimer = null;
    socket.data.kickTimer = null;
  }

  /**
   * Answers a failed join, then drops the socket on the next tick so the ack
   * is written first. A socket that is already in the room (ALREADY_JOINED)
   * keeps its seat and is not disconnected.
   */
  function failJoin(socket, ack, code, message) {
    ack(failAck(code, message));
    if (socket.data.playerId || socket.data.kickTimer) return;
    socket.data.kickTimer = setImmediate(() => {
      socket.data.kickTimer = null;
      if (socket.connected && !socket.data.playerId) socket.disconnect(true);
    });
  }

  function onJoin(socket, payload, ack) {
    if (!ack) {
      emitError(socket, ERROR_CODES.BAD_PAYLOAD, 'room:join requires an acknowledgement callback');
      return;
    }
    const check = validateJoin(payload);
    if (!check.ok) {
      failJoin(socket, ack, check.code, check.message);
      return;
    }

    const room = store.getRoom(ROOM_ID) || race.createRoom(ROOM_ID, roomLimits);
    const added = race.addPlayer(room, { id: randomUUID(), socketId: socket.id });
    if (!added.ok) {
      failJoin(socket, ack, added.code, `Cannot join: ${added.code}`);
      return;
    }

    store.saveRoom(room);
    socket.data.playerId = added.player.id;
    clearJoinTimers(socket);
    socket.join(room.id);

    ack({ ok: true, playerId: added.player.id, room: race.toSnapshot(room) });
    emitRoomState(room);
    runStartCheck(room);
  }

  function onProgress(socket, payload) {
    const check = validateProgress(payload);
    if (!check.ok) {
      emitError(socket, check.code, check.message);
      return;
    }
    const room = store.getRoom(ROOM_ID);
    const player = room ? race.findPlayer(room, socket.id) : null;
    if (!player) {
      emitError(socket, ERROR_CODES.NOT_IN_ROOM, 'Join the room first');
      return;
    }

    // Expected during normal play (early keys, late keys, duplicates): no error.
    if (room.phase !== 'racing' || player.finishedAt !== null) return;
    if (check.value.seq <= player.lastSeq) return;
    player.lastSeq = check.value.seq;

    const outcome = race.applyKeys(room, player, check.value.keys, now());
    store.saveRoom(room);
    if (!outcome.finished) return;

    io.to(room.id).emit('player:finish', race.buildFinish(room, player));
    if (race.isRaceOver(room)) finishRace(room.id, 'all_finished');
  }

  function onRematch(socket, payload, ack) {
    if (!ack) {
      emitError(socket, ERROR_CODES.BAD_PAYLOAD, 'race:rematch requires an acknowledgement callback');
      return;
    }
    const check = validateRematch(payload);
    if (!check.ok) {
      ack(failAck(check.code, check.message));
      return;
    }
    const room = store.getRoom(ROOM_ID);
    const player = room ? race.findPlayer(room, socket.id) : null;
    if (!player) {
      ack(failAck(ERROR_CODES.NOT_IN_ROOM, 'Join the room first'));
      return;
    }
    // The room already moved to waiting after this player's own rematch.
    // The start check emits only if it changes the phase.
    if (room.phase === 'waiting' && player.ready) {
      ack({ ok: true, room: race.toSnapshot(room) });
      runStartCheck(room);
      return;
    }
    if (room.phase !== 'finished') {
      ack(failAck(ERROR_CODES.NOT_FINISHED, 'The race has not finished'));
      return;
    }

    race.setReady(room, socket.id);
    store.saveRoom(room);
    ack({ ok: true, room: race.toSnapshot(room) });
    emitRoomState(room);
    runStartCheck(room);
  }

  function onDisconnect(socket) {
    // Drop everything held per socket; nothing outlives this handler.
    clearJoinTimers(socket);
    socket.data.bucket = null;
    socket.data.playerId = null;

    const room = store.getRoom(ROOM_ID);
    if (!room) return;
    const { player } = race.removePlayer(room, socket.id, now());
    if (!player) return;

    if (room.phase === 'racing') {
      if (race.connectedPlayers(room).length === 0) {
        deleteRoom(room.id);
        return;
      }
      store.saveRoom(room);
      emitRoomState(room);
      if (race.isRaceOver(room)) finishRace(room.id, 'all_finished');
      return;
    }

    if (room.players.length === 0) {
      deleteRoom(room.id);
      return;
    }
    if (room.phase === 'countdown' && room.players.length < room.minPlayers) {
      clearRoomTimers(room.id);
      race.cancelCountdown(room);
    }
    store.saveRoom(room);
    emitRoomState(room);
    runStartCheck(room);
  }

  /* ---------- Wiring ---------- */

  /** try/catch around every handler: a throw answers INTERNAL and never crashes. */
  function safeHandler(socket, handler) {
    return (...args) => {
      const { ack, payload } = takeAck(args);
      const answer = ack ? onceAck(ack) : null;
      try {
        handler(socket, payload, answer);
      } catch (err) {
        console.error('[game] handler error', err);
        if (answer && !answer.called) answer(failAck(ERROR_CODES.INTERNAL, 'Internal server error'));
        else if (socket.connected) emitError(socket, ERROR_CODES.INTERNAL, 'Internal server error');
      }
    };
  }

  /** One token per incoming event; an empty bucket drops the event. */
  function rateLimitMiddleware(socket) {
    return (packet, next) => {
      const bucket = socket.data.bucket;
      if (bucket && takeToken(bucket, now())) {
        next();
        return;
      }
      const last = packet[packet.length - 1];
      const message = 'Too many events; slow down';
      if (typeof last === 'function') {
        last(failAck(ERROR_CODES.RATE_LIMITED, message));
        return;
      }
      const t = now();
      if (t - socket.data.lastRateErrorAt >= RATE_LIMIT_ERROR_INTERVAL_MS) {
        socket.data.lastRateErrorAt = t;
        emitError(socket, ERROR_CODES.RATE_LIMITED, message);
      }
    };
  }

  io.on('connection', (socket) => {
    socket.data.bucket = createBucket(rateLimit.capacity, rateLimit.refillPerSec, now());
    socket.data.lastRateErrorAt = -Infinity;
    socket.data.playerId = null;
    socket.data.kickTimer = null;
    // A socket that never joins would otherwise hold a connection slot forever.
    socket.data.joinTimer = setTimeout(() => {
      socket.data.joinTimer = null;
      if (socket.connected && !socket.data.playerId) socket.disconnect(true);
    }, joinTimeoutMs);

    socket.use(rateLimitMiddleware(socket));
    socket.on('room:join', safeHandler(socket, onJoin));
    socket.on('race:progress', safeHandler(socket, onProgress));
    socket.on('race:rematch', safeHandler(socket, onRematch));
    socket.on('disconnect', safeHandler(socket, onDisconnect));
  });

  return { clearAllTimers, store };
}

module.exports = { registerGame, defaultPickPassage };
