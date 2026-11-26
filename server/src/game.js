'use strict';

/* Socket.io wiring: handlers, timers and broadcasts. The rules live in
   race.js; this file turns socket events into calls on it and emits the
   results in the exact order docs/PROTOCOL.md gives.

   Rooms are private and keyed by their code. A socket enters at most one
   room (socket.data.roomId) through room:create or room:join and stays in it
   until it disconnects. */

const { randomUUID } = require('node:crypto');
const constants = require('./constants');
const race = require('./race');
const {
  validateCreate,
  validateJoin,
  validateStart,
  validateExtend,
  validateProgress,
  validateRematch,
} = require('./validate');
const { createBucket, takeToken } = require('./rateLimit');
const { createIpLimiter } = require('./ipLimiter');
const { isValidRoomCode, createUniqueCode } = require('./roomCode');
const { createMemoryRoomStore } = require('./roomStore');
const { generateChars, WORDS } = require('./shared');

const { ERROR_CODES, PASSAGE_MAX_LENGTH, RATE_LIMIT_ERROR_INTERVAL_MS } = constants;

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
  const ipOf = options.ipOf || null;
  const randomInt = options.randomInt; // undefined -> crypto.randomInt in roomCode.js
  const pickPassage = options.pickPassage || defaultPickPassage;
  const countdownMs = options.countdownMs ?? constants.COUNTDOWN_MS;
  const raceTimeLimitMs = options.raceTimeLimitMs ?? constants.RACE_TIME_LIMIT_MS;
  const broadcastIntervalMs = options.broadcastIntervalMs ?? constants.BROADCAST_INTERVAL_MS;
  const rematchTimeoutMs = options.rematchTimeoutMs ?? constants.REMATCH_TIMEOUT_MS;
  const lobbyTimeoutMs = options.lobbyTimeoutMs ?? constants.LOBBY_TIMEOUT_MS;
  const joinTimeoutMs = options.joinTimeoutMs ?? constants.JOIN_TIMEOUT_MS;
  const maxRooms = options.maxRooms ?? constants.MAX_ROOMS;
  const rateLimit = {
    capacity: options.rateLimit?.capacity ?? constants.RATE_LIMIT_CAPACITY,
    refillPerSec: options.rateLimit?.refillPerSec ?? constants.RATE_LIMIT_REFILL_PER_SEC,
  };
  const roomLimits = {
    maxPlayers: options.maxPlayers ?? constants.MAX_PLAYERS,
    minPlayers: options.minPlayers ?? constants.MIN_PLAYERS,
  };

  // Per-IP limits (PROTOCOL.md section 4). Every create attempt that reaches
  // the check costs a token; only failed joins (BAD_CODE, ROOM_NOT_FOUND) do,
  // so many real players behind one NAT can still join.
  const createLimiter = createIpLimiter({
    capacity: options.createLimit?.capacity ?? constants.CREATE_LIMIT_CAPACITY,
    refillPerSec: options.createLimit?.refillPerSec ?? constants.CREATE_LIMIT_REFILL_PER_SEC,
  });
  const joinFailLimiter = createIpLimiter({
    capacity: options.joinFailLimit?.capacity ?? constants.JOIN_FAIL_LIMIT_CAPACITY,
    refillPerSec: options.joinFailLimit?.refillPerSec ?? constants.JOIN_FAIL_LIMIT_REFILL_PER_SEC,
  });

  // roomId -> { countdown, raceLimit, broadcast, rematch, lobby }. Every entry is
  // removed by clearRoomTimers, so this map never outgrows the number of live rooms.
  const timers = new Map();

  /* ---------- Timers ---------- */

  function roomTimers(roomId) {
    let entry = timers.get(roomId);
    if (!entry) {
      entry = { countdown: null, raceLimit: null, broadcast: null, rematch: null, lobby: null };
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
    clearTimeout(entry.lobby);
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

  /**
   * (Re)starts the lobby timer. An abandoned lobby tab would otherwise keep
   * the room, and a free Render instance, alive around the clock.
   */
  function startLobbyTimer(room) {
    const entry = roomTimers(room.id);
    clearTimeout(entry.lobby);
    room.lobbyDeadline = now() + lobbyTimeoutMs;
    entry.lobby = setTimeout(safeTimer(() => onLobbyTimeout(room.id)), lobbyTimeoutMs);
  }

  /* ---------- Emitting ---------- */

  function emitError(socket, code, message) {
    socket.emit('game:error', errorBody(code, message));
  }

  function snapshot(room) {
    return race.toSnapshot(room, now());
  }

  function emitRoomState(room) {
    io.to(room.id).emit('room:state', snapshot(room));
  }

  function deleteRoom(roomId) {
    clearRoomTimers(roomId);
    store.deleteRoom(roomId);
  }

  /** The live socket for an id, or null if it is gone or closing. */
  function connectedSocket(socketId) {
    const socket = io.sockets.sockets.get(socketId);
    return socket && socket.connected ? socket : null;
  }

  /** Disconnects the given sockets, each told why first. */
  function disconnectWithError(socketIds, code, message) {
    for (const socketId of socketIds) {
      const socket = connectedSocket(socketId);
      if (!socket) continue;
      // Engine.io flushes queued packets before closing, so the error arrives first.
      emitError(socket, code, message);
      socket.disconnect(true);
    }
  }

  /**
   * Removes players whose socket is already gone. Their disconnect handler
   * will never run again, so without this a room could outlive every real
   * player and never be deleted.
   */
  function removeOrphans(roomId) {
    const room = store.getRoom(roomId);
    if (!room) return;
    const orphanIds = room.players
      .filter((player) => connectedSocket(player.socketId) === null)
      .map((player) => player.socketId);
    for (const socketId of orphanIds) {
      const current = store.getRoom(roomId);
      if (!current) return;
      removeFromRoom(current, socketId);
    }
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

  /**
   * From waiting or finished. Clearing every room timer drops the lobby timer
   * and the rematch timer, so players who now sit out can no longer be
   * removed by the old rematch timeout.
   */
  function startCountdown(room) {
    const passage = choosePassage();

    clearRoomTimers(room.id);
    room.lobbyDeadline = null;
    race.beginCountdown(room, passage, now(), countdownMs);
    store.saveRoom(room);
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
    // Without this, one idle tab could hold the room in 'finished' forever.
    roomTimers(roomId).rematch = setTimeout(safeTimer(() => onRematchTimeout(roomId)), rematchTimeoutMs);

    io.to(roomId).emit('race:end', { reason, results });
    emitRoomState(room);
  }

  /** Disconnects every player who raced and has not pressed "Race again". */
  function onRematchTimeout(roomId) {
    const entry = timers.get(roomId);
    if (entry) entry.rematch = null;
    const room = store.getRoom(roomId);
    if (!room || room.phase !== 'finished') return;

    // Collect first: each disconnect runs onDisconnect, which edits room.players.
    const idleSocketIds = room.players.filter((player) => !player.ready).map((player) => player.socketId);
    disconnectWithError(idleSocketIds, ERROR_CODES.IDLE_TIMEOUT, 'You were idle after the race and left the room');
    removeOrphans(roomId);
  }

  /**
   * Closes a lobby in which no race started (PROTOCOL.md section 3): every
   * player gets ROOM_EXPIRED, then all are disconnected. `closing` makes
   * onDisconnect stay silent, so nobody sees "left" or new-host updates for
   * a room that is going away.
   */
  function onLobbyTimeout(roomId) {
    const entry = timers.get(roomId);
    if (entry) entry.lobby = null;
    const room = store.getRoom(roomId);
    if (!room || room.phase !== 'waiting') return;

    room.closing = true;
    store.saveRoom(room);
    // Collect first: each disconnect runs onDisconnect, which edits room.players.
    const sockets = room.players.map((player) => connectedSocket(player.socketId)).filter(Boolean);
    for (const socket of sockets) {
      emitError(socket, ERROR_CODES.ROOM_EXPIRED, 'No race started; the room closed');
    }
    // Engine.io flushes queued packets before closing, so the error arrives first.
    for (const socket of sockets) socket.disconnect(true);
    removeOrphans(roomId);
  }

  /**
   * The return check; runs after every join, leave and rematch in finished.
   * It only ever moves the room to waiting: only room:start starts a race.
   */
  function runReturnCheck(room) {
    if (!race.shouldReturnToWaiting(room)) return;
    // Leaving 'finished': the rematch timer is the only one running.
    clearRoomTimers(room.id);
    race.markWaiting(room);
    startLobbyTimer(room);
    store.saveRoom(room);
    emitRoomState(room);
  }

  /* ---------- Handlers ---------- */

  function roomOf(socket) {
    const roomId = socket.data.roomId;
    return roomId ? store.getRoom(roomId) : null;
  }

  function clearJoinTimers(socket) {
    clearTimeout(socket.data.joinTimer);
    clearImmediate(socket.data.kickTimer);
    socket.data.joinTimer = null;
    socket.data.kickTimer = null;
  }

  /**
   * Answers a failed create or join, then drops the socket on the next tick
   * so the ack is written first. A socket that is already in a room
   * (ALREADY_JOINED) keeps its seat and is not disconnected.
   */
  function failEntry(socket, ack, code, message) {
    ack(failAck(code, message));
    if (socket.data.roomId || socket.data.kickTimer) return;
    socket.data.kickTimer = setImmediate(() => {
      socket.data.kickTimer = null;
      if (socket.connected && !socket.data.roomId) socket.disconnect(true);
    });
  }

  function enterRoom(socket, room, player) {
    socket.data.roomId = room.id;
    socket.data.playerId = player.id;
    clearJoinTimers(socket);
    socket.join(room.id);
  }

  function onCreate(socket, payload, ack) {
    if (!ack) {
      emitError(socket, ERROR_CODES.BAD_PAYLOAD, 'room:create requires an acknowledgement callback');
      return;
    }
    const check = validateCreate(payload);
    if (!check.ok) {
      failEntry(socket, ack, check.code, check.message);
      return;
    }
    if (socket.data.roomId) {
      failEntry(socket, ack, ERROR_CODES.ALREADY_JOINED, 'This connection is already in a room');
      return;
    }
    if (!createLimiter.consume(socket.data.ip, now())) {
      failEntry(socket, ack, ERROR_CODES.RATE_LIMITED, 'Too many rooms created; try again later');
      return;
    }
    if (store.size() >= maxRooms) {
      failEntry(socket, ack, ERROR_CODES.TOO_MANY_ROOMS, 'The server has too many rooms');
      return;
    }
    const code = createUniqueCode((candidate) => store.getRoom(candidate) !== null, randomInt);
    if (code === null) {
      failEntry(socket, ack, ERROR_CODES.TOO_MANY_ROOMS, 'No free room code was found');
      return;
    }

    const room = race.createRoom(code, roomLimits);
    const added = race.addPlayer(room, { id: randomUUID(), socketId: socket.id });
    if (!added.ok) throw new Error(`Cannot seat the creator: ${added.code}`);

    store.saveRoom(room);
    enterRoom(socket, room, added.player);
    startLobbyTimer(room);

    ack({ ok: true, playerId: added.player.id, room: snapshot(room) });
    emitRoomState(room);
  }

  function onJoin(socket, payload, ack) {
    if (!ack) {
      emitError(socket, ERROR_CODES.BAD_PAYLOAD, 'room:join requires an acknowledgement callback');
      return;
    }
    const check = validateJoin(payload);
    if (!check.ok) {
      failEntry(socket, ack, check.code, check.message);
      return;
    }
    if (socket.data.roomId) {
      failEntry(socket, ack, ERROR_CODES.ALREADY_JOINED, 'This connection is already in a room');
      return;
    }
    const ip = socket.data.ip;
    // Peek only: a successful join must not cost a token.
    if (!joinFailLimiter.has(ip, now())) {
      failEntry(socket, ack, ERROR_CODES.RATE_LIMITED, 'Too many failed join attempts; try again later');
      return;
    }
    const { code } = check.value;
    if (!isValidRoomCode(code)) {
      joinFailLimiter.consume(ip, now());
      failEntry(socket, ack, ERROR_CODES.BAD_CODE, 'That is not a valid room code');
      return;
    }
    const room = store.getRoom(code);
    if (!room) {
      joinFailLimiter.consume(ip, now());
      failEntry(socket, ack, ERROR_CODES.ROOM_NOT_FOUND, 'No room has that code');
      return;
    }

    // addPlayer checks ROOM_FULL before RACE_IN_PROGRESS.
    const added = race.addPlayer(room, { id: randomUUID(), socketId: socket.id });
    if (!added.ok) {
      failEntry(socket, ack, added.code, `Cannot join: ${added.code}`);
      return;
    }

    store.saveRoom(room);
    enterRoom(socket, room, added.player);
    if (room.phase === 'waiting') startLobbyTimer(room);

    ack({ ok: true, playerId: added.player.id, room: snapshot(room) });
    emitRoomState(room);
    if (room.phase === 'finished') runReturnCheck(room);
  }

  function onStart(socket, payload, ack) {
    if (!ack) {
      emitError(socket, ERROR_CODES.BAD_PAYLOAD, 'room:start requires an acknowledgement callback');
      return;
    }
    const check = validateStart(payload);
    if (!check.ok) {
      ack(failAck(check.code, check.message));
      return;
    }
    const room = roomOf(socket);
    const player = room ? race.findPlayer(room, socket.id) : null;
    if (!player) {
      ack(failAck(ERROR_CODES.NOT_IN_ROOM, 'Join a room first'));
      return;
    }
    const allowed = race.canStart(room, player.id);
    if (!allowed.ok) {
      ack(failAck(allowed.code, `Cannot start: ${allowed.code}`));
      return;
    }

    ack({ ok: true });
    startCountdown(room);
  }

  function onExtend(socket, payload, ack) {
    if (!ack) {
      emitError(socket, ERROR_CODES.BAD_PAYLOAD, 'room:extend requires an acknowledgement callback');
      return;
    }
    const check = validateExtend(payload);
    if (!check.ok) {
      ack(failAck(check.code, check.message));
      return;
    }
    const room = roomOf(socket);
    const player = room ? race.findPlayer(room, socket.id) : null;
    if (!player) {
      ack(failAck(ERROR_CODES.NOT_IN_ROOM, 'Join a room first'));
      return;
    }
    if (room.phase !== 'waiting') {
      ack(failAck(ERROR_CODES.NOT_WAITING, 'The room is not waiting for a race'));
      return;
    }

    startLobbyTimer(room);
    store.saveRoom(room);
    ack({ ok: true, room: snapshot(room) });
    emitRoomState(room);
  }

  function onProgress(socket, payload) {
    const check = validateProgress(payload);
    if (!check.ok) {
      emitError(socket, check.code, check.message);
      return;
    }
    const room = roomOf(socket);
    const player = room ? race.findPlayer(room, socket.id) : null;
    if (!player) {
      emitError(socket, ERROR_CODES.NOT_IN_ROOM, 'Join a room first');
      return;
    }

    // Expected during normal play (early keys, late keys, duplicates, a
    // player sitting out): no error.
    if (room.phase !== 'racing' || !player.inRace || player.finishedAt !== null) return;
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
    const room = roomOf(socket);
    const player = room ? race.findPlayer(room, socket.id) : null;
    if (!player) {
      ack(failAck(ERROR_CODES.NOT_IN_ROOM, 'Join a room first'));
      return;
    }
    // Idempotent: in waiting every player is already ready. Ack only.
    if (room.phase === 'waiting') {
      ack({ ok: true, room: snapshot(room) });
      return;
    }
    if (room.phase !== 'finished') {
      ack(failAck(ERROR_CODES.NOT_FINISHED, 'The race has not finished'));
      return;
    }

    race.setReady(room, socket.id);
    store.saveRoom(room);
    ack({ ok: true, room: snapshot(room) });
    emitRoomState(room);
    runReturnCheck(room);
  }

  function onDisconnect(socket) {
    // Drop everything held per socket; nothing outlives this handler.
    clearJoinTimers(socket);
    const room = roomOf(socket);
    socket.data.bucket = null;
    socket.data.playerId = null;
    socket.data.roomId = null;

    if (!room) return;
    removeFromRoom(room, socket.id);
  }

  /** The normal removal of one player, shared by onDisconnect and removeOrphans. */
  function removeFromRoom(room, socketId) {
    const { player } = race.removePlayer(room, socketId, now());
    if (!player) return;

    // An expiring lobby: remove silently, delete once empty.
    if (room.closing) {
      if (room.players.length === 0) deleteRoom(room.id);
      else store.saveRoom(room);
      return;
    }

    if (room.phase === 'racing') {
      if (race.connectedPlayers(room).length === 0) {
        deleteRoom(room.id);
        return;
      }
      if (!race.hasConnectedRacer(room)) {
        // Every racer is gone; only players who sat out remain. No race:end.
        clearRoomTimers(room.id);
        race.abandonRace(room);
        startLobbyTimer(room);
        store.saveRoom(room);
        emitRoomState(room);
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
    // A player sitting out leaving never cancels the countdown: count racers.
    if (room.phase === 'countdown' && race.racers(room).length < room.minPlayers) {
      clearRoomTimers(room.id);
      race.cancelCountdown(room);
      startLobbyTimer(room);
    }
    store.saveRoom(room);
    emitRoomState(room);
    if (room.phase === 'finished') runReturnCheck(room);
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
    socket.data.roomId = null;
    socket.data.playerId = null;
    socket.data.kickTimer = null;
    // The same key as the per-IP connection cap (clientIp.js limiterKey, TRUST_PROXY_HOPS).
    socket.data.ip = ipOf ? ipOf(socket.request) : 'unknown';
    // A socket that never enters a room would otherwise hold a connection slot forever.
    socket.data.joinTimer = setTimeout(() => {
      socket.data.joinTimer = null;
      if (socket.connected && !socket.data.roomId) socket.disconnect(true);
    }, joinTimeoutMs);

    socket.use(rateLimitMiddleware(socket));
    socket.on('room:create', safeHandler(socket, onCreate));
    socket.on('room:join', safeHandler(socket, onJoin));
    socket.on('room:start', safeHandler(socket, onStart));
    socket.on('room:extend', safeHandler(socket, onExtend));
    socket.on('race:progress', safeHandler(socket, onProgress));
    socket.on('race:rematch', safeHandler(socket, onRematch));
    socket.on('disconnect', safeHandler(socket, onDisconnect));
  });

  return { clearAllTimers, store };
}

module.exports = { registerGame, defaultPickPassage };
