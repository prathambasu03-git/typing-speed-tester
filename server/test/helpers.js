'use strict';

/* Shared helpers for the socket integration tests. Not a test file itself.

   Every server and client created through `setup(t, ...)` is closed in
   `t.after`, so each test owns and tears down its own state. Waits are
   event-based with a timeout; fixed sleeps are used only to prove that
   something did NOT happen.

   Rooms (M2): the first `ctx.joined()` in a test creates a room (that client
   is `ctx.host`, the code is `ctx.code`); later calls join that code. The
   race never starts by itself: `ctx.start()` sends the host's room:start. */

const { io: ioClient } = require('socket.io-client');
const { createServer } = require('../src/app');

const FIXED_PASSAGE = 'ab cd';

const FAST_OPTIONS = Object.freeze({
  countdownMs: 50,
  raceTimeLimitMs: 2000,
  broadcastIntervalMs: 20,
  lobbyTimeoutMs: 2000,
  pickPassage: () => FIXED_PASSAGE,
});

const DEFAULT_WAIT_MS = 2000;

// A canonical code that tests never create unless they inject randomness.
const UNUSED_CODE = 'K7QM2X';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `check` until it returns true, or fails after `timeoutMs`. */
async function eventually(check, message, timeoutMs = 1000) {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${message}`);
    await sleep(5);
  }
}

/**
 * Wraps a socket.io-client socket and records every incoming event in order,
 * with the local receive time. `waitFor` consumes events FIFO per name.
 */
function recordEvents(socket) {
  const events = [];
  const waiters = new Set();

  socket.onAny((name, payload) => {
    const entry = { name, payload, at: performance.now(), taken: false, index: events.length };
    events.push(entry);
    for (const waiter of [...waiters]) {
      if (waiter.tryTake(entry)) break;
    }
  });

  function waitFor(name, predicate = () => true, timeoutMs = DEFAULT_WAIT_MS) {
    const existing = events.find((e) => !e.taken && e.name === name && predicate(e.payload));
    if (existing) {
      existing.taken = true;
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        tryTake(entry) {
          if (entry.taken || entry.name !== name || !predicate(entry.payload)) return false;
          entry.taken = true;
          clearTimeout(timer);
          waiters.delete(waiter);
          resolve(entry);
          return true;
        },
      };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        const seen = events.map((e) => e.name).join(', ');
        reject(new Error(`Timed out after ${timeoutMs} ms waiting for "${name}". Seen: [${seen}]`));
      }, timeoutMs);
      waiters.add(waiter);
    });
  }

  /** Events with this name that have not been consumed by waitFor. */
  function pending(name) {
    return events.filter((e) => !e.taken && e.name === name);
  }

  /** Marks every event recorded so far as consumed; later waits see only new events. */
  function drain() {
    for (const e of events) e.taken = true;
    return events.length;
  }

  /** The payload of the latest room:state seen (consumed or not), or null. */
  function lastState() {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i].name === 'room:state') return events[i].payload;
    }
    return null;
  }

  return { events, waitFor, pending, drain, lastState };
}

function connect(url, extra = {}) {
  const socket = ioClient(url, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    timeout: 2000,
    ...extra,
  });
  const recorder = recordEvents(socket);
  const client = Object.assign(recorder, { socket });

  client.connected = new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(client));
    socket.once('connect_error', (err) => reject(err));
  });
  // Avoid unhandled rejections for tests that expect a refusal and never await.
  client.connected.catch(() => {});

  client.emitAck = (event, ...args) => socket.timeout(DEFAULT_WAIT_MS).emitWithAck(event, ...args);
  client.create = () => client.emitAck('room:create', {});
  client.join = (code) => client.emitAck('room:join', { code });
  client.start = () => client.emitAck('room:start', {});
  client.extend = () => client.emitAck('room:extend', {});
  client.rematch = () => client.emitAck('race:rematch', {});
  client.progress = (seq, keys) => socket.emit('race:progress', { seq, keys });

  client.disconnected = new Promise((resolve) => socket.once('disconnect', (reason) => resolve(reason)));
  client.close = async () => {
    if (socket.connected) {
      const done = client.disconnected;
      socket.disconnect();
      await done;
    } else {
      socket.disconnect();
    }
  };
  return client;
}

function assertOkAck(ack, what) {
  if (!ack || ack.ok !== true) throw new Error(`${what} failed: ${JSON.stringify(ack)}`);
}

/**
 * Starts a server on a random free port with fast timers, and registers
 * cleanup of the server and every client it created on `t.after`.
 */
async function setup(t, options = {}) {
  const server = createServer({ ...FAST_OPTIONS, ...options });
  const port = await server.listen(0);
  const url = `http://127.0.0.1:${port}`;
  const clients = [];

  const ctx = {
    server,
    port,
    url,
    clients,
    /** Code of the room made by the latest `created()` (or first `joined()`). */
    code: null,
    /** The client that created that room. */
    host: null,
    /** Connects a client and waits for the connection. */
    async client(extra) {
      const c = connect(url, extra);
      clients.push(c);
      await c.connected;
      return c;
    },
    /** Connects without waiting; for tests that expect a refusal. */
    rawClient(extra) {
      const c = connect(url, extra);
      clients.push(c);
      return c;
    },
    /** Connects and creates a new room; it becomes ctx.code / ctx.host. */
    async created(extra) {
      const c = await ctx.client(extra);
      const ack = await c.create();
      assertOkAck(ack, 'create');
      c.playerId = ack.playerId;
      c.joinAck = ack;
      c.code = ack.room.code;
      ctx.code = ack.room.code;
      ctx.host = c;
      return c;
    },
    /** Connects and joins `code`; returns the client with `playerId` set. */
    async joinedTo(code, extra) {
      const c = await ctx.client(extra);
      const ack = await c.join(code);
      assertOkAck(ack, `join ${code}`);
      c.playerId = ack.playerId;
      c.joinAck = ack;
      c.code = code;
      return c;
    },
    /** The first call creates a room; later calls join ctx.code. */
    async joined(extra) {
      if (ctx.code === null) return ctx.created(extra);
      return ctx.joinedTo(ctx.code, extra);
    },
    /**
     * `count` clients in one room, the first being the host. No race started.
     * Resolves once every client has received the room:state listing all
     * `count` players (nothing is consumed).
     */
    async lobby(count = 2) {
      const list = [];
      for (let i = 0; i < count; i += 1) list.push(await ctx.joined());
      await eventually(
        () => list.every((c) => c.lastState() !== null && c.lastState().players.length === count),
        `every client sees ${count} players`,
        DEFAULT_WAIT_MS
      );
      return list;
    },
    /** The host's room:start; throws unless the ack is ok. */
    async start(host = ctx.host) {
      const ack = await host.start();
      assertOkAck(ack, 'start');
      return ack;
    },
    /** `count` clients in one room, all past race:start, with earlier events consumed. */
    async racing(count = 2) {
      const list = await ctx.lobby(count);
      await ctx.start(list[0]);
      await Promise.all(list.map((c) => c.waitFor('race:start')));
      for (const c of list) c.drain();
      return list;
    },
  };

  t.after(async () => {
    await Promise.all(clients.map((c) => c.close()));
    await server.close();
  });

  return ctx;
}

module.exports = {
  setup,
  connect,
  sleep,
  eventually,
  recordEvents,
  FAST_OPTIONS,
  FIXED_PASSAGE,
  DEFAULT_WAIT_MS,
  UNUSED_CODE,
};
