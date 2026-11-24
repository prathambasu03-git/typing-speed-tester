'use strict';

/*
 * Unit tests for stats.js, the DOM-free logic of the typing speed tester.
 * Run from the repo root with:  node --test tests/
 * Only Node built-ins are used.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const STATS_SRC = fs.readFileSync(path.join(ROOT, 'stats.js'), 'utf8');
const WORDS_SRC = fs.readFileSync(path.join(ROOT, 'words.js'), 'utf8');

const {
  DURATIONS,
  calculateWpm,
  calculateAccuracy,
  computeStats,
  isValidRecord,
  isValidDuration,
  generateChars,
  randomWords,
  toSafeNumber,
  countResults,
} = require('../stats.js');

/** Returns a `random` function that yields the given values in order, then repeats. */
function sequence(...values) {
  let i = 0;
  return () => {
    const value = values[i % values.length];
    i += 1;
    return value;
  };
}

/** A valid stored record; tests override one field at a time. */
function record(overrides = {}) {
  return { wpm: 60, accuracy: 95, duration: 30, date: 1700000000000, ...overrides };
}

/** A computeStats snapshot. */
function snapshot(overrides = {}) {
  return { results: [], totalKeystrokes: 0, correctKeystrokes: 0, duration: 30, ...overrides };
}

/** Readable label for a test value, e.g. the string '3' vs the number 3. */
function label(value) {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/* ------------------------------------------------------------------------ */

describe('DURATIONS', () => {
  it('lists 15, 30 and 60 seconds', () => {
    assert.deepEqual([...DURATIONS], [15, 30, 60]);
  });

  it('is frozen so no code can change the allowed lengths', () => {
    assert.equal(Object.isFrozen(DURATIONS), true);
  });
});

describe('isValidDuration', () => {
  for (const value of [15, 30, 60]) {
    it(`accepts ${value} seconds`, () => {
      assert.equal(isValidDuration(value), true);
    });
  }

  it('rejects the string "30", because the check is strict', () => {
    assert.equal(isValidDuration('30'), false);
  });

  it('rejects 0', () => {
    assert.equal(isValidDuration(0), false);
  });

  it('rejects NaN', () => {
    assert.equal(isValidDuration(NaN), false);
  });

  it('rejects null and undefined', () => {
    assert.equal(isValidDuration(null), false);
    assert.equal(isValidDuration(undefined), false);
  });

  it('rejects a number that is not in the list, such as 45', () => {
    assert.equal(isValidDuration(45), false);
  });

  it('honours a custom list of durations', () => {
    assert.equal(isValidDuration(45, [45, 90]), true);
    assert.equal(isValidDuration(30, [45, 90]), false);
  });
});

describe('isValidRecord', () => {
  it('accepts a well-formed record', () => {
    assert.equal(isValidRecord(record()), true);
  });

  describe('wpm boundaries', () => {
    it('accepts wpm 0', () => assert.equal(isValidRecord(record({ wpm: 0 })), true));
    it('accepts wpm 1000', () => assert.equal(isValidRecord(record({ wpm: 1000 })), true));
    it('rejects wpm 1000.1', () => assert.equal(isValidRecord(record({ wpm: 1000.1 })), false));
    it('rejects wpm -0.1', () => assert.equal(isValidRecord(record({ wpm: -0.1 })), false));
    it('rejects wpm NaN', () => assert.equal(isValidRecord(record({ wpm: NaN })), false));
    it('rejects wpm Infinity', () => assert.equal(isValidRecord(record({ wpm: Infinity })), false));
    it('rejects wpm given as the string "50"', () => assert.equal(isValidRecord(record({ wpm: '50' })), false));
  });

  describe('accuracy boundaries', () => {
    it('accepts accuracy 0', () => assert.equal(isValidRecord(record({ accuracy: 0 })), true));
    it('accepts accuracy 100', () => assert.equal(isValidRecord(record({ accuracy: 100 })), true));
    it('rejects accuracy 100.1', () => assert.equal(isValidRecord(record({ accuracy: 100.1 })), false));
    it('rejects accuracy -0.1', () => assert.equal(isValidRecord(record({ accuracy: -0.1 })), false));
    it('rejects accuracy NaN', () => assert.equal(isValidRecord(record({ accuracy: NaN })), false));
    it('rejects accuracy -Infinity', () => assert.equal(isValidRecord(record({ accuracy: -Infinity })), false));
    it('rejects accuracy given as the string "50"', () => assert.equal(isValidRecord(record({ accuracy: '50' })), false));
  });

  describe('duration and date', () => {
    it('rejects a duration that is not allowed', () => assert.equal(isValidRecord(record({ duration: 45 })), false));
    it('rejects a duration given as a string', () => assert.equal(isValidRecord(record({ duration: '30' })), false));
    it('rejects a date given as a string', () => assert.equal(isValidRecord(record({ date: '2024-01-01' })), false));
    it('rejects a NaN date', () => assert.equal(isValidRecord(record({ date: NaN })), false));
    it('rejects an Infinity date', () => assert.equal(isValidRecord(record({ date: Infinity })), false));
  });

  describe('missing fields', () => {
    for (const field of ['wpm', 'accuracy', 'duration', 'date']) {
      it(`rejects a record without "${field}"`, () => {
        const r = record();
        delete r[field];
        assert.equal(isValidRecord(r), false);
      });
    }

    it('rejects an empty object', () => assert.equal(isValidRecord({}), false));
  });

  describe('values that are not records', () => {
    it('rejects null', () => assert.equal(isValidRecord(null), false));
    it('rejects undefined', () => assert.equal(isValidRecord(undefined), false));
    it('rejects an array', () => assert.equal(isValidRecord([60, 95, 30, 1700000000000]), false));
    it('rejects a number', () => assert.equal(isValidRecord(60), false));
    it('rejects a string', () => assert.equal(isValidRecord('{"wpm":60}'), false));
    it('rejects a boolean', () => assert.equal(isValidRecord(true), false));
  });
});

describe('calculateWpm', () => {
  it('turns 250 characters in one minute into 50 wpm', () => {
    assert.equal(calculateWpm(250, 60000), 50);
  });

  it('scales with time: 250 characters in 30 seconds is 100 wpm', () => {
    assert.equal(calculateWpm(250, 30000), 100);
  });

  it('returns 0 for zero characters', () => {
    assert.equal(calculateWpm(0, 60000), 0);
  });

  it('returns 0 when no time has elapsed', () => {
    assert.equal(calculateWpm(100, 0), 0);
  });

  it('returns 0 for a negative elapsed time', () => {
    assert.equal(calculateWpm(100, -5000), 0);
  });

  it('returns 0, never NaN, for a NaN elapsed time', () => {
    assert.equal(calculateWpm(100, NaN), 0);
  });

  it('returns 0, never NaN, for a NaN character count', () => {
    assert.equal(calculateWpm(NaN, 60000), 0);
  });

  it('returns 0, never Infinity, for an infinite character count', () => {
    assert.equal(calculateWpm(Infinity, 60000), 0);
  });

  it('returns 0, never NaN, for infinite characters over infinite time', () => {
    assert.equal(calculateWpm(Infinity, Infinity), 0);
  });

  it('returns 0 when called with no arguments', () => {
    assert.equal(calculateWpm(), 0);
  });
});

describe('calculateAccuracy', () => {
  it('returns 100 when every keystroke was correct', () => {
    assert.equal(calculateAccuracy(50, 50), 100);
  });

  it('returns 0 when no keystroke was correct', () => {
    assert.equal(calculateAccuracy(0, 50), 0);
  });

  it('returns 0 when nothing was typed', () => {
    assert.equal(calculateAccuracy(0, 0), 0);
  });

  it('returns 0 for a negative total', () => {
    assert.equal(calculateAccuracy(5, -1), 0);
  });

  it('returns an unrounded percentage (1 of 3 is 33.33...)', () => {
    // Compare with a float tolerance: (1 / 3) * 100 and 100 / 3 differ in the last bit.
    const accuracy = calculateAccuracy(1, 3);
    assert.ok(Math.abs(accuracy - 100 / 3) < 1e-9, `expected about 33.333, got ${accuracy}`);
    assert.equal(Number.isInteger(accuracy), false);
  });

  it('returns 0, never NaN, for a NaN total', () => {
    assert.equal(calculateAccuracy(5, NaN), 0);
  });

  it('returns 0, never NaN, for a NaN correct count', () => {
    assert.equal(calculateAccuracy(NaN, 10), 0);
  });

  it('returns 0, never NaN, for an infinite total and infinite correct count', () => {
    assert.equal(calculateAccuracy(Infinity, Infinity), 0);
  });
});

describe('computeStats', () => {
  const ONE_MINUTE = 60000;

  it('returns exactly the expected set of fields', () => {
    const stats = computeStats(snapshot(), ONE_MINUTE);
    assert.deepEqual(Object.keys(stats).sort(), ['accuracy', 'correctChars', 'duration', 'incorrectChars', 'rawWpm', 'wpm']);
  });

  it('counts correct and incorrect characters and ignores untyped (null) ones', () => {
    const stats = computeStats(snapshot({ results: ['correct', 'incorrect', null, 'correct', null] }), ONE_MINUTE);
    assert.equal(stats.correctChars, 2);
    assert.equal(stats.incorrectChars, 1);
  });

  it('bases wpm on correct characters and rawWpm on all keystrokes', () => {
    const results = [...Array(250).fill('correct'), ...Array(50).fill('incorrect')];
    const stats = computeStats(snapshot({ results, totalKeystrokes: 300, correctKeystrokes: 250 }), ONE_MINUTE);
    assert.equal(stats.wpm, 50);
    assert.equal(stats.rawWpm, 60);
  });

  it('rounds wpm and rawWpm to whole numbers', () => {
    // 13 chars in one minute = 2.6 wpm -> 3; 12 keystrokes = 2.4 wpm -> 2.
    const stats = computeStats(snapshot({ results: Array(13).fill('correct'), totalKeystrokes: 12 }), ONE_MINUTE);
    assert.equal(stats.wpm, 3);
    assert.equal(stats.rawWpm, 2);
  });

  it('floors accuracy so a single mistake keeps it below 100 (249 of 250 is 99)', () => {
    const stats = computeStats(snapshot({ totalKeystrokes: 250, correctKeystrokes: 249 }), ONE_MINUTE);
    assert.equal(stats.accuracy, 99);
  });

  it('does not lose a point to float error (57 of 100 is exactly 57, not 56)', () => {
    const stats = computeStats(snapshot({ totalKeystrokes: 100, correctKeystrokes: 57 }), ONE_MINUTE);
    assert.equal(stats.accuracy, 57);
  });

  it('reports 100 accuracy for a perfect run (3 of 3)', () => {
    const stats = computeStats(snapshot({ totalKeystrokes: 3, correctKeystrokes: 3 }), ONE_MINUTE);
    assert.equal(stats.accuracy, 100);
  });

  it('reports 0 accuracy when nothing was typed (0 of 0)', () => {
    const stats = computeStats(snapshot(), ONE_MINUTE);
    assert.equal(stats.accuracy, 0);
  });

  it('passes the duration through unchanged', () => {
    assert.equal(computeStats(snapshot({ duration: 15 }), ONE_MINUTE).duration, 15);
  });

  it('reports zero wpm, not NaN or Infinity, when no time has elapsed', () => {
    const stats = computeStats(snapshot({ results: ['correct'], totalKeystrokes: 1, correctKeystrokes: 1 }), 0);
    assert.equal(stats.wpm, 0);
    assert.equal(stats.rawWpm, 0);
  });

  it('returns all zeros for an empty results array', () => {
    const stats = computeStats(snapshot({ results: [] }), ONE_MINUTE);
    assert.deepEqual(stats, { wpm: 0, rawWpm: 0, accuracy: 0, correctChars: 0, incorrectChars: 0, duration: 30 });
  });
});

describe('randomWords', () => {
  const LIST = ['alpha', 'beta', 'gamma', 'delta'];

  it('returns the requested number of words', () => {
    assert.equal(randomWords(25, LIST).length, 25);
  });

  it('only returns words from the given list', () => {
    for (const word of randomWords(100, LIST)) assert.ok(LIST.includes(word), `unexpected word ${word}`);
  });

  it('picks list[Math.floor(random() * length)] with an injected random', () => {
    // 0 -> index 0, 0.5 -> index 2, 0.99 -> index 3, 0.25 -> index 1
    assert.deepEqual(randomWords(4, LIST, sequence(0, 0.5, 0.99, 0.25)), ['alpha', 'gamma', 'delta', 'beta']);
  });

  it('is deterministic when given the same random sequence', () => {
    const a = randomWords(10, LIST, sequence(0.1, 0.7, 0.4));
    const b = randomWords(10, LIST, sequence(0.1, 0.7, 0.4));
    assert.deepEqual(a, b);
  });

  it('returns an empty array for a count of 0', () => {
    assert.deepEqual(randomWords(0, LIST), []);
  });

  for (const bad of [-1, 1.5, NaN, '3']) {
    it(`returns an empty array for the invalid count ${label(bad)}`, () => {
      assert.deepEqual(randomWords(bad, LIST), []);
    });
  }

  it('returns an empty array for an empty word list', () => {
    assert.deepEqual(randomWords(5, []), []);
  });

  it('returns an empty array for a word list that is not an array', () => {
    assert.deepEqual(randomWords(5, 'alpha beta'), []);
    assert.deepEqual(randomWords(5, null), []);
    assert.deepEqual(randomWords(5, { 0: 'alpha', length: 1 }), []);
  });

  it('returns an empty array when no list is given and no global WORDS exists (Node)', () => {
    assert.equal(typeof globalThis.WORDS, 'undefined');
    assert.deepEqual(randomWords(5), []);
  });
});

describe('generateChars', () => {
  const LIST = ['the', 'cat', 'ran'];

  it('joins the chosen words with single spaces and splits them into characters', () => {
    const chars = generateChars(3, LIST, sequence(0, 0.4, 0.9));
    assert.deepEqual(chars, 'the cat ran'.split(''));
  });

  it('has no leading or trailing space', () => {
    const chars = generateChars(20, LIST);
    assert.notEqual(chars[0], ' ');
    assert.notEqual(chars[chars.length - 1], ' ');
  });

  it('never puts two spaces in a row', () => {
    assert.equal(generateChars(30, LIST).join('').includes('  '), false);
  });

  it('produces the requested number of words', () => {
    assert.equal(generateChars(12, LIST).join('').split(' ').length, 12);
  });

  it('returns single characters only', () => {
    for (const ch of generateChars(10, LIST)) assert.equal(ch.length, 1);
  });

  it('is deterministic when given the same random sequence', () => {
    assert.deepEqual(generateChars(8, LIST, sequence(0.2, 0.8)), generateChars(8, LIST, sequence(0.2, 0.8)));
  });

  it('returns an empty array for a word count of 0', () => {
    assert.deepEqual(generateChars(0, LIST), []);
  });

  for (const bad of [-1, 1.5, NaN, '3']) {
    it(`returns an empty array for the invalid word count ${label(bad)}`, () => {
      assert.deepEqual(generateChars(bad, LIST), []);
    });
  }

  it('returns an empty array for an empty word list', () => {
    assert.deepEqual(generateChars(5, []), []);
  });

  it('returns an empty array for a word list that is not an array', () => {
    assert.deepEqual(generateChars(5, 'the cat'), []);
  });

  it('returns an empty array when no list is given and no global WORDS exists (Node)', () => {
    assert.deepEqual(generateChars(5), []);
  });
});

describe('toSafeNumber', () => {
  it('passes finite numbers through unchanged', () => {
    assert.equal(toSafeNumber(42), 42);
    assert.equal(toSafeNumber(-3.5), -3.5);
    assert.equal(toSafeNumber(0), 0);
  });

  it('turns NaN into 0', () => assert.equal(toSafeNumber(NaN), 0));
  it('turns Infinity into 0', () => assert.equal(toSafeNumber(Infinity), 0));
  it('turns -Infinity into 0', () => assert.equal(toSafeNumber(-Infinity), 0));

  it('turns non-numbers into 0 instead of coercing them', () => {
    assert.equal(toSafeNumber('5'), 0);
    assert.equal(toSafeNumber(null), 0);
    assert.equal(toSafeNumber(undefined), 0);
  });
});

describe('countResults', () => {
  const RESULTS = ['correct', 'incorrect', null, 'correct', 'correct', null, 'incorrect'];

  it('counts correct results', () => assert.equal(countResults(RESULTS, 'correct'), 3));
  it('counts incorrect results', () => assert.equal(countResults(RESULTS, 'incorrect'), 2));
  it('counts untyped (null) results when asked for null', () => assert.equal(countResults(RESULTS, null), 2));
  it('returns 0 for an empty results array', () => assert.equal(countResults([], 'correct'), 0));
  it('returns 0 when the kind never appears', () => assert.equal(countResults(['incorrect'], 'correct'), 0));
});

describe('loading stats.js as a browser-style classic script', () => {
  it('runs in a vm context with no document or window, proving it is DOM-free', () => {
    const ctx = vm.createContext({});
    assert.doesNotThrow(() => vm.runInContext(STATS_SRC, ctx, { filename: 'stats.js' }));
    assert.equal(vm.runInContext('typeof document', ctx), 'undefined');
    assert.equal(vm.runInContext('typeof window', ctx), 'undefined');
    assert.equal(vm.runInContext('typeof computeStats', ctx), 'function');
  });

  it('skips the Node export when there is no module (the browser case)', () => {
    const ctx = vm.createContext({});
    vm.runInContext(STATS_SRC, ctx);
    assert.equal(vm.runInContext('typeof module', ctx), 'undefined');
  });

  describe('after words.js in the same context', () => {
    function loadBoth() {
      const ctx = vm.createContext({});
      vm.runInContext(WORDS_SRC, ctx, { filename: 'words.js' });
      vm.runInContext(STATS_SRC, ctx, { filename: 'stats.js' });
      return ctx;
    }

    it('generateChars(n) with no list uses the global WORDS', () => {
      const ctx = loadBoth();
      const { words, chars } = vm.runInContext('({ words: WORDS, chars: generateChars(40) })', ctx);
      const picked = chars.join('').split(' ');
      assert.equal(picked.length, 40);
      for (const word of picked) assert.ok(words.includes(word), `"${word}" is not in WORDS`);
    });

    it('randomWords(n) with no list returns n words from WORDS', () => {
      const ctx = loadBoth();
      const { words, picked } = vm.runInContext('({ words: WORDS, picked: randomWords(25) })', ctx);
      assert.equal(picked.length, 25);
      for (const word of picked) assert.ok(words.includes(word), `"${word}" is not in WORDS`);
    });

    it('WORDS has no empty, whitespace-containing or duplicate entries', () => {
      const words = vm.runInContext('WORDS', loadBoth());
      assert.ok(words.length > 0);
      for (const word of words) {
        assert.equal(typeof word, 'string');
        assert.ok(word.length > 0, 'empty word');
        assert.equal(/\s/.test(word), false, `"${word}" contains whitespace`);
      }
      assert.equal(new Set(words).size, words.length, 'duplicate words');
    });
  });
});
