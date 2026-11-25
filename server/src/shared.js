'use strict';

/* The only server file that reaches outside server/. WPM and accuracy come
   from the same stats.js the browser uses, so both sides always agree.
   M5 note: the Docker build context must include these two root files. */

const { computeStats, generateChars } = require('../../stats.js');
const { WORDS } = require('../../words.js');

if (!Array.isArray(WORDS) || WORDS.length === 0) {
  throw new Error('shared.js: words.js must export a non-empty WORDS array');
}
if (typeof computeStats !== 'function' || typeof generateChars !== 'function') {
  throw new Error('shared.js: stats.js must export computeStats and generateChars');
}

module.exports = { computeStats, generateChars, WORDS };
