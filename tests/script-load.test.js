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
const { loadApp } = require('./helpers/load-script.js');

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
