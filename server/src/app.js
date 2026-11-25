'use strict';

/* createServer(options): Express + HTTP + Socket.io, with no global state, so
   tests can start several servers with short timers and close them cleanly. */

const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');
const { DEFAULT_CONFIG } = require('./config');
const { MAX_HTTP_BUFFER_SIZE } = require('./constants');
const { isAllowedOrigin } = require('./origin');
const { registerGame } = require('./game');

function buildOriginConfig(options) {
  return {
    corsOrigins: options.corsOrigins ?? DEFAULT_CONFIG.corsOrigins,
    allowLocalhost: options.allowLocalhost ?? DEFAULT_CONFIG.allowLocalhost,
    allowNullOrigin: options.allowNullOrigin ?? DEFAULT_CONFIG.allowNullOrigin,
  };
}

/** Counts open engine connections per IP; entries are removed at zero. */
function createConnectionCounter() {
  const counts = new Map();
  return {
    count(ip) {
      return counts.get(ip) || 0;
    },
    increment(ip) {
      counts.set(ip, (counts.get(ip) || 0) + 1);
    },
    decrement(ip) {
      const next = (counts.get(ip) || 0) - 1;
      if (next > 0) counts.set(ip, next);
      else counts.delete(ip);
    },
    clear() {
      counts.clear();
    },
  };
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });
  return app;
}

/**
 * Options (all optional): corsOrigins, allowLocalhost, allowNullOrigin,
 * maxConnectionsPerIp, countdownMs, raceTimeLimitMs, broadcastIntervalMs,
 * rematchTimeoutMs, joinTimeoutMs, pickPassage, rateLimit { capacity, refillPerSec }, now, store.
 */
function createServer(options = {}) {
  const originConfig = buildOriginConfig(options);
  const maxConnectionsPerIp = options.maxConnectionsPerIp ?? DEFAULT_CONFIG.maxConnectionsPerIp;
  const connections = createConnectionCounter();

  const app = createApp();
  const httpServer = http.createServer(app);

  const io = new Server(httpServer, {
    cors: { origin: (origin, callback) => callback(null, isAllowedOrigin(origin, originConfig)) },
    // The CORS option does not apply to WebSocket upgrades, so the origin is
    // checked again here; this is the check that actually refuses sockets.
    allowRequest: (req, callback) => {
      if (!isAllowedOrigin(req.headers.origin, originConfig)) {
        callback('Origin not allowed', false);
        return;
      }
      const ip = req.socket.remoteAddress || 'unknown';
      if (connections.count(ip) >= maxConnectionsPerIp) {
        callback('Too many connections', false);
        return;
      }
      callback(null, true);
    },
    maxHttpBufferSize: MAX_HTTP_BUFFER_SIZE,
    serveClient: true,
  });

  // Count at the engine level so the number drops on every kind of close.
  io.engine.on('connection', (rawSocket) => {
    const ip = rawSocket.remoteAddress || 'unknown';
    connections.increment(ip);
    rawSocket.once('close', () => connections.decrement(ip));
  });

  const game = registerGame(io, {
    store: options.store,
    now: options.now,
    pickPassage: options.pickPassage,
    countdownMs: options.countdownMs,
    raceTimeLimitMs: options.raceTimeLimitMs,
    broadcastIntervalMs: options.broadcastIntervalMs,
    rematchTimeoutMs: options.rematchTimeoutMs,
    joinTimeoutMs: options.joinTimeoutMs,
    rateLimit: options.rateLimit,
  });

  /** Resolves to the real port, so `listen(0)` works in tests. */
  function listen(port = DEFAULT_CONFIG.port) {
    return new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      httpServer.once('error', onError);
      httpServer.listen(port, () => {
        httpServer.off('error', onError);
        resolve(httpServer.address().port);
      });
    });
  }

  /** Disconnects every socket, clears every timer and stops the HTTP server. */
  async function close() {
    game.clearAllTimers();
    if (typeof httpServer.closeAllConnections === 'function') httpServer.closeAllConnections();
    // io.close() disconnects sockets (running the disconnect handlers) and
    // also closes the HTTP server it is attached to.
    await new Promise((resolve) => {
      io.close(() => resolve());
    });
    game.clearAllTimers();
    connections.clear();
    if (httpServer.listening) {
      await new Promise((resolve) => httpServer.close(() => resolve()));
    }
  }

  return { app, httpServer, io, listen, close };
}

module.exports = { createServer };
