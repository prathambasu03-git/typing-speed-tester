'use strict';

/*
 * Multiplayer test harness on top of load-script.js: a fake Socket.io `io`,
 * an #announcer recorder, and small helpers to press buttons, submit the
 * join form and send keydown events through the listeners script.js
 * registered. Only Node built-ins are used.
 */

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadApp } = require('./load-script.js');

const PAGES_HOST = 'prathambasu03-git.github.io';
const PAGES_PATH = '/typing-speed-tester/';
const RENDER_URL = 'https://x.onrender.com';
const PASSAGE = 'the quick brown fox';

/** Lets pending promise callbacks (script load, clipboard) run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A fake socket. `timeout(ms).emit(event, payload, cb)` records the ack
 * callback so a test can answer it; `fire(event, data)` plays a server event.
 */
function createFakeSocket(url, options) {
  const handlers = {};
  const socket = {
    url,
    options,
    emitted: [],
    disconnected: false,
    on(event, fn) { (handlers[event] ||= []).push(fn); },
    off() { for (const key of Object.keys(handlers)) delete handlers[key]; },
    disconnect() { socket.disconnected = true; },
    emit(event, payload) { socket.emitted.push({ event, payload, cb: null, timeoutMs: null }); },
    timeout(timeoutMs) {
      return {
        emit(event, payload, cb) { socket.emitted.push({ event, payload, cb, timeoutMs }); },
      };
    },
    fire(event, data) { for (const fn of [...(handlers[event] || [])]) fn(data); },
    /** The last emit of `event`, or undefined. */
    last(event) { return [...socket.emitted].reverse().find((entry) => entry.event === event); },
    count(event) { return socket.emitted.filter((entry) => entry.event === event).length; },
  };
  return socket;
}

/**
 * Loads the app with multiplayer on (the Pages site and a Render server by
 * default). With `withIo` (default true), window.io is a fake factory before
 * any press, so the Socket.io script "is already loaded" and no <script> is
 * appended; every socket it makes is in `sockets`.
 */
function setupMp(options = {}) {
  const { withIo = true, ...loadOptions } = options;
  const app = loadApp({
    withMultiplayer: true,
    protocol: 'https:',
    hostname: PAGES_HOST,
    pathname: PAGES_PATH,
    metaContent: RENDER_URL,
    ...loadOptions,
  });
  assert.equal(app.error, null, app.error && app.error.stack);

  const sockets = [];
  const ioCalls = [];
  if (withIo) {
    app.window.io = (url, opts) => {
      ioCalls.push({ url, opts });
      const socket = createFakeSocket(url, opts);
      sockets.push(socket);
      return socket;
    };
  }

  // Every write to #announcer, in order ('' clears included).
  const announcer = app.elements.get('announcer');
  const spoken = [];
  let text = announcer.textContent;
  Object.defineProperty(announcer, 'textContent', {
    get: () => text,
    set: (value) => { text = String(value); spoken.push(text); },
  });

  const el = (id) => {
    const element = app.elements.get(id);
    assert.ok(element, `index.html has #${id}`);
    return element;
  };
  const get = (expr) => vm.runInContext(expr, app.ctx);
  const fireOn = (target, type, event) => {
    for (const fn of [...(target.listeners[type] || [])]) fn(event);
  };
  const click = (id, detail = 0) => fireOn(el(id), 'click', { target: el(id), detail });
  const press = (mode, detail = 0) => {
    const button = app.modeButtons.find((b) => b.dataset.mode === mode);
    fireOn(el('mode'), 'click', { target: button, detail });
  };
  /** Submits the join form with `value` typed in the code input. */
  const submitJoin = (value) => {
    el('room-code-input').value = value;
    const event = { defaultPrevented: false, preventDefault() { event.defaultPrevented = true; } };
    fireOn(el('join-form'), 'submit', event);
    return event;
  };
  /** Sends a keydown through the document listener; returns the event. */
  const keydown = (key, target) => {
    const event = {
      key,
      target,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      isComposing: false,
      defaultPrevented: false,
      getModifierState: () => false,
      preventDefault() { event.defaultPrevented = true; },
    };
    fireOn(app.document, 'keydown', event);
    return event;
  };
  const scripts = () => app.document.head.children.filter((node) => node.tagName === 'SCRIPT');
  const socket = () => sockets[sockets.length - 1];
  const announceDelay = get('CONFIG.resultAnnounceDelayMs');
  /** Runs the announceSoon delay (and any frame) so pending speech is written. */
  const settle = () => app.clock.advance(announceDelay + 20);
  /** Spoken non-empty texts after index `from`. */
  const spokenSince = (from) => spoken.slice(from).filter(Boolean);

  return {
    ...app, sockets, ioCalls, spoken, el, get, click, press, submitJoin, keydown, scripts, socket,
    settle, spokenSince, fireOn,
  };
}

/* ---------- Payload builders (docs/PROTOCOL.md, M2) ---------- */

function P(id, slot, overrides = {}) {
  return { id, slot, connected: true, ready: true, inRace: false, finished: false, ...overrides };
}

function room(phase, players, hostId, overrides = {}) {
  return {
    code: 'K7QM2X',
    phase,
    maxPlayers: 4,
    minPlayers: 2,
    hostId,
    expiresInMs: phase === 'waiting' ? 600000 : null,
    players,
    ...overrides,
  };
}

function result(id, slot, place, overrides = {}) {
  return {
    id, slot, place, status: 'finished', wpm: 60, rawWpm: 62, accuracy: 97,
    correctChars: 19, incorrectChars: 1, timeMs: 30000, ...overrides,
  };
}

/** Multiplayer, then Create; connects and answers the create ack. */
async function createRoom(app, ackRoom = room('waiting', [P('a', 1)], 'a'), playerId = 'a') {
  app.press('multi');
  app.click('create-room-btn');
  await flush();
  const socket = app.socket();
  socket.fire('connect');
  socket.last('room:create').cb(null, { ok: true, playerId, room: ackRoom });
  return socket;
}

/** Multiplayer, then Join with `code`; connects and answers the join ack. */
async function joinRoom(app, ackRoom, playerId, code = 'K7QM2X') {
  app.press('multi');
  app.submitJoin(code);
  await flush();
  const socket = app.socket();
  socket.fire('connect');
  socket.last('room:join').cb(null, { ok: true, playerId, room: ackRoom });
  return socket;
}

/**
 * Plays one whole race for `ids` (all in it): countdown, start, end. Leaves
 * the client on its results with the room `finished` (nobody ready).
 */
function playRace(app, socket, ids, hostId) {
  const racing = (phase) => room(phase, ids.map((id, i) => P(id, i + 1, { inRace: true, ready: false })), hostId);
  socket.fire('room:state', racing('countdown'));
  socket.fire('race:countdown', { passage: PASSAGE, startsInMs: 3000, raceTimeLimitMs: 120000 });
  socket.fire('room:state', racing('racing'));
  socket.fire('race:start', { raceTimeLimitMs: 120000 });
  socket.fire('race:end', {
    reason: 'time_limit',
    results: ids.map((id, i) => result(id, i + 1, i + 1, { status: 'unfinished' })),
  });
  socket.fire('room:state', room('finished', ids.map((id, i) => P(id, i + 1, { inRace: true, ready: false })), hostId));
}

module.exports = {
  PAGES_HOST, PAGES_PATH, RENDER_URL, PASSAGE,
  flush, createFakeSocket, setupMp, P, room, result, createRoom, joinRoom, playRace,
};
