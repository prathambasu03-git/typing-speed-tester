'use strict';

/*
 * Tests for the Node export of words.js (used by the multiplayer server).
 * The classic-script behaviour of words.js is covered in stats.test.js.
 * Run from the repo root with:  node --test tests/
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const WORDS_SRC = fs.readFileSync(path.join(__dirname, '..', 'words.js'), 'utf8');

describe('words.js Node export', () => {
  it('exports WORDS as a non-empty array', () => {
    const { WORDS } = require('../words.js');
    assert.ok(Array.isArray(WORDS));
    assert.ok(WORDS.length > 0);
  });

  it('exports a frozen WORDS array', () => {
    const { WORDS } = require('../words.js');
    assert.equal(Object.isFrozen(WORDS), true);
  });

  it('exports only non-empty strings without whitespace', () => {
    const { WORDS } = require('../words.js');
    for (const word of WORDS) {
      assert.equal(typeof word, 'string');
      assert.ok(word.length > 0);
      assert.equal(/\s/.test(word), false, `"${word}" contains whitespace`);
    }
  });

  it('exports no duplicate words', () => {
    const { WORDS } = require('../words.js');
    assert.equal(new Set(WORDS).size, WORDS.length);
  });

  it('does not leak WORDS onto globalThis when required', () => {
    require('../words.js');
    assert.equal(typeof globalThis.WORDS, 'undefined');
  });

  it('exports the same list that the classic script defines as a global', () => {
    const { WORDS } = require('../words.js');
    const ctx = vm.createContext({});
    vm.runInContext(WORDS_SRC, ctx, { filename: 'words.js' });
    const classic = vm.runInContext('WORDS', ctx);
    assert.deepEqual([...classic], [...WORDS]);
  });

  it('skips the Node export when loaded as a classic script with no module', () => {
    const ctx = vm.createContext({});
    assert.doesNotThrow(() => vm.runInContext(WORDS_SRC, ctx, { filename: 'words.js' }));
    assert.equal(vm.runInContext('typeof module', ctx), 'undefined');
    assert.equal(vm.runInContext('Array.isArray(WORDS)', ctx), true);
  });
});
