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

/* ---------- Milestone D, moved to Create/Join in M2: the connecting flow with fake timers ---------- */

/**
 * Loads the app with multiplayer on and records every write to #announcer.
 * No socket.io script ever answers: the <script> element appended to <head>
 * never fires load or error, as with a host that holds the request. Since
 * M2, Multiplayer opens the menu and the connect starts at Create or Join.
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
      fn({ target: button, detail: 0 });
    }
  };
  const click = (id) => {
    for (const fn of app.elements.get(id).listeners.click || []) fn({ target: app.elements.get(id), detail: 0 });
  };
  const submitJoin = (value) => {
    app.elements.get('room-code-input').value = value;
    for (const fn of app.elements.get('join-form').listeners.submit || []) fn({ preventDefault() {} });
  };
  /** Multiplayer, then Create a room: the connect starts here. */
  const create = () => { press('multi'); click('create-room-btn'); };
  const get = (expr) => vm.runInContext(expr, app.ctx);
  const scripts = () => app.document.head.children.filter((el) => el.tagName === 'SCRIPT');
  return { ...app, spoken, press, click, submitJoin, create, get, scripts };
}

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

describe('pressing Multiplayer, then Create, with a remote server that does not answer', () => {
  it('stays in the menu, not connecting, after Multiplayer alone', () => {
    const app = loadConnectingApp();
    app.press('multi');
    assert.equal(app.get('state.phase'), 'menu');
    assert.equal(app.elements.get('race-panel').classList.contains('is-connecting'), false);
  });

  it('starts in the connecting phase with the plain connecting status after Create', () => {
    const app = loadConnectingApp();
    app.create();
    assert.equal(app.get('state.phase'), 'connecting');
    assert.equal(app.elements.get('race-status').textContent, 'Connecting to the multiplayer server…');
  });

  it('starts connecting after a valid Join too', () => {
    const app = loadConnectingApp();
    app.press('multi');
    app.submitJoin('k7q-m2x');
    assert.equal(app.get('state.phase'), 'connecting');
    assert.deepEqual({ ...app.get('state.mp.intent') }, { type: 'join', code: 'K7QM2X' });
  });

  it('moves focus to #race-title when connecting starts', () => {
    const app = loadConnectingApp();
    app.create();
    assert.equal(app.document.activeElement, app.elements.get('race-title'));
  });

  it('adds is-connecting to #race-panel while connecting', () => {
    const app = loadConnectingApp();
    app.create();
    assert.equal(app.elements.get('race-panel').classList.contains('is-connecting'), true);
  });

  it('hides #race-tracks while the room has no players', () => {
    const app = loadConnectingApp();
    app.create();
    assert.equal(app.elements.get('race-tracks').hidden, true);
  });

  it('requests the Socket.io client from the game server once: the prefetch is reused by Create', () => {
    const app = loadConnectingApp();
    app.press('multi');
    assert.equal(app.scripts().length, 1, 'the prefetch starts at Multiplayer');
    app.click('create-room-btn');
    assert.equal(app.scripts().length, 1, 'Create reuses the pending load');
    assert.equal(app.scripts()[0].src, `${RENDER_URL}/socket.io/socket.io.js`);
  });

  it('does not show the waking message before wakeNoticeDelayMs has passed', () => {
    const app = loadConnectingApp();
    app.create();
    app.clock.advance(app.get('MP_CONSTANTS.wakeNoticeDelayMs') - 1);
    assert.equal(app.elements.get('race-status').textContent, 'Connecting to the multiplayer server…');
    assert.ok(!app.spoken.includes(app.get('WAKE_ANNOUNCEMENT')));
  });

  it('never shows the waking message while the user stays in the menu', () => {
    const app = loadConnectingApp();
    app.press('multi');
    app.clock.advance(30000);
    assert.ok(!app.spoken.includes(app.get('WAKE_ANNOUNCEMENT')));
    assert.equal(app.get('state.phase'), 'menu');
  });

  it('shows WAKE_STATUS once wakeNoticeDelayMs has passed', () => {
    const app = loadConnectingApp();
    app.create();
    app.clock.advance(app.get('MP_CONSTANTS.wakeNoticeDelayMs'));
    assert.equal(app.elements.get('race-status').textContent, app.get('WAKE_STATUS'));
    assert.match(app.get('WAKE_STATUS'), /waking up the game server/i);
  });

  it('times the waking message from the Create press, not from Multiplayer', () => {
    const app = loadConnectingApp();
    app.press('multi');
    app.clock.advance(10000);
    app.click('create-room-btn');
    app.clock.advance(app.get('MP_CONSTANTS.wakeNoticeDelayMs') - 1);
    assert.notEqual(app.elements.get('race-status').textContent, app.get('WAKE_STATUS'));
    app.clock.advance(1);
    assert.equal(app.elements.get('race-status').textContent, app.get('WAKE_STATUS'));
  });

  it('announces the waking message exactly once, even over a long wait', () => {
    const app = loadConnectingApp();
    app.create();
    app.clock.advance(60000);
    const wake = app.get('WAKE_ANNOUNCEMENT');
    assert.equal(app.spoken.filter((t) => t === wake).length, 1);
    assert.equal(app.get('state.phase'), 'connecting', 'still within the 90 s budget');
  });

  it('keeps is-connecting while the waking message shows', () => {
    const app = loadConnectingApp();
    app.create();
    app.clock.advance(app.get('MP_CONSTANTS.wakeNoticeDelayMs'));
    assert.equal(app.elements.get('race-panel').classList.contains('is-connecting'), true);
  });

  it('does not fall back to solo before the 90 s budget runs out', async () => {
    const app = loadConnectingApp();
    app.create();
    app.clock.advance(app.get('MP_CONSTANTS.wakeTimeoutMs') - 5000);
    await flushPromises();
    assert.equal(app.get('state.mode'), 'multi');
    assert.equal(app.elements.get('mp-error').hidden, true);
  });

  it('falls back to solo with the UNREACHABLE alert once the 90 s budget runs out', async () => {
    const app = loadConnectingApp();
    app.create();
    app.clock.advance(app.get('MP_CONSTANTS.wakeTimeoutMs') + 1000);
    await flushPromises(); // the load promise rejects in a microtask
    assert.equal(app.get('state.mode'), 'solo');
    const mpError = app.elements.get('mp-error');
    assert.equal(mpError.hidden, false);
    assert.equal(mpError.textContent, app.get("errorMessage('UNREACHABLE')"));
  });

  it('gives Create its full 90 s budget even when the prefetch started 10 s earlier', async () => {
    const app = loadConnectingApp();
    app.press('multi');
    app.clock.advance(10000);
    app.click('create-room-btn');
    // The prefetch gives up 90 s after Multiplayer; Create's budget runs 10 s longer.
    for (let t = 0; t < 89000; t += 1000) {
      app.clock.advance(1000);
      await flushPromises();
    }
    assert.equal(app.get('state.mode'), 'multi', '89 s after Create: still connecting');
    assert.equal(app.get('state.phase'), 'connecting');
    for (let t = 0; t < 3000; t += 1000) {
      app.clock.advance(1000);
      await flushPromises();
    }
    assert.equal(app.get('state.mode'), 'solo', 'after 90 s from Create: solo');
    assert.equal(app.elements.get('mp-error').textContent, app.get("errorMessage('UNREACHABLE')"));
  });
});

describe('pressing Solo while the remote server is waking after Create', () => {
  function wakeThenSolo() {
    const app = loadConnectingApp();
    app.create();
    app.clock.advance(app.get('MP_CONSTANTS.wakeNoticeDelayMs') + 500);
    app.press('solo');
    return app;
  }

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
    await flushPromises();
    app.clock.advance(200000);
    await flushPromises();
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
    await flushPromises();
    assert.equal(app.scripts().length, count);
  });

  it('announces only the solo-ready message after leaving', async () => {
    const app = wakeThenSolo();
    const before = app.spoken.length;
    await flushPromises();
    app.clock.advance(1000);
    const later = app.spoken.slice(before).filter(Boolean);
    assert.equal(later.length, 1, JSON.stringify(later));
    assert.match(later[0], /^Solo mode\./);
  });
});

describe('pressing Solo in the menu, before Create or Join', () => {
  it('cancels the prefetch: the script is removed and no retry follows', async () => {
    const app = loadConnectingApp();
    app.press('multi');
    app.press('solo');
    assert.equal(app.get('state.mode'), 'solo');
    assert.ok(app.scripts().every((el) => el.removed));
    const count = app.scripts().length;
    app.clock.advance(200000);
    await flushPromises();
    assert.equal(app.scripts().length, count);
    assert.equal(app.elements.get('mp-error').hidden, true);
  });
});

describe('pressing Multiplayer, then Create, with the local server', () => {
  const local = { protocol: 'http:', hostname: 'localhost', metaContent: 'REPLACE_WITH_RENDER_URL' };

  it('never shows the waking message', () => {
    const app = loadConnectingApp(local);
    app.create();
    app.clock.advance(app.get('MP_CONSTANTS.wakeNoticeDelayMs') + 1000);
    assert.ok(!app.spoken.includes(app.get('WAKE_ANNOUNCEMENT')));
    assert.notEqual(app.elements.get('race-status').textContent, app.get('WAKE_STATUS'));
  });

  it('does not fall back to solo before the 5 s local budget runs out', async () => {
    const app = loadConnectingApp(local);
    app.create();
    app.clock.advance(app.get('MP_CONSTANTS.localConnectTimeoutMs') - 1);
    await flushPromises();
    assert.equal(app.get('state.mode'), 'multi');
  });

  it('falls back to solo with the UNREACHABLE alert within the 5 s local budget', async () => {
    const app = loadConnectingApp(local);
    app.create();
    app.clock.advance(app.get('MP_CONSTANTS.localConnectTimeoutMs'));
    await flushPromises();
    assert.equal(app.get('state.mode'), 'solo');
    assert.equal(app.elements.get('mp-error').textContent, app.get("errorMessage('UNREACHABLE')"));
  });
});

/* ---------- Milestone M2: invite links, the menu, the keydown guard, markup (PLAN.md 9, Q3) ---------- */

const { setupMp, flush, P, room, createRoom, PAGES_PATH } = require('./helpers/mp-harness.js');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const MP = require('../multiplayer.js');

describe('opening the page with a valid #room= invite link', () => {
  const open = () => setupMp({ hash: '#room=k7qm2x' });

  it('shows the #invite banner', () => assert.equal(open().el('invite').hidden, false));
  it('shows the canonical code in #invite-code', () => assert.equal(open().el('invite-code').textContent, 'K7QM2X'));
  it('spells the code in #invite-code-spelled', () => {
    assert.equal(open().el('invite-code-spelled').textContent, 'K 7 Q M 2 X');
  });
  it('focuses #invite-join-btn instead of the typing input', () => {
    const app = open();
    assert.equal(app.document.activeElement, app.el('invite-join-btn'));
  });
  it('appends no <script> to document.head before a user action', () => {
    const app = setupMp({ hash: '#room=k7qm2x', withIo: false });
    assert.equal(app.scripts().length, 0);
  });
  it('opens no socket before a user action, even after a long wait', async () => {
    const app = open();
    app.clock.advance(120000);
    await flush();
    assert.equal(app.ioCalls.length, 0);
  });
  it('stays in solo, with the solo test ready', () => {
    const app = open();
    assert.equal(app.get('state.mode'), 'solo');
    assert.ok(app.get('state.chars.length') > 0);
  });
  it('still lets solo typing start the test from the banner', () => {
    const app = open();
    app.keydown('a', app.el('invite-join-btn'));
    assert.equal(app.get('state.phase'), 'running');
  });
});

describe('opening the page with an invalid or unusable invite link', () => {
  it('hides #invite for #room=bad and focuses #hidden-input', () => {
    const app = setupMp({ hash: '#room=bad' });
    assert.equal(app.el('invite').hidden, true);
    assert.equal(app.document.activeElement, app.el('hidden-input'));
  });
  it('hides #invite for a code with a misreadable character (#room=K7QM0X)', () => {
    assert.equal(setupMp({ hash: '#room=K7QM0X' }).el('invite').hidden, true);
  });
  it('hides #invite on a file: page even with a valid hash', () => {
    const app = loadApp({ withMultiplayer: true, protocol: 'file:', hostname: '', metaContent: RENDER_URL, hash: '#room=K7QM2X' });
    assert.equal(app.error, null, app.error && app.error.message);
    assert.equal(app.elements.get('invite').hidden, true);
    assert.equal(app.document.activeElement, app.elements.get('hidden-input'));
  });
  it('hides #invite without multiplayer.js, and solo still runs', () => {
    const app = loadApp({ withMultiplayer: false, hash: '#room=K7QM2X' });
    assert.equal(app.error, null, app.error && app.error.message);
    assert.equal(app.elements.get('invite').hidden, true);
    assertInitRan(app);
  });
});

describe('the invite banner buttons', () => {
  it('Join room on the banner goes straight to connecting with the invite code', async () => {
    const app = setupMp({ hash: '#room=k7qm2x' });
    app.click('invite-join-btn');
    assert.equal(app.get('state.mode'), 'multi');
    assert.equal(app.get('state.phase'), 'connecting');
    assert.equal(app.document.activeElement, app.el('race-title'));
    assert.equal(app.el('invite').hidden, true);
    await flush();
    app.socket().fire('connect');
    assert.deepEqual({ ...app.socket().last('room:join').payload }, { code: 'K7QM2X' });
  });
  it('Not now hides the banner, focuses the typing input and drops the hash', () => {
    const app = setupMp({ hash: '#room=k7qm2x' });
    app.click('invite-dismiss-btn');
    assert.equal(app.el('invite').hidden, true);
    assert.equal(app.document.activeElement, app.el('hidden-input'));
    assert.equal(app.history.calls.at(-1), PAGES_PATH);
    assert.equal(app.window.location.hash, '');
  });
  it('Not now opens no connection', async () => {
    const app = setupMp({ hash: '#room=k7qm2x' });
    app.click('invite-dismiss-btn');
    await flush();
    assert.equal(app.ioCalls.length, 0);
  });
});

describe('a hashchange to an invite link', () => {
  const change = (app, hash) => {
    app.window.location.hash = hash;
    app.fireOn(app.window, 'hashchange', {});
  };
  it('shows the banner in solo, with no request', async () => {
    const app = setupMp({ withIo: false });
    assert.equal(app.el('invite').hidden, true);
    change(app, '#room=AAAAAA');
    assert.equal(app.el('invite').hidden, false);
    assert.equal(app.el('invite-code').textContent, 'AAAAAA');
    await flush();
    assert.equal(app.scripts().length, 0);
  });
  it('fills the code input in the menu', () => {
    const app = setupMp();
    app.press('multi');
    change(app, '#room=AAAAAA');
    assert.equal(app.el('room-code-input').value, 'AAAAAA');
  });
  it('is ignored in a room', async () => {
    const app = setupMp();
    await createRoom(app);
    change(app, '#room=AAAAAA');
    assert.equal(app.get('state.phase'), 'waiting');
    assert.equal(app.el('invite').hidden, true);
    assert.equal(app.el('room-code').textContent, 'K7QM2X');
  });
});

describe('pressing Multiplayer opens the menu', () => {
  it('shows #mp-menu and #race-panel', () => {
    const app = setupMp();
    app.press('multi');
    assert.equal(app.get('state.phase'), 'menu');
    assert.equal(app.el('mp-menu').hidden, false);
    assert.equal(app.el('race-panel').hidden, false);
  });
  it("titles the panel 'multiplayer' and leaves #race-status empty", () => {
    const app = setupMp();
    app.press('multi');
    assert.equal(app.el('race-title').textContent, 'multiplayer');
    assert.equal(app.el('race-status').textContent, '');
  });
  it('hides #room-info and #room-actions', () => {
    const app = setupMp();
    app.press('multi');
    assert.equal(app.el('room-info').hidden, true);
    assert.equal(app.el('room-actions').hidden, true);
  });
  it('announces the menu once', () => {
    const app = setupMp();
    const before = app.spoken.length;
    app.press('multi');
    app.settle();
    assert.deepEqual(app.spokenSince(before), ['Multiplayer. Create a room, or join one with a code.']);
  });
  it('does not move focus', () => {
    const app = setupMp();
    const focused = app.document.activeElement;
    app.press('multi');
    assert.equal(app.document.activeElement, focused);
  });
  it('leaves the code input empty without an invite', () => {
    const app = setupMp();
    app.press('multi');
    assert.equal(app.el('room-code-input').value, '');
  });
  it('puts the invite code in the code input when there is one', () => {
    const app = setupMp({ hash: '#room=k7qm2x' });
    app.press('multi');
    assert.equal(app.el('room-code-input').value, 'K7QM2X');
  });
  it('appends exactly one script, the Socket.io prefetch from the game server', () => {
    const app = setupMp({ withIo: false });
    app.press('multi');
    const scripts = app.scripts();
    assert.equal(scripts.length, 1);
    assert.ok(scripts[0].src.endsWith('/socket.io/socket.io.js'), scripts[0].src);
    assert.ok(scripts[0].src.startsWith(RENDER_URL));
  });
  it('opens no socket until Create or Join', async () => {
    const app = setupMp();
    app.press('multi');
    await flush();
    app.clock.advance(60000);
    await flush();
    assert.equal(app.ioCalls.length, 0);
  });
});

describe('Join with a malformed code', () => {
  function badJoin(value = 'k7q') {
    const app = setupMp();
    app.press('multi');
    app.el('room-code-input').focus();
    const event = app.submitJoin(value);
    return { app, event };
  }
  it('shows #room-code-error with ROOM_CODE_FORMAT_MESSAGE', () => {
    const { app } = badJoin();
    assert.equal(app.el('room-code-error').hidden, false);
    assert.equal(app.el('room-code-error').textContent, MP.ROOM_CODE_FORMAT_MESSAGE);
  });
  it('sets aria-invalid="true" on the code input', () => {
    assert.equal(badJoin().app.el('room-code-input').getAttribute('aria-invalid'), 'true');
  });
  it("stays in phase 'menu' and keeps focus in the input", () => {
    const { app } = badJoin();
    assert.equal(app.get('state.phase'), 'menu');
    assert.equal(app.document.activeElement, app.el('room-code-input'));
  });
  it('keeps what was typed in the input', () => assert.equal(badJoin('k7q').app.el('room-code-input').value, 'k7q'));
  it('prevents the form submission', () => assert.equal(badJoin().event.defaultPrevented, true));
  it('attempts no socket and appends no new script', async () => {
    const { app } = badJoin();
    await flush();
    app.clock.advance(10000);
    await flush();
    assert.equal(app.ioCalls.length, 0);
    assert.equal(app.scripts().length, 0);
  });
  it('announces the error once', () => {
    const app = setupMp();
    app.press('multi');
    app.settle();
    const before = app.spoken.length;
    app.submitJoin('k7q');
    app.settle();
    assert.deepEqual(app.spokenSince(before), [MP.ROOM_CODE_FORMAT_MESSAGE]);
  });
  it("asks for a code when the input is empty", () => {
    const { app } = badJoin('   ');
    assert.equal(app.el('room-code-error').textContent, 'Enter a room code.');
  });
  it('clears the error and aria-invalid once a valid code is sent', () => {
    const { app } = badJoin();
    app.submitJoin('K7QM2X');
    assert.equal(app.get('state.phase'), 'connecting');
    assert.equal(app.el('room-code-error').hidden, true);
    assert.equal(app.el('room-code-input').getAttribute('aria-invalid'), null);
  });
});

describe('the keydown guard (isTextEntryTarget)', () => {
  it('ignores a key typed in the code input: no preventDefault and the solo test does not start', () => {
    const app = setupMp();
    const event = app.keydown('a', app.el('room-code-input'));
    assert.equal(event.defaultPrevented, false);
    assert.equal(app.get('state.mode'), 'solo');
    assert.equal(app.get('state.phase'), 'idle');
    assert.equal(app.get('state.index'), 0);
  });
  it('ignores a key typed in the code input in the menu: the state is unchanged', () => {
    const app = setupMp();
    app.press('multi');
    const event = app.keydown('a', app.el('room-code-input'));
    assert.equal(event.defaultPrevented, false);
    assert.equal(app.get('state.mode'), 'multi');
    assert.equal(app.get('state.phase'), 'menu');
  });
  for (const key of [' ', 'Enter', 'Backspace']) {
    it(`leaves ${JSON.stringify(key)} to the code input`, () => {
      const app = setupMp();
      app.press('multi');
      assert.equal(app.keydown(key, app.el('room-code-input')).defaultPrevented, false);
    });
  }
  it('ignores a key typed in the invite link field', () => {
    const app = setupMp();
    const event = app.keydown('a', app.el('room-link'));
    assert.equal(event.defaultPrevented, false);
    assert.equal(app.get('state.phase'), 'idle');
  });
  it('ignores a key typed in any other text field', () => {
    const app = setupMp();
    const field = app.document.createElement('input');
    app.document.body.appendChild(field);
    assert.equal(app.keydown('a', field).defaultPrevented, false);
    assert.equal(app.get('state.phase'), 'idle');
  });
  it('still starts the solo test for a key typed in the typing input', () => {
    const app = setupMp();
    const event = app.keydown('a', app.el('hidden-input'));
    assert.equal(event.defaultPrevented, true);
    assert.equal(app.get('state.phase'), 'running');
    assert.equal(app.get('state.index'), 1);
  });
  it('still starts the solo test for a key typed with focus on the page body', () => {
    const app = setupMp();
    app.keydown('a', app.document.body);
    assert.equal(app.get('state.phase'), 'running');
  });
  it('still starts the solo test without multiplayer.js', () => {
    const app = loadApp({ withMultiplayer: false });
    assert.equal(app.error, null, app.error && app.error.message);
    const event = { key: 'a', target: app.elements.get('hidden-input'), metaKey: false, ctrlKey: false, altKey: false,
      isComposing: false, getModifierState: () => false, preventDefault() {} };
    for (const fn of app.document.listeners.keydown) fn(event);
    assert.equal(vm.runInContext('state.phase', app.ctx), 'running');
  });
});

describe('pressing Solo from the menu', () => {
  it('goes back to solo', () => {
    const app = setupMp();
    app.press('multi');
    app.press('solo');
    assert.equal(app.get('state.mode'), 'solo');
    assert.equal(app.el('race-panel').hidden, true);
  });
  it('leaves no hash in the address bar when there was no invite', () => {
    const app = setupMp();
    app.press('multi');
    app.press('solo');
    assert.equal(app.window.location.hash, '');
    assert.ok(app.history.calls.every((url) => !url.includes('#')), JSON.stringify(app.history.calls));
  });
  // PLAN.md section 9 expected replaceState to drop the hash here. script.js
  // (leaveMultiplayer) now keeps an unused invite on purpose: no room was
  // entered, so the link is still the user's. Tested as built; see the report.
  it('keeps an unused invite: the hash stays and the banner shows again', () => {
    const app = setupMp({ hash: '#room=k7qm2x' });
    app.press('multi');
    app.press('solo');
    assert.equal(app.window.location.hash, '#room=k7qm2x');
    assert.equal(app.el('invite').hidden, false);
    assert.equal(app.el('invite-code').textContent, 'K7QM2X');
  });
  it('leaves the room hash out after leaving a room', async () => {
    const app = setupMp();
    await createRoom(app);
    assert.ok(app.window.location.hash.startsWith('#room=K7QM2X'));
    app.press('solo');
    assert.ok(!app.history.calls.at(-1).includes('#'), app.history.calls.at(-1));
    assert.equal(app.window.location.hash, '');
  });
});

describe('the M2 markup in index.html', () => {
  const row = (HTML.match(/<div class="room-code-row">([\s\S]*?)<\/div>/) || [])[1] || '';
  it('puts #copy-link-btn in the same .room-code-row as #room-code', () => {
    assert.match(row, /id="room-code"/);
    assert.match(row, /id="copy-link-btn"/);
  });
  it('wraps the "Room code" word before #room-code in an aria-hidden element', () => {
    const word = row.search(/<span aria-hidden="true">Room code<\/span>/);
    assert.ok(word >= 0, 'aria-hidden "Room code" span');
    assert.ok(word < row.indexOf('id="room-code"'));
  });
  it('marks #room-code itself aria-hidden, with a spelled-out twin', () => {
    assert.match(HTML, /<span id="room-code"[^>]*aria-hidden="true"/);
    assert.match(HTML, /<span id="room-code-spelled" class="visually-hidden">/);
  });
  it('gives #solo-tip the SOLO_TIP text, hidden, with no aria-live', () => {
    const tip = HTML.match(/<p id="solo-tip"([^>]*)>([^<]*)<\/p>/);
    assert.ok(tip, '#solo-tip paragraph');
    assert.equal(tip[2], MP.SOLO_TIP);
    assert.match(tip[1], /\shidden\b/);
    assert.doesNotMatch(tip[1], /aria-live|role=/);
  });
  it('describes #start-btn by #start-hint', () => {
    assert.match(HTML, /<button id="start-btn"[^>]*aria-describedby="start-hint"/);
  });
  it('starts #start-btn hidden and has no disabled attribute on it', () => {
    const tag = HTML.match(/<button id="start-btn"[^>]*>/)[0];
    assert.match(tag, /\shidden\b/);
    assert.doesNotMatch(tag, /\sdisabled\b/);
  });
  it('makes the join form novalidate', () => assert.match(HTML, /<form id="join-form"[^>]*\snovalidate/));
  it('describes the code input by its hint and its error', () => {
    assert.match(HTML, /<input id="room-code-input"[^>]*aria-describedby="room-code-hint room-code-error"/);
  });
  it('labels the code input', () => assert.match(HTML, /<label for="room-code-input"/));
  it('makes the invite link field read-only', () => assert.match(HTML, /<input id="room-link"[^>]*\sreadonly/));
  it('does not give #menu-error role="alert"', () => {
    const tag = (HTML.match(/<p id="menu-error"[^>]*>/) || [])[0];
    assert.ok(tag, '#menu-error paragraph');
    assert.doesNotMatch(tag, /role="alert"/);
  });
  it('describes #create-room-btn by #menu-error', () => {
    const tag = (HTML.match(/<button id="create-room-btn"[^>]*>/) || [])[0];
    assert.ok(tag, '#create-room-btn button');
    assert.match(tag, /\saria-describedby="menu-error"/);
  });
  it('does not make #room-code-error live', () => {
    assert.doesNotMatch(HTML.match(/<p id="room-code-error"[^>]*>/)[0], /aria-live|role=/);
  });
  it('makes #race-title focusable by script (tabindex="-1")', () => {
    assert.match(HTML, /<h2 id="race-title"[^>]*tabindex="-1"/);
  });
  it('defines every element id script.js looks up', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
    const ids = [...src.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
    for (const id of ids) assert.match(HTML, new RegExp(`id="${id}"`), id);
  });
});
