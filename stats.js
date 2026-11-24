'use strict';

/* ==========================================================================
   Typing Speed Tester: pure logic
   --------------------------------------------------------------------------
   Data in, values out. Nothing here touches the DOM, `window` or storage, so
   the same file runs as a classic browser script (loaded after words.js and
   before script.js) and can be `require`d by Node tests.
   ========================================================================== */

/* ---------- 1. Durations and record validation ---------- */

/** Allowed test lengths in seconds. script.js reads this through CONFIG. */
const DURATIONS = Object.freeze([15, 30, 60]);

function isValidDuration(value, durations = DURATIONS) {
  return durations.includes(value);
}

/** True for a stored result that is safe to display (wpm, accuracy, duration). */
function isValidRecord(record) {
  return (
    record !== null &&
    typeof record === 'object' &&
    Number.isFinite(record.wpm) &&
    Number.isFinite(record.accuracy) &&
    isValidDuration(record.duration)
  );
}

/* ---------- 2. Word generation ---------- */

// The word list is resolved at call time, not load time: in Node the browser
// global WORDS does not exist, and tests pass their own list instead.
function resolveWordList(wordList) {
  if (wordList !== undefined) return wordList;
  return typeof WORDS !== 'undefined' ? WORDS : [];
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

/** Picks `count` words from `wordList`. `random` is injectable for tests. */
function randomWords(count, wordList, random = Math.random) {
  const list = resolveWordList(wordList);
  if (!Array.isArray(list) || list.length === 0 || !isNonNegativeInteger(count)) return [];

  const words = [];
  for (let i = 0; i < count; i += 1) {
    words.push(list[Math.floor(random() * list.length)]);
  }
  return words;
}

/** 50 words -> "the cat ran" -> ['t','h','e',' ','c', ...] */
function generateChars(wordCount, wordList, random = Math.random) {
  return randomWords(wordCount, wordList, random).join(' ').split('');
}

/* ---------- 3. Stats ---------- */

function toSafeNumber(value) {
  return Number.isFinite(value) ? value : 0;
}

function countResults(results, kind) {
  let count = 0;
  for (const result of results) {
    if (result === kind) count += 1;
  }
  return count;
}

/** Words per minute, where one "word" is 5 characters. */
function calculateWpm(charCount, elapsedMs) {
  const minutes = elapsedMs / 60000;
  if (minutes <= 0) return 0;
  return toSafeNumber(charCount / 5 / minutes);
}

/** Percentage of keystrokes that were correct (0 when nothing was typed). */
function calculateAccuracy(correctKeystrokes, totalKeystrokes) {
  if (totalKeystrokes <= 0) return 0;
  return toSafeNumber((correctKeystrokes / totalKeystrokes) * 100);
}

/** Every number the UI shows, derived from a state snapshot and an elapsed time. */
function computeStats(snapshot, elapsedMs) {
  const correctChars = countResults(snapshot.results, 'correct');
  const incorrectChars = countResults(snapshot.results, 'incorrect');
  return {
    wpm: Math.round(calculateWpm(correctChars, elapsedMs)),
    rawWpm: Math.round(calculateWpm(snapshot.totalKeystrokes, elapsedMs)),
    accuracy: Math.round(calculateAccuracy(snapshot.correctKeystrokes, snapshot.totalKeystrokes)),
    correctChars,
    incorrectChars,
    duration: snapshot.duration,
  };
}

/* ---------- 4. Node export (ignored in the browser) ---------- */

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
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
  };
}
