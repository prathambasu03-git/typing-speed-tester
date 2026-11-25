'use strict';

/* Shared helpers for the socket integration tests. Not a test file itself.

   Every server and client created through `setup(t, ...)` is closed in
   `t.after`, so each test owns and tears down its own state. Waits are
   event-based with a timeout; fixed sleeps are used only to prove that
   something did NOT happen. */

const { io: ioClient } = require('socket.io-client');
const { createServer } = require('../src/app');

const FIXED_PASSAGE = 'ab cd';

const FAST_OPTIONS = Object.freeze({
  countdownMs: 50,
  raceTimeLimitMs: 2000,
  broadcastIntervalMs: 20,
  pickPassage: () => FIXED_PASSAGE,
});

const DEFAULT_WAIT_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  return { events, waitFor, pending, drain };
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
  client.join = () => client.emitAck('room:join', {});
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
    /** Connects and joins; returns the client with `playerId` set. */
    async joined(extra) {
      const c = await ctx.client(extra);
      const ack = await c.join();
      if (!ack || ack.ok !== true) throw new Error(`join failed: ${JSON.stringify(ack)}`);
      c.playerId = ack.playerId;
      c.joinAck = ack;
      return c;
    },
    /** Two joined clients, both past race:start, with earlier events consumed. */
    async racing() {
      const a = await ctx.joined();
      const b = await ctx.joined();
      await Promise.all([a.waitFor('race:start'), b.waitFor('race:start')]);
      a.drain();
      b.drain();
      return [a, b];
    },
  };

  t.after(async () => {
    await Promise.all(clients.map((c) => c.close()));
    await server.close();
  });

  return ctx;
}

module.exports = { setup, connect, sleep, recordEvents, FAST_OPTIONS, FIXED_PASSAGE, DEFAULT_WAIT_MS };
