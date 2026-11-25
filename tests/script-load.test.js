'use strict';

/*
 * Regression test: solo mode must start even when multiplayer.js is missing.
 *
 * A past bug made script.js read MP_CONSTANTS (defined in multiplayer.js) at
 * load time, so a failed multiplayer.js load threw before init() and broke
 * solo mode. CLAUDE.md requires solo to work with no server; a missing
 * multiplayer.js must only switch multiplayer off.
 *
 * Runs stats.js, words.js and script.js as classic scripts in one vm context
 * with a minimal fake DOM (tests/helpers/load-script.js).
 * Run from the repo root with:  node --test tests/
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadApp, readMetaContent } = require('./helpers/load-script.js');

/** Asserts the observable effects of init() in solo mode. */
function assertInitRan({ ctx, elements, document }) {
  const chars = vm.runInContext('state.chars', ctx);
  const words = elements.get('words');
  assert.ok(chars.length > 0, 'state has characters to type');
  assert.equal(words.children.length, chars.length, 'one span per character in #words');
  assert.ok(words.children.every((span) => /\bchar\b/.test(span.className)), 'children are char spans');
  assert.equal(words.children.map((span) => span.textContent).join(''), chars.join(''));
  assert.equal((document.listeners.keydown || []).length, 1, 'keydown handler registered');
  assert.equal(document.activeElement, elements.get('hidden-input'), 'input focused');
  assert.equal(elements.get('load-error').hidden, true, 'no load error shown');
}

describe('script.js load without multiplayer.js', () => {
  it('runs stats.js, words.js and script.js without throwing', () => {
    const { error } = loadApp({ withMultiplayer: false });
    assert.equal(error, null, error && `script threw: ${error.name}: ${error.message}`);
  });

  it('does not touch any multiplayer.js name at load time', () => {
    const { error } = loadApp({ withMultiplayer: false });
    assert.ok(!(error instanceof Error && /MP_CONSTANTS|resolveServerUrl|isServerUsable|validate\w+|appendKey|errorMessage/.test(error.message)),
      error && `script threw: ${error.message}`);
    assert.equal(error, null);
  });

  it('runs init() so the solo test is ready to type', () => {
    const app = loadApp({ withMultiplayer: false });
    assert.equal(app.error, null, app.error && app.error.message);
    assertInitRan(app);
  });

  it('keeps the mode switch hidden and multiplayer switched off', () => {
    const app = loadApp({ withMultiplayer: false });
    assert.equal(app.error, null, app.error && app.error.message);
    assert.equal(app.elements.get('mode').hidden, true);
    assert.equal(vm.runInContext('MP_AVAILABLE', app.ctx), false);
    assert.equal(vm.runInContext('MP_ENABLED', app.ctx), false);
    assert.equal(vm.runInContext('CONFIG.serverUrl', app.ctx), null);
  });
});

describe('script.js load with multiplayer.js (positive control)', () => {
  it('runs all four scripts without throwing', () => {
    const { error } = loadApp({ withMultiplayer: true });
    assert.equal(error, null, error && `script threw: ${error.name}: ${error.message}`);
  });

  it('runs init() so the solo test is ready to type', () => {
    const app = loadApp({ withMultiplayer: true });
    assert.equal(app.error, null, app.error && app.error.message);
    assertInitRan(app);
  });

  it('shows the mode switch when the localhost server is usable from a localhost page', () => {
    const app = loadApp({ withMultiplayer: true, hostname: 'localhost' });
    assert.equal(app.error, null, app.error && app.error.message);
    assert.equal(vm.runInContext('MP_ENABLED', app.ctx), true);
    assert.equal(app.elements.get('mode').hidden, false);
  });
});

/* ---------- Milestone D: choosing the server URL (PLAN.md D4.2, D8) ---------- */

const PAGES_HOST = 'prathambasu03-git.github.io';
const RENDER_URL = 'https://x.onrender.com';

describe('the typing-server-url meta tag in index.html', () => {
  it('is the placeholder or an https URL that is not loopback', () => {
    const content = readMetaContent();
    assert.equal(typeof content, 'string', 'index.html has the meta tag');
    if (content === 'REPLACE_WITH_RENDER_URL') return;
    const url = new URL(content); // throws for anything that is not a URL
    assert.equal(url.protocol, 'https:', `meta URL must be https: (got ${content})`);
    assert.ok(!['localhost', '127.0.0.1'].includes(url.hostname), `meta URL must not be loopback (got ${content})`);
  });
});

describe('script.js server URL selection with multiplayer.js', () => {
  it('uses the local server on an http localhost page and shows the mode switch', () => {
    const app = loadApp({ withMultiplayer: true, protocol: 'http:', hostname: 'localhost' });
    assert.equal(app.error, null, app.error && app.error.message);
    assert.equal(vm.runInContext('CONFIG.serverUrl', app.ctx), 'http://localhost:3000');
    assert.equal(vm.runInContext('MP_ENABLED', app.ctx), true);
    assert.equal(app.elements.get('mode').hidden, false);
  });

  it('uses the local server on a localhost page whatever the meta says', () => {
    const app = loadApp({ withMultiplayer: true, protocol: 'http:', hostname: 'localhost', metaContent: RENDER_URL });
    assert.equal(app.error, null, app.error && app.error.message);
    assert.equal(vm.runInContext('CONFIG.serverUrl', app.ctx), 'http://localhost:3000');
  });

  it('switches multiplayer off on the https Pages site while the meta is the placeholder', () => {
    const app = loadApp({
      withMultiplayer: true, protocol: 'https:', hostname: PAGES_HOST, metaContent: 'REPLACE_WITH_RENDER_URL',
    });
    assert.equal(app.error, null, app.error && app.error.message);
    assert.equal(vm.runInContext('MP_ENABLED', app.ctx), false);
    assert.equal(vm.runInContext('CONFIG.serverUrl', app.ctx), null);
    assert.equal(app.elements.get('mode').hidden, true);
  });

  it('still runs solo init() on the https Pages site while the meta is the placeholder', () => {
    const app = loadApp({
      withMultiplayer: true, protocol: 'https:', hostname: PAGES_HOST, metaContent: 'REPLACE_WITH_RENDER_URL',
    });
    assert.equal(app.error, null, app.error && app.error.message);
    assertInitRan(app);
  });

  it('switches multiplayer off on a file: page even with a real server URL in the meta', () => {
    const app = loadApp({ withMultiplayer: true, protocol: 'file:', hostname: '', metaContent: RENDER_URL });
    assert.equal(app.error, null, app.error && app.error.message);
    assert.equal(vm.runInContext('MP_ENABLED', app.ctx), false);
    assert.equal(vm.runInContext('CONFIG.serverUrl', app.ctx), null);
    assert.equal(app.elements.get('mode').hidden, true);
  });

  it('still runs solo init() on a file: page', () => {
    const app = loadApp({ withMultiplayer: true, protocol: 'file:', hostname: '', metaContent: RENDER_URL });
    assert.equal(app.error, null, app.error && app.error.message);
    assertInitRan(app);
  });

  it('uses the meta URL on an https page when it is a real https server', () => {
    const app = loadApp({ withMultiplayer: true, protocol: 'https:', hostname: PAGES_HOST, metaContent: RENDER_URL });
    assert.equal(app.error, null, app.error && app.error.message);
    assert.equal(vm.runInContext('CONFIG.serverUrl', app.ctx), RENDER_URL);
    assert.equal(vm.runInContext('MP_ENABLED', app.ctx), true);
    assert.equal(app.elements.get('mode').hidden, false);
  });

  it('switches multiplayer off on an https page when the meta is an http server (mixed content)', () => {
    const app = loadApp({
      withMultiplayer: true, protocol: 'https:', hostname: PAGES_HOST, metaContent: 'http://x.onrender.com',
    });
    assert.equal(app.error, null, app.error && app.error.message);
    assert.equal(vm.runInContext('MP_ENABLED', app.ctx), false);
  });

  it('switches multiplayer off on the Pages site when there is no meta tag at all', () => {
    const app = loadApp({ withMultiplayer: true, protocol: 'https:', hostname: PAGES_HOST, metaContent: null });
    assert.equal(app.error, null, app.error && app.error.message);
    assert.equal(vm.runInContext('MP_ENABLED', app.ctx), false);
    assertInitRan(app);
  });
});

/* ---------- Milestone D: the connecting flow with fake timers (PLAN.md D4.1, D7) ---------- */

/**
 * Loads the app with multiplayer on and records every write to #announcer.
 * No socket.io script ever answers: the <script> element appended to <head>
 * never fires load or error, as with a host that holds the request.
 */
function loadConnectingApp({ hostname = PAGES_HOST, protocol = 'https:', metaContent = RENDER_URL } = {}) {
  const app = loadApp({ withMultiplayer: true, protocol, hostname, metaContent });
  assert.equal(app.error, null, app.error && app.error.message);
  const announcer = app.elements.get('announcer');
  const spoken = [];
  let text = announcer.textContent;
  Object.defineProperty(announcer, 'textContent', {
    get: () => text,
    set: (value) => { text = String(value); spoken.push(text); },
  });
  const press = (mode) => {
    const button = app.modeButtons.find((b) => b.dataset.mode === mode);
    for (const fn of app.elements.get('mode').listeners.click || []) {
      fn({ target: { closest: () => button }, detail: 0 });
    }
  };
  const get = (expr) => vm.runInContext(expr, app.ctx);
  const scripts = () => app.document.head.children.filter((el) => el.tagName === 'SCRIPT');
  return { ...app, spoken, press, get, scripts };
}

describe('pressing Multiplayer with a remote server that does not answer', () => {
  it('starts in the connecting phase with the plain connecting status', () => {
    const app = loadConnectingApp();
    app.press('multi');
    assert.equal(app.get('state.phase'), 'connecting');
    assert.equal(app.elements.get('race-status').textContent, 'Connecting to the multiplayer server…');
  });

  it('adds is-connecting to #race-panel while connecting', () => {
    const app = loadConnectingApp();
    app.press('multi');
    assert.equal(app.elements.get('race-panel').classList.contains('is-connecting'), true);
  });

  it('hides #race-tracks while the room has no players', () => {
    const app = loadConnectingApp();
    app.press('multi');
    assert.equal(app.elements.get('race-tracks').hidden, true);
  });

  it('requests the Socket.io client from the game server itself', () => {
    const app = loadConnectingApp();
    app.press('multi');
    assert.equal(app.scripts().length, 1);
    assert.equal(app.scripts()[0].src, `${RENDER_URL}/socket.io/socket.io.js`);
  });

  it('does not show the waking message before wakeNoticeDelayMs has passed', () => {
    const app = loadConnectingApp();
    app.press('multi');
    app.clock.advance(app.get('MP_CONSTANTS.wakeNoticeDelayMs') - 1);
    assert.equal(app.elements.get('race-status').textContent, 'Connecting to the multiplayer server…');
    assert.ok(!app.spoken.includes(app.get('WAKE_ANNOUNCEMENT')));
  });

  it('shows WAKE_STATUS once wakeNoticeDelayMs has passed', () => {
    const app = loadConnectingApp();
    app.press('multi');
    app.clock.advance(app.get('MP_CONSTANTS.wakeNoticeDelayMs'));
    assert.equal(app.elements.get('race-status').textContent, app.get('WAKE_STATUS'));
    assert.match(app.get('WAKE_STATUS'), /waking up the game server/i);
  });

  it('announces the waking message exactly once, even over a long wait', () => {
    const app = loadConnectingApp();
    app.press('multi');
    app.clock.advance(60000);
    const wake = app.get('WAKE_ANNOUNCEMENT');
    assert.equal(app.spoken.filter((t) => t === wake).length, 1);
    assert.equal(app.get('state.phase'), 'connecting', 'still within the 90 s budget');
  });

  it('keeps is-connecting while the waking message shows', () => {
    const app = loadConnectingApp();
    app.press('multi');
    app.clock.advance(app.get('MP_CONSTANTS.wakeNoticeDelayMs'));
    assert.equal(app.elements.get('race-panel').classList.contains('is-connecting'), true);
  });

  it('does not fall back to solo before the 90 s budget runs out', () => {
    const app = loadConnectingApp();
    app.press('multi');
    app.clock.advance(app.get('MP_CONSTANTS.wakeTimeoutMs') - 5000);
    assert.equal(app.get('state.mode'), 'multi');
    assert.equal(app.elements.get('mp-error').hidden, true);
  });

  it('falls back to solo with the UNREACHABLE alert once the 90 s budget runs out', async () => {
    const app = loadConnectingApp();
    app.press('multi');
    app.clock.advance(app.get('MP_CONSTANTS.wakeTimeoutMs') + 1000);
    await new Promise((resolve) => setImmediate(resolve)); // the load promise rejects in a microtask
    assert.equal(app.get('state.mode'), 'solo');
    const mpError = app.elements.get('mp-error');
    assert.equal(mpError.hidden, false);
    assert.equal(mpError.textContent, app.get("errorMessage('UNREACHABLE')"));
  });
});

describe('pressing Solo while the remote server is waking', () => {
  function wakeThenSolo() {
    const app = loadConnectingApp();
    app.press('multi');
    app.clock.advance(app.get('MP_CONSTANTS.wakeNoticeDelayMs') + 500);
    app.press('solo');
    return app;
  }
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('removes is-connecting from #race-panel', () => {
    const app = wakeThenSolo();
    assert.equal(app.elements.get('race-panel').classList.contains('is-connecting'), false);
  });

  it('returns to solo mode', () => {
    const app = wakeThenSolo();
    assert.equal(app.get('state.mode'), 'solo');
  });

  it('leaves no later waking announcement or alert', async () => {
    const app = wakeThenSolo();
    const before = app.spoken.length;
    await flush();
    app.clock.advance(200000);
    await flush();
    const later = app.spoken.slice(before);
    assert.ok(!later.includes(app.get('WAKE_ANNOUNCEMENT')), `late announcements: ${JSON.stringify(later)}`);
    assert.ok(!later.some((t) => /could not reach/i.test(t)));
    assert.equal(app.elements.get('mp-error').hidden, true);
    assert.equal(app.elements.get('mp-error').textContent, '');
    assert.equal(app.get('state.mode'), 'solo');
  });

  it('removes the pending script and starts no new load', async () => {
    const app = wakeThenSolo();
    assert.ok(app.scripts().every((el) => el.removed), 'pending script removed');
    const count = app.scripts().length;
    app.clock.advance(200000);
    await flush();
    assert.equal(app.scripts().length, count);
  });

  it('announces only the solo-ready message after leaving', async () => {
    const app = wakeThenSolo();
    const before = app.spoken.length;
    await flush();
    app.clock.advance(1000);
    const later = app.spoken.slice(before).filter(Boolean);
    assert.equal(later.length, 1, JSON.stringify(later));
    assert.match(later[0], /^Solo mode\./);
  });
});

describe('pressing Multiplayer with the local server', () => {
  const local = { protocol: 'http:', hostname: 'localhost', metaContent: 'REPLACE_WITH_RENDER_URL' };

  it('never shows the waking message', () => {
    const app = loadConnectingApp(local);
    app.press('multi');
    app.clock.advance(app.get('MP_CONSTANTS.wakeNoticeDelayMs') + 1000);
    assert.ok(!app.spoken.includes(app.get('WAKE_ANNOUNCEMENT')));
    assert.notEqual(app.elements.get('race-status').textContent, app.get('WAKE_STATUS'));
  });

  it('falls back to solo with the UNREACHABLE alert within the 5 s local budget', async () => {
    const app = loadConnectingApp(local);
    app.press('multi');
    app.clock.advance(app.get('MP_CONSTANTS.localConnectTimeoutMs'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(app.get('state.mode'), 'solo');
    assert.equal(app.elements.get('mp-error').textContent, app.get("errorMessage('UNREACHABLE')"));
  });
});
