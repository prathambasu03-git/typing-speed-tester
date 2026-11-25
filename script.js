'use strict';

/* ==========================================================================
   Typing Speed Tester
   --------------------------------------------------------------------------
   Architecture
   - `state` is the single source of truth for the current test.
   - Event handlers change `state`, then call small render functions.
   - Render functions only WRITE to the DOM. Nothing is read back from the DOM
     as state (only layout positions are measured, for the caret).
   - Phases: idle -> running (first valid key) -> finished (timer hits 0)
             finished -> idle (restart)
   - Multiplayer (section 12) reuses the same `state` with `mode: 'multi'`:
             connecting -> waiting -> countdown -> running -> finished
             finished -> countdown (rematch) or waiting (opponent left)
     Socket events update `state`, then render. Only section 12 emits events.
   ========================================================================== */

/* ---------- 0. Dependency guard ---------- */

// stats.js missing (e.g. a 404): show a message, then throw, because the rest
// of this file would otherwise fail at its first use with no visible error.
if (typeof DURATIONS === 'undefined' || typeof computeStats !== 'function' ||
    typeof generateChars !== 'function' || typeof isValidRecord !== 'function') {
  const loadError = document.getElementById('load-error');
  const input = document.getElementById('hidden-input');
  if (loadError) {
    loadError.hidden = false; // unhide before writing so the alert is announced
    loadError.textContent = 'The app could not be loaded. Please reload the page.';
  }
  if (input) input.disabled = true;
  throw new Error('stats.js failed to load');
}

// multiplayer.js missing only switches multiplayer off; solo never depends on it.
const MP_AVAILABLE = typeof resolveServerUrl === 'function' && typeof validateRoomState === 'function' &&
  typeof isServerUsable === 'function' && typeof pickServerUrl === 'function' &&
  typeof MP_CONSTANTS === 'object';

/* ---------- 1. Configuration ---------- */

const CONFIG = Object.freeze({
  wordCount: 50,            // words generated at the start of a test
  extendWordCount: 25,      // words appended when the user nears the end
  extendThreshold: 40,      // append when fewer than this many chars remain
  tickMs: 100,              // timer refresh rate (display only, never used to measure time)
  durations: DURATIONS,     // defined in stats.js, the single source of truth
  defaultDuration: 30,
  historySize: 10,
  minLiveElapsedMs: 1000,   // stops the live WPM spiking in the first second
  describedWordCount: 30,   // words in the input's screen-reader description
  // Fewer in a race: the description is read when the countdown focuses the
  // input, and a long one would push "Go!" past the actual start.
  raceDescribedWordCount: 8,
  resultAnnounceDelayMs: 100, // lets the focus move settle before the result is spoken
  // Game server origin for this page (null = multiplayer off): the local
  // server on localhost pages, else the meta tag's URL (see pickServerUrl).
  // There is no query-string override: the client runs a script from this URL.
  serverUrl: MP_AVAILABLE
    ? pickServerUrl(document.querySelector('meta[name="typing-server-url"]')?.content, window.location)
    : null,
});

// Multiplayer is offered only when multiplayer.js loaded and this page has a
// usable server (pickServerUrl rules out file://, the placeholder, a loopback
// server on a public page and mixed content).
const MP_ENABLED = MP_AVAILABLE && CONFIG.serverUrl !== null;

const STORAGE_KEYS = Object.freeze({
  history: 'typing:history',
  best: 'typing:best',
  theme: 'typing:theme',
  duration: 'typing:duration',
});

// Kept in the mobile input so Backspace always has something to delete.
const INPUT_SENTINEL = ' ';

/* ---------- 2. DOM references (looked up once) ---------- */

const dom = {
  root: document.documentElement,
  body: document.body,
  themeToggle: document.getElementById('theme-toggle'),
  mode: document.getElementById('mode'),
  modeButtons: document.querySelectorAll('#mode [data-mode]'),
  settings: document.getElementById('settings'),
  settingButtons: document.querySelectorAll('#settings [data-duration]'),
  timer: document.getElementById('timer'),
  liveWpm: document.getElementById('live-wpm'),
  liveAcc: document.getElementById('live-acc'),
  liveBest: document.getElementById('live-best'),
  liveBestStat: document.getElementById('live-best-stat'),
  mpError: document.getElementById('mp-error'),
  racePanel: document.getElementById('race-panel'),
  raceTitle: document.getElementById('race-title'),
  raceStatus: document.getElementById('race-status'),
  raceTracks: document.getElementById('race-tracks'),
  typingArea: document.getElementById('typing-area'),
  track: document.getElementById('words-track'),
  words: document.getElementById('words'),
  loadError: document.getElementById('load-error'),
  wordsText: document.getElementById('words-text'),
  caret: document.getElementById('caret'),
  input: document.getElementById('hidden-input'),
  hint: document.getElementById('typing-hint'),
  raceHint: document.getElementById('race-hint'),
  restartInline: document.getElementById('restart-inline'),
  results: document.getElementById('results'),
  resultsTitle: document.getElementById('results-title'),
  resWpm: document.getElementById('res-wpm'),
  resAcc: document.getElementById('res-acc'),
  resRaw: document.getElementById('res-raw'),
  resChars: document.getElementById('res-chars'),
  resTime: document.getElementById('res-time'),
  resBest: document.getElementById('res-best'),
  raceResults: document.getElementById('race-results'),
  restartBtn: document.getElementById('restart-btn'),
  leaveBtn: document.getElementById('leave-btn'),
  historyList: document.getElementById('history-list'),
  historyEmpty: document.getElementById('history-empty'),
  announcer: document.getElementById('announcer'),
};

/* ---------- 3. Persistence (localStorage, always JSON, always guarded) ---------- */

function readStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const value = JSON.parse(raw);
    return value === null || value === undefined ? fallback : value;
  } catch {
    // Corrupted JSON, or storage blocked (e.g. some private modes).
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the app still works, it just won't remember.
  }
}

// isValidDuration and isValidRecord live in stats.js.

function loadHistory() {
  const history = readStorage(STORAGE_KEYS.history, []);
  return Array.isArray(history) ? history.filter(isValidRecord).slice(0, CONFIG.historySize) : [];
}

function loadBests() {
  const bests = readStorage(STORAGE_KEYS.best, {});
  return bests && typeof bests === 'object' && !Array.isArray(bests) ? bests : {};
}

function getBest(duration) {
  const best = loadBests()[duration];
  return isValidRecord(best) ? best : null;
}

function loadDuration() {
  const saved = readStorage(STORAGE_KEYS.duration, CONFIG.defaultDuration);
  return isValidDuration(saved) ? saved : CONFIG.defaultDuration;
}

function loadTheme() {
  const saved = readStorage(STORAGE_KEYS.theme, null);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Saves a finished test. Returns whether it beat the best for that duration. */
function saveResult(record) {
  // A record that would be filtered out on the next load (e.g. wpm > 1000 from
  // a scripted insert) is never stored, so the screen and storage agree.
  if (!isValidRecord(record)) {
    const best = getBest(record.duration);
    return { history: loadHistory(), isNewBest: false, previousBest: best, best };
  }

  const history = [record, ...loadHistory()].slice(0, CONFIG.historySize);
  writeStorage(STORAGE_KEYS.history, history);

  const bests = loadBests();
  const previous = isValidRecord(bests[record.duration]) ? bests[record.duration] : null;
  const isNewBest = record.wpm > 0 && (previous === null || record.wpm > previous.wpm);

  if (isNewBest) {
    bests[record.duration] = record;
    writeStorage(STORAGE_KEYS.best, bests);
  }

  return { history, isNewBest, previousBest: previous, best: isNewBest ? record : previous };
}

/* ---------- 4. Word generation ---------- */

// randomWords and generateChars live in stats.js; with no word list passed
// they fall back to the global WORDS from words.js.

/* ---------- 5. State ---------- */

/** Returns a brand-new state object. Restart = replace state with this. */
function createInitialState(duration) {
  const chars = generateChars(CONFIG.wordCount);
  return {
    mode: 'solo',                               // 'solo' | 'multi'
    phase: 'idle',                              // 'idle' | 'running' | 'finished'
    chars,                                      // expected characters
    index: 0,                                   // position of the next character to type
    results: new Array(chars.length).fill(null), // null | 'correct' | 'incorrect'
    wrongCount: 0,                              // 'incorrect' entries in results (O(1) finish check)
    duration,                                   // seconds
    timeLeft: duration,                         // seconds (may be fractional)
    startTime: null,                            // ms timestamp from performance.now()
    intervalId: null,                           // setInterval handle
    totalKeystrokes: 0,                         // every printable key typed
    correctKeystrokes: 0,                       // printable keys that matched
    mp: null,                                   // multiplayer data (createRaceState only)
  };
}

/**
 * Returns a new multiplayer state. `session` ({ playerId, room }) is carried
 * from race to race; everything else starts fresh. Before replacing `state`
 * with this, the caller clears the old interval and flush timer.
 */
function createRaceState(session, { passage = '', raceTimeLimitMs = 0 } = {}) {
  const chars = passage.split(''); // ASCII words, split exactly like the server's passage
  const duration = Math.ceil(raceTimeLimitMs / 1000);
  return {
    mode: 'multi',
    phase: 'connecting',         // 'connecting' | 'waiting' | 'countdown' | 'running' | 'finished'
    chars,
    index: 0,
    results: new Array(chars.length).fill(null),
    wrongCount: 0,
    totalKeystrokes: 0,
    correctKeystrokes: 0,
    duration,                    // race limit in whole seconds, for renderTimer
    timeLeft: duration,
    startTime: null,
    intervalId: null,
    mp: {
      session,
      countdownEndsAt: null,     // performance.now() based, display only
      countdownSeconds: 0,       // last "Race starts in N" shown, so it is written once per second
      raceTimeLimitMs,
      seq: 0,                    // last seq sent
      pendingKeys: '',
      flushTimerId: null,
      localDone: false,          // local text matches the whole passage
      progress: {},              // id -> latest ProgressEntry
      milestones: {},            // id -> last announced milestone
      departed: {},              // id -> true once "left the race" was announced
      results: null,             // ResultEntry[] from race:end
      rematchRequested: false,
      resultsStatus: '',         // text for #res-best in multi (rematch status)
      rematchDeadline: null,     // performance.now() when the server removes an idle player
      rematchWarned: false,      // the "20 seconds left" warning was given
      rematchWarnTimerId: null,
      connectDeadline: null,     // performance.now() by which the first connection must succeed
      waking: false,             // the "waking up the server" message is shown
    },
  };
}

// Preferences outlive a single test, so they are kept apart from `state`
// (createInitialState would otherwise wipe them on every restart).
const prefs = { theme: loadTheme() };

// Code of the multiplayer error shown in #mp-error, or null. Outside `state`
// for the same reason as `prefs`: leaving multiplayer calls restart(), which
// replaces `state`, and the message must survive that.
let mpErrorCode = null;

let state = createInitialState(loadDuration());

// One <span> per character, same order as state.chars. Lets us update a single
// character in O(1) instead of re-rendering the whole text.
let spans = [];

// Pixel height of one text line. A layout measurement, not app state.
let lineHeight = 0;

// Progress rows by player id ({ meta, fill, metaText, scale }), and the id list
// they were built for. DOM handles, like `spans`, so they live outside state.
let trackRows = new Map();
let trackKey = '';

/* ---------- 6. Stats ---------- */

// calculateWpm, calculateAccuracy and computeStats live in stats.js as pure
// functions, so they can be tested in Node without a DOM.

/* ---------- 7. Rendering (state -> DOM, write only) ---------- */

function createCharSpan(char) {
  const span = document.createElement('span');
  span.className = char === ' ' ? 'char space' : 'char';
  span.textContent = char;
  return span;
}

/** Appends spans for `chars` in one DOM operation via a DocumentFragment. */
function appendCharSpans(chars) {
  const fragment = document.createDocumentFragment();
  for (const char of chars) {
    const span = createCharSpan(char);
    spans.push(span);
    fragment.appendChild(span);
  }
  dom.words.appendChild(fragment);
}

/** Full rebuild. Only used when a new test starts. */
function renderText() {
  dom.words.replaceChildren();
  spans = [];
  appendCharSpans(state.chars);
  renderWordsText();
  measureLineHeight();
  renderCaret(null);
}

/**
 * Screen-reader copy of the text: one string instead of one span per char.
 * Only the next few untyped words, so the description stays short and is not
 * re-read from the first word every time focus returns to the input.
 * It is the input's aria-describedby, so it is NOT updated per keystroke
 * (that makes some screen readers re-read it after every key). It is written
 * on each new test and when the input loses focus, so it is current whenever
 * focus comes back.
 */
function renderWordsText() {
  dom.wordsText.textContent = state.chars
    .slice(state.index)
    .join('')
    .trimStart() // the caret may sit on a space
    .split(' ')
    .slice(0, state.mode === 'multi' ? CONFIG.raceDescribedWordCount : CONFIG.describedWordCount)
    .join(' ');
}

/** Updates ONE character span to match state.results[i]. */
function renderChar(i) {
  const span = spans[i];
  if (!span) return;
  const result = state.results[i];
  span.classList.toggle('correct', result === 'correct');
  span.classList.toggle('incorrect', result === 'incorrect');
}

function measureLineHeight() {
  const value = parseFloat(getComputedStyle(dom.words).lineHeight);
  lineHeight = Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Moves the `current` class from the previous span to the span at state.index,
 * then slides the floating caret onto it and scrolls the text if needed.
 */
function renderCaret(previousIndex) {
  if (previousIndex !== null && spans[previousIndex]) {
    spans[previousIndex].classList.remove('current');
  }
  const span = spans[state.index];
  if (span) {
    span.classList.add('current');
    positionCaret(span, false);
  } else if (state.index === spans.length && spans.length > 0) {
    // Past the last character of a finite race passage: the caret sits after
    // it, so the last character no longer looks pending.
    positionCaret(spans[spans.length - 1], true);
  }
}

/** `atEnd` puts the caret after `span` instead of before it. */
function positionCaret(span, atEnd) {
  if (dom.typingArea.hidden) return; // hidden elements have no layout

  // offsetLeft/offsetTop are relative to .words-track (the positioned parent).
  const x = span.offsetLeft + (atEnd ? span.offsetWidth : 0);
  const y = span.offsetTop;
  dom.caret.style.height = `${span.offsetHeight}px`;
  dom.caret.style.transform = `translate(${x}px, ${y}px)`;

  // Line scrolling: lines 0 and 1 show without scrolling. Once the caret
  // reaches line 2 (the third line), shift up so the caret's line is always
  // the middle one. Derived from the caret position, so Backspace onto an
  // earlier line scrolls back down automatically.
  if (lineHeight > 0) {
    const line = Math.round(y / lineHeight);
    const firstVisibleLine = Math.max(0, line - 1);
    dom.track.style.transform = `translateY(${-firstVisibleLine * lineHeight}px)`;
  }
}

/** Empties the text when a race has no passage yet (connecting, waiting). */
function clearText() {
  dom.words.replaceChildren();
  spans = [];
  dom.wordsText.textContent = '';
}

function renderPhase() {
  dom.body.dataset.phase = state.phase;
  const finished = state.phase === 'finished';
  dom.results.hidden = !finished;
  if (state.mode === 'multi') {
    // No passage before the countdown, so the text only shows once there is one.
    dom.typingArea.hidden = state.phase !== 'countdown' && state.phase !== 'running';
    dom.racePanel.hidden = finished;
  } else {
    dom.typingArea.hidden = finished;
    dom.racePanel.hidden = true;
    // renderRacePanel does not run in solo, so the spinner class is dropped here.
    dom.racePanel.classList.remove('is-connecting');
  }
}

/** Shows the controls of the current mode and hides the other mode's. */
function renderMode() {
  const multi = state.mode === 'multi';
  for (const button of dom.modeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode));
  }
  dom.settings.hidden = multi;
  dom.liveBestStat.hidden = multi;
  dom.restartInline.hidden = multi;
  dom.hint.hidden = multi;
  dom.raceHint.hidden = !multi;
  // aria-describedby still reads hidden elements, so point it at the right
  // hint. In a race, the passage only: focus moves here during the countdown
  // and a long description would delay "Go!". The race instructions are
  // spoken once instead, when the player starts waiting (onJoinAck).
  dom.input.setAttribute('aria-describedby', multi ? 'words-text' : 'typing-hint words-text');
  dom.typingArea.setAttribute('aria-label', multi ? 'Race passage' : 'Typing test. Start typing to begin.');
  dom.resultsTitle.textContent = multi ? 'Race results' : 'Results';
  dom.raceResults.hidden = !multi;
  dom.leaveBtn.hidden = !multi;
  if (multi) {
    renderRaceResultsStatus();
  } else {
    dom.restartBtn.textContent = 'Restart test';
    dom.restartBtn.removeAttribute('aria-disabled');
  }
}

function renderSettings() {
  for (const button of dom.settingButtons) {
    const isActive = Number(button.dataset.duration) === state.duration;
    button.setAttribute('aria-pressed', String(isActive));
  }
}

function renderTimer() {
  // Before a race there is no time limit yet, so show a placeholder, not "0".
  const noRace = state.mode === 'multi' && (state.phase === 'connecting' || state.phase === 'waiting');
  dom.timer.textContent = noRace ? '--' : String(Math.ceil(state.timeLeft));
}

function renderLiveStats(elapsedMs) {
  const stats = computeStats(state, Math.max(elapsedMs, CONFIG.minLiveElapsedMs));
  dom.liveWpm.textContent = String(stats.wpm);
  dom.liveAcc.textContent = state.totalKeystrokes === 0 ? '--' : `${stats.accuracy}%`;
}

/** `best` is loaded by the caller, so rendering never touches storage. */
function renderBest(best) {
  dom.liveBest.textContent = best ? String(best.wpm) : '--';
}

function renderResults(stats, saved) {
  dom.resWpm.textContent = String(stats.wpm);
  dom.resAcc.textContent = `${stats.accuracy}%`;
  dom.resRaw.textContent = String(stats.rawWpm);
  dom.resChars.textContent = `${stats.correctChars} / ${stats.incorrectChars}`;
  dom.resTime.textContent = `${stats.duration}s`;

  dom.resBest.classList.toggle('is-new', saved.isNewBest);
  if (saved.isNewBest) {
    dom.resBest.textContent = saved.previousBest
      ? `New personal best for ${stats.duration}s! (previous: ${saved.previousBest.wpm} wpm)`
      : `New personal best for ${stats.duration}s!`;
  } else if (saved.best) {
    dom.resBest.textContent = `Personal best for ${stats.duration}s: ${saved.best.wpm} wpm`;
  } else {
    dom.resBest.textContent = '';
  }
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function renderHistory(history) {
  dom.historyEmpty.hidden = history.length > 0;
  const fragment = document.createDocumentFragment();

  for (const record of history) {
    const item = document.createElement('li');
    item.className = 'history-item';

    const cells = [
      ['history-wpm', `${record.wpm} wpm`],
      ['history-acc', `${record.accuracy}%`],
      ['history-time', `${record.duration}s`],
      ['history-date', formatDate(record.date)],
    ];
    for (const [className, text] of cells) {
      const cell = document.createElement('span');
      cell.className = className;
      cell.textContent = text; // textContent, never innerHTML, for stored data
      item.appendChild(cell);
    }
    fragment.appendChild(item);
  }

  dom.historyList.replaceChildren(fragment);
}

function announce(message) {
  dom.announcer.textContent = message;
}

function applyTheme(theme) {
  dom.root.dataset.theme = theme;
  const next = theme === 'dark' ? 'light' : 'dark';
  dom.themeToggle.setAttribute('aria-label', `Switch to ${next} theme`);
}

/** Brings the whole screen in line with the current state (used on restart). */
function renderAll(best) {
  renderPhase();      // must run first: the text must be visible to be measured
  renderMode();
  renderSettings();
  renderTimer();
  renderLiveStats(0);
  if (state.mode === 'multi') {
    renderRacePanel();
    renderRaceTracks();
    if (state.chars.length > 0) renderText();
    else clearText();
  } else {
    renderBest(best);
    renderText();
  }
}

/** Shown instead of the text when words.js failed to load. */
function renderLoadError() {
  dom.words.replaceChildren();
  dom.words.setAttribute('aria-hidden', 'true');
  // Unhide before writing, so the alert region is rendered when its text
  // changes and screen readers announce it. It sits outside the clipped
  // .words-viewport, so the whole message is always visible.
  dom.loadError.hidden = false;
  dom.loadError.textContent = 'The word list could not be loaded. Please reload the page.';
  dom.hint.hidden = true; // "Start typing" would be wrong here
  dom.typingArea.setAttribute('aria-label', 'Typing test unavailable');
  for (const button of dom.settingButtons) {
    button.disabled = true;
    // A disabled button has no pressed look, so don't expose it as pressed.
    button.removeAttribute('aria-pressed');
  }
  dom.input.disabled = true;
  dom.restartInline.hidden = true;
  dom.mode.hidden = true; // the page is broken; don't offer a mode that relies on it
}

/** The mode switch, only when multiplayer can work from this page (MP_ENABLED). */
function renderModeAvailability() {
  dom.mode.hidden = !MP_ENABLED;
}

function renderMpError() {
  // Unhide before writing so the alert is announced, and clear on hide so the
  // same message shown again later is a change the screen reader speaks.
  if (mpErrorCode === null) {
    dom.mpError.hidden = true;
    dom.mpError.textContent = '';
    return;
  }
  dom.mpError.hidden = false;
  dom.mpError.textContent = errorMessage(mpErrorCode);
}

/* ---------- 8. Timer ---------- */

// Handles for deferred announcements. Kept outside `state` because restart()
// replaces `state` and must still be able to cancel them.
let resultAnnounceTimer = 0;
// The text announceSoon is waiting to speak, so setResultsStatus can join it.
let pendingAnnouncement = '';
let restartAnnounceFrame = 0;

function cancelResultAnnouncement() {
  clearTimeout(resultAnnounceTimer);
  resultAnnounceTimer = 0;
  pendingAnnouncement = '';
}

function stopTimer() {
  if (state.intervalId !== null) {
    clearInterval(state.intervalId);
    state.intervalId = null;
  }
}

function startTest() {
  stopTimer(); // guard: never allow two intervals (the "double speed timer" bug)
  state.phase = 'running';
  // performance.now() is monotonic: unlike Date.now() it never jumps when the
  // system clock changes mid-test.
  state.startTime = performance.now();
  state.intervalId = setInterval(tick, CONFIG.tickMs);
  // An old connection error no longer applies once typing starts.
  if (mpErrorCode !== null) {
    mpErrorCode = null;
    renderMpError();
  }
  renderPhase();
}

function getElapsedMs() {
  return performance.now() - state.startTime;
}

/** True once the clock has run out, even if the next tick has not fired yet. */
function isTimeUp() {
  return state.phase === 'running' && getElapsedMs() >= state.duration * 1000;
}

function tick() {
  if (state.mode === 'multi') {
    tickRace();
    return;
  }
  if (state.phase !== 'running') return;

  // Real elapsed time from the clock. Interval ticks drift and get throttled
  // in background tabs, so they are never counted.
  const elapsedMs = getElapsedMs();
  state.timeLeft = Math.max(0, state.duration - elapsedMs / 1000);

  if (state.timeLeft === 0) {
    finishTest();
    return;
  }

  renderTimer();
  renderLiveStats(elapsedMs);
}

/**
 * Multiplayer tick: display only. The server owns the start, the time limit
 * and the results, so reaching 0 here never ends the race (race:end does).
 */
function tickRace() {
  const now = performance.now();

  if (state.phase === 'countdown') {
    const seconds = Math.max(0, Math.ceil((state.mp.countdownEndsAt - now) / 1000));
    if (seconds !== state.mp.countdownSeconds) {
      state.mp.countdownSeconds = seconds;
      renderRacePanel();
    }
    return;
  }
  if (state.phase !== 'running') return;

  const elapsedMs = now - state.startTime;
  // From the exact limit in ms, as isRaceTimeUp is, so the display reaches 0
  // when typing locks even for a limit that is not whole seconds.
  state.timeLeft = Math.max(0, (state.mp.raceTimeLimitMs - elapsedMs) / 1000);
  renderTimer();
  // After finishing, keep the last local estimate instead of letting it decay.
  if (!state.mp.localDone) renderLiveStats(elapsedMs);
  if (state.timeLeft === 0) {
    stopTimer(); // so this branch runs once
    renderRacePanel(); // "Time is up" while race:end is on its way
    if (!state.mp.localDone) announce('Time is up. Waiting for the results.');
  }
}

/** True once the local race clock has passed the server's time limit. */
function isRaceTimeUp() {
  return state.startTime !== null && getElapsedMs() >= state.mp.raceTimeLimitMs;
}

function finishTest() {
  stopTimer();
  state.phase = 'finished';
  state.timeLeft = 0;

  // The test always lasts exactly `duration` seconds.
  const stats = computeStats(state, state.duration * 1000);
  const saved = saveResult({
    wpm: stats.wpm,
    rawWpm: stats.rawWpm,
    accuracy: stats.accuracy,
    duration: stats.duration,
    date: Date.now(),
  });

  renderTimer();
  renderLiveStats(state.duration * 1000);
  renderPhase();
  renderResults(stats, saved);
  renderHistory(saved.history);
  renderBest(saved.best);

  // Focus the heading, not the restart button: a stray Space would otherwise
  // throw the results away before they have been read.
  dom.resultsTitle.focus();

  // Announce after the focus move: some screen readers (NVDA) cut off speech
  // that started before focus changed.
  const message =
    `Test complete. ${stats.wpm} words per minute, ${stats.accuracy} percent accuracy.` +
    (saved.isNewBest ? ' New personal best!' : '');
  cancelResultAnnouncement();
  resultAnnounceTimer = setTimeout(() => {
    resultAnnounceTimer = 0;
    if (state.phase === 'finished') announce(message); // not if already restarted
  }, CONFIG.resultAnnounceDelayMs);
}

/**
 * Starts a fresh test. `moveFocus` is false when a keyboard user picks a
 * duration, so their focus (and the pressed state they hear) stays put.
 */
function restart(duration = state.duration, {
  message = `New test ready, ${duration} seconds.`,
  moveFocus = true,
} = {}) {
  stopTimer();
  cancelResultAnnouncement();
  state = createInitialState(duration);
  writeStorage(STORAGE_KEYS.duration, duration);
  announce('');
  renderAll(getBest(duration));
  if (moveFocus) focusInput();

  // Escape restarts with focus already on the input, so no focus event tells
  // screen-reader users anything happened. Writing on the next frame, after
  // the clear above, makes the same message twice in a row be read again.
  cancelAnimationFrame(restartAnnounceFrame);
  restartAnnounceFrame = requestAnimationFrame(() => {
    restartAnnounceFrame = 0;
    announce(message);
  });
}

/* ---------- 9. Core typing logic ---------- */

/** Sets results[i], keeping wrongCount in step so the finish check is O(1). */
function setResult(i, value) {
  if (state.results[i] === 'incorrect') state.wrongCount -= 1;
  if (value === 'incorrect') state.wrongCount += 1;
  state.results[i] = value;
}

/**
 * Typing is unlocked only by race:start, and locked again once the passage
 * is done or the local clock passes the limit (the server ends the race).
 */
function canTypeInRace() {
  return state.phase === 'running' && !state.mp.localDone && !isRaceTimeUp();
}

function handleCharacter(key) {
  if (state.phase === 'finished') return;
  if (state.mode === 'multi') {
    // The passage is finite, and keys the server would reject are never applied,
    // so the screen and the server always see the same keystrokes.
    if (!canTypeInRace() || state.index >= state.chars.length || !isSendableKey(key)) return;
  } else {
    // Keys pressed after time ran out (before the next tick) must not count.
    if (isTimeUp()) {
      finishTest();
      return;
    }
    if (state.phase === 'idle') startTest();
  }

  const i = state.index;
  const isCorrect = key === state.chars[i];

  setResult(i, isCorrect ? 'correct' : 'incorrect');
  state.totalKeystrokes += 1;
  if (isCorrect) state.correctKeystrokes += 1;
  state.index += 1;

  if (state.mode === 'multi') {
    queueKey(key);
    // Finishing needs every character correct, as on the server.
    if (state.index === state.chars.length && state.wrongCount === 0) finishRaceLocally();
  } else {
    extendTextIfNeeded();
  }
  renderChar(i);
  renderCaret(i);
}

function handleBackspace() {
  if (state.mode === 'multi') {
    if (!canTypeInRace() || state.index === 0) return;
  } else {
    if (isTimeUp()) {
      finishTest();
      return;
    }
    if (state.phase !== 'running' || state.index === 0) return;
  }

  const previousIndex = state.index;
  state.index -= 1;
  setResult(state.index, null);
  // Keystroke counters are NOT decreased: a mistake still counts against accuracy.

  // Only a Backspace that really deleted something is sent (see PROTOCOL.md).
  if (state.mode === 'multi') queueKey(MP_CONSTANTS.backspace);
  renderChar(state.index);
  renderCaret(previousIndex);
}

/** Infinite text: append more words when the caret gets close to the end. */
function extendTextIfNeeded() {
  if (state.chars.length - state.index > CONFIG.extendThreshold) return;

  const words = generateChars(CONFIG.extendWordCount);
  if (words.length === 0) return; // no word list: never append a lone space

  const more = [' ', ...words];
  state.chars.push(...more);
  state.results.push(...new Array(more.length).fill(null));
  appendCharSpans(more);
}

/* ---------- 10. Input handling ---------- */

function isInteractiveTarget(target) {
  return target instanceof Element && target !== dom.input &&
    target.closest('button, a, input, select, textarea') !== null;
}

function handleKeydown(event) {
  // Escape restarts, but only from the typing input. Tab is never captured, so
  // keyboard users can always move focus (WCAG 2.1.1).
  if (event.key === 'Escape' && event.target === dom.input) {
    // In a race, Escape does nothing: one stray key must not leave the room.
    if (state.mode === 'multi') return;
    event.preventDefault();
    restart();
    return;
  }

  // Shortcuts like Ctrl+R, Cmd+C or Alt+F (Windows menus) must keep working and
  // never count as typing. AltGr is reported as Ctrl+Alt on Windows, but it
  // types real characters (e.g. @ or € on many layouts), so it is let through.
  if (event.metaKey ||
      ((event.ctrlKey || event.altKey) && !event.getModifierState('AltGraph'))) return;

  // IME composition / Android soft keyboards report 'Unidentified' or 'Process'.
  // Those are handled by the `input` event in handleMobileInput instead.
  if (event.isComposing || event.key === 'Unidentified' || event.key === 'Process') return;

  // Printable characters have a one-character key. Shift, CapsLock, Alt,
  // arrows, F1-F12, Escape, Enter... all have longer names.
  const isPrintable = event.key.length === 1;
  const inputHasFocus = document.activeElement === dom.input;

  // Mid-test, typed keys (Space included) always go to the test, even if focus
  // has wandered to a button: otherwise a space would click it and restart.
  if (state.phase === 'running' && isPrintable && !inputHasFocus) {
    event.preventDefault();
    focusInput();
    handleCharacter(event.key);
    return;
  }

  // Outside a test, let Space/Enter activate a focused button instead of typing.
  if (isInteractiveTarget(event.target) && (event.key === ' ' || event.key === 'Enter')) return;

  // Space would scroll the page, even after the test finishes.
  if (event.key === ' ') event.preventDefault();

  if (state.phase === 'finished') return;

  if (event.key === 'Backspace') {
    event.preventDefault();
    handleBackspace();
    return;
  }

  if (!isPrintable) return;

  // preventDefault also stops the hidden input receiving the character, so the
  // `input` event never fires for it and the key is never counted twice.
  event.preventDefault();
  if (!inputHasFocus) focusInput();
  handleCharacter(event.key);
}

/* Mobile: soft keyboards don't send reliable keydown events, so we read what
   landed in the hidden input, process it, and reset the input every time. */
function resetInput() {
  dom.input.value = INPUT_SENTINEL;
  try {
    dom.input.setSelectionRange(INPUT_SENTINEL.length, INPUT_SENTINEL.length);
  } catch {
    // Some browsers refuse selection changes on unfocused inputs.
  }
}

function handleMobileInput(event) {
  // Pasted or dropped text is not typing: it would inflate WPM, and scoring a
  // long paste one char at a time freezes the page.
  if (event.inputType === 'insertFromPaste' || event.inputType === 'insertFromDrop') {
    resetInput();
    return;
  }

  const value = dom.input.value;
  const deleted =
    (typeof event.inputType === 'string' && event.inputType.startsWith('delete')) ||
    value.length < INPUT_SENTINEL.length;

  if (deleted) {
    handleBackspace();
  } else {
    const typed = value.replace(INPUT_SENTINEL, '');
    for (const char of typed) handleCharacter(char);
  }

  resetInput();
}

function focusInput() {
  resetInput();
  dom.input.focus({ preventScroll: true });
}

/**
 * A tap on the passage. iOS opens the keyboard only for a focus() inside a
 * tap, and ignores focus() on an element that already has focus (e.g. focused
 * by the race countdown), so blur first. Only here, not in focusInput: a
 * blur and refocus makes screen readers read the input again, which would
 * talk over the Escape restart message. Blur and focus run in the same task,
 * so the focus ring and caret never repaint in between.
 */
function handleTypingAreaClick(event) {
  // The restart button sits inside the typing area and focuses the input
  // itself; refocusing here too would make the input be read twice.
  if (isInteractiveTarget(event.target)) return;
  if (document.activeElement === dom.input) dom.input.blur();
  focusInput();
}

function handleSettingsClick(event) {
  const button = event.target.closest('[data-duration]');
  if (!button || !dom.settings.contains(button)) return;

  const duration = Number(button.dataset.duration);
  if (!isValidDuration(duration)) return;
  restart(duration, {
    message: `Duration set to ${duration} seconds. New test ready.`,
    // Mouse clicks (detail > 0) hand focus to the test. Keyboard users stay on
    // the button so they hear its pressed state; typing still reaches the test
    // through the idle redirect in handleKeydown.
    moveFocus: event.detail > 0,
  });
}

/** One button, two jobs: "Race again" in multiplayer, "Restart test" in solo. */
function handleRestartClick() {
  if (state.mode === 'multi') requestRematch();
  else restart();
}

function toggleTheme() {
  prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark';
  writeStorage(STORAGE_KEYS.theme, prefs.theme);
  applyTheme(prefs.theme);
}

let resizeFrame = 0;
function handleResize() {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    measureLineHeight();
    renderCaret(null);
  });
}

/* ---------- 11. Start up ---------- */

function blockDefault(event) {
  event.preventDefault();
}

function init() {
  applyTheme(prefs.theme);

  dom.themeToggle.addEventListener('click', (event) => {
    toggleTheme();
    // Mouse click (detail > 0): hand focus back to the test so the next Space
    // types instead of toggling again. Keyboard users keep focus on the button.
    if (event.detail > 0 && !dom.input.disabled) focusInput();
  });

  renderAll(getBest(state.duration));
  renderHistory(loadHistory());

  // words.js failed to load: say so, and leave typing switched off rather
  // than run a test with no text.
  if (state.chars.length === 0) {
    renderLoadError();
    return;
  }

  document.addEventListener('keydown', handleKeydown);
  dom.input.addEventListener('input', handleMobileInput);
  // Pasted text is not typing (see handleMobileInput); block it at the source.
  dom.input.addEventListener('paste', blockDefault);
  dom.input.addEventListener('drop', blockDefault);
  // Refresh the input's description (see renderWordsText) while focus is away.
  dom.input.addEventListener('blur', renderWordsText);
  dom.typingArea.addEventListener('click', handleTypingAreaClick);
  dom.settings.addEventListener('click', handleSettingsClick); // event delegation
  dom.restartBtn.addEventListener('click', handleRestartClick);
  dom.restartInline.addEventListener('click', () => restart());
  window.addEventListener('resize', handleResize);

  // The group starts hidden in the HTML, so a broken script never leaves dead
  // buttons on screen.
  renderModeAvailability();
  if (MP_ENABLED) {
    dom.mode.addEventListener('click', handleModeClick); // event delegation
    dom.leaveBtn.addEventListener('click', () => leaveMultiplayer());
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }

  focusInput();

  // Web fonts can change character widths after load; re-measure once ready.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(handleResize);
  }
}

/* ---------- 12. Multiplayer ---------- */

// Every Socket.io event is emitted or received in this section only. Incoming
// events are validated (multiplayer.js), update `state`, then render. Strings
// from the server are never rendered: the client builds every label itself.

// The socket and the script loader are handles, not data, so they live
// outside `state` (like the announce timers in section 8).
let mpSocket = null;
let socketIoPromise = null;
// The pending Socket.io script attempt, and the pause before the next one.
let socketIoScript = null;
let socketIoRetryTimer = 0;
let socketIoAttemptTimer = 0;
// Cancels the pending load: set while socketIoPromise is pending, else null.
let socketIoCancel = null;
// The waking notice, and the pause before retrying a failed socket connect.
let wakeNoticeTimer = 0;
let connectRetryTimer = 0;
// Exit code for the disconnect the server announced with game:error just
// before closing the socket (IDLE_TIMEOUT); null means an unexpected drop.
let mpDisconnectCode = null;

/* 12.1 Helpers */

function isCurrentSocket(socket) {
  // Events from a socket that leaveMultiplayer is tearing down are ignored.
  return state.mode === 'multi' && socket === mpSocket;
}

function getSelfId() {
  return state.mp.session.playerId;
}

function getRoomPlayers() {
  const room = state.mp.session.room;
  return room ? room.players : [];
}

function clearFlushTimer() {
  if (state.mp && state.mp.flushTimerId !== null) {
    clearTimeout(state.mp.flushTimerId);
    state.mp.flushTimerId = null;
  }
}

function clearRematchWarnTimer() {
  if (state.mp && state.mp.rematchWarnTimerId !== null) {
    clearTimeout(state.mp.rematchWarnTimerId);
    state.mp.rematchWarnTimerId = null;
  }
}

/** Clears the timers of the first connection (waking notice, connect retry). */
function clearConnectTimers() {
  clearTimeout(wakeNoticeTimer);
  wakeNoticeTimer = 0;
  clearTimeout(connectRetryTimer);
  connectRetryTimer = 0;
}

/** Clears every timer the current race state owns, before `state` is replaced. */
function stopRaceTimers() {
  stopTimer();
  clearFlushTimer();
  clearRematchWarnTimer();
  clearConnectTimers();
}

function isFocusIn(element) {
  return element.contains(document.activeElement);
}

/**
 * Announces once a focus move has settled (NVDA cuts off speech that started
 * before focus changed). Dropped if `state` was replaced in the meantime, so a
 * stale message is never read. Shares the timer that restart() cancels.
 * `onSpoken`, if given, runs only when the message is actually written.
 */
function announceSoon(message, onSpoken) {
  const expected = state;
  cancelResultAnnouncement();
  pendingAnnouncement = message;
  resultAnnounceTimer = setTimeout(() => {
    resultAnnounceTimer = 0;
    pendingAnnouncement = '';
    if (state !== expected) return;
    announce(message);
    if (onSpoken) onSpoken();
  }, CONFIG.resultAnnounceDelayMs);
}

/** "Opponent" reads better as "Your opponent" at the start of a sentence. */
function opponentSubject(label) {
  return label === 'Opponent' ? 'Your opponent' : label;
}

// Shown (and announced once) when the first connection to a remote server is
// still pending after MP_CONSTANTS.wakeNoticeDelayMs: the server is asleep.
// #race-hint is hidden while connecting, so these say how to cancel themselves.
const WAKE_STATUS = 'Waking up the game server, this can take up to a minute… Choose Solo to cancel.';
const WAKE_ANNOUNCEMENT = 'Waking up the game server, this can take up to a minute. Choose Solo to cancel.';

// Shown while the server moves a ready player with no opponent to 'waiting'.
// Never announced: enterWaiting says "Waiting for a new opponent." right after.
const STATUS_WAITING_NEW_OPPONENT = 'Waiting for a new opponent…';

/** Results-card status line, from the room snapshot after a race. */
function rematchStatus(room) {
  const selfId = getSelfId();
  const self = room.players.find((player) => player.id === selfId);
  const opponents = room.players.filter((player) => player.id !== selfId);
  const selfReady = Boolean(self && self.ready);

  if (opponents.length === 0) {
    return selfReady
      ? STATUS_WAITING_NEW_OPPONENT
      : 'Your opponent left. Press Race again to wait for a new one.';
  }
  if (selfReady) return 'Waiting for your opponent to race again.';
  // Without results (race:end was lost) it is unknown who raced, so skip this.
  const raced = state.mp.results;
  if (raced && opponents.some((player) => !raced.some((entry) => entry.id === player.id))) {
    return 'A new opponent joined. Press Race again to start.';
  }
  if (opponents.some((player) => player.ready)) return 'Your opponent wants a rematch.';
  return '';
}

/* 12.2 Race rendering (state -> DOM, write only) */

function raceStatusText() {
  const mp = state.mp;
  switch (state.phase) {
    case 'connecting':
      return mp.waking ? WAKE_STATUS : 'Connecting to the multiplayer server…';
    case 'waiting': {
      const hasOpponent = getRoomPlayers().some((player) => player.id !== getSelfId());
      return hasOpponent ? 'Waiting for your opponent to be ready…' : 'Waiting for an opponent…';
    }
    case 'countdown':
      return mp.countdownSeconds > 0 ? `Race starts in ${mp.countdownSeconds}` : 'Get ready…';
    case 'running': {
      const own = mp.progress[getSelfId()];
      if (own && own.finished && own.place !== null) {
        return `You finished ${ordinal(own.place)}. Waiting for the race to end.`;
      }
      if (mp.localDone) return 'You finished. Waiting for the race to end.';
      if (state.timeLeft === 0) return 'Time is up. Waiting for the results…';
      return 'Go!';
    }
    default:
      return '';
  }
}

function renderRacePanel() {
  dom.raceStatus.textContent = raceStatusText();
  // Decorative spinner (CSS ::after) so the long wake-up wait visibly is not stuck.
  dom.racePanel.classList.toggle('is-connecting', state.phase === 'connecting');
}

function trackMetaText(player) {
  if (!player.connected) return 'left the race';
  const entry = state.mp.progress[player.id];
  if (!entry) return '0% · 0 wpm';
  if (entry.finished && entry.place !== null) return `finished ${ordinal(entry.place)} · ${entry.wpm} wpm`;
  return `${entry.progress}% · ${entry.wpm} wpm`;
}

function trackScale(player) {
  const entry = state.mp.progress[player.id];
  return entry ? entry.progress / 100 : 0;
}

/** Rebuilds the rows. Only when the set of players changes, since labels depend on it. */
function buildRaceTracks(players) {
  const selfId = getSelfId();
  const fragment = document.createDocumentFragment();
  trackRows = new Map();

  for (const player of players) {
    const item = document.createElement('li');
    item.className = player.id === selfId ? 'race-track race-track--self' : 'race-track';

    const name = document.createElement('span');
    name.className = 'race-name';
    name.textContent = labelFor(player.id, selfId, players);

    // Keeps "You" and "45%" apart when a screen reader reads the row as one line.
    const separator = document.createElement('span');
    separator.className = 'visually-hidden';
    separator.textContent = ': ';

    const meta = document.createElement('span');
    meta.className = 'race-meta';

    // Decoration only: the same numbers are in the row text.
    const bar = document.createElement('div');
    bar.className = 'race-bar';
    bar.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('div');
    fill.className = 'race-bar-fill';
    bar.appendChild(fill);

    item.append(name, separator, meta, bar);
    fragment.appendChild(item);
    trackRows.set(player.id, { meta, fill, metaText: null, scale: null });
  }

  dom.raceTracks.replaceChildren(fragment);
}

/** Updates text and bar width in place; writes only what changed. */
function renderRaceTracks() {
  const players = getRoomPlayers();
  // An empty "Live progress" list (while connecting) is noise for screen readers.
  dom.raceTracks.hidden = players.length === 0;
  const key = JSON.stringify([getSelfId(), ...players.map((player) => player.id)]);
  if (key !== trackKey) {
    buildRaceTracks(players);
    trackKey = key;
  }

  for (const player of players) {
    const row = trackRows.get(player.id);
    const text = trackMetaText(player);
    if (text !== row.metaText) {
      row.meta.textContent = text;
      row.metaText = text;
    }
    const scale = trackScale(player);
    if (scale !== row.scale) {
      row.fill.style.transform = `scaleX(${scale})`; // transform, so no layout
      row.scale = scale;
    }
  }
}

function raceResultText(entry, results) {
  const label = labelFor(entry.id, getSelfId(), results);
  let ending = formatRaceTime(entry.timeMs);
  if (entry.status === 'unfinished') ending = 'did not finish';
  else if (entry.status === 'left') ending = 'left the race';
  // A no-break space keeps the number with its unit when the line wraps.
  return `${ordinal(entry.place)} · ${label} · ${entry.wpm}\u00a0wpm · ${entry.accuracy}% · ${ending}`;
}

/** The server's numbers: own entry in the result grid, everyone in the list. */
function renderRaceResults() {
  const results = state.mp.results || [];
  const own = results.find((entry) => entry.id === getSelfId());

  dom.resWpm.textContent = own ? String(own.wpm) : '--';
  dom.resAcc.textContent = own ? `${own.accuracy}%` : '--';
  dom.resRaw.textContent = own ? String(own.rawWpm) : '--';
  dom.resChars.textContent = own ? `${own.correctChars} / ${own.incorrectChars}` : '--';
  dom.resTime.textContent = own ? formatRaceTime(own.timeMs) : '--';

  const fragment = document.createDocumentFragment();
  for (const entry of results) {
    const item = document.createElement('li');
    item.className = entry.id === getSelfId() ? 'race-result race-result--self' : 'race-result';
    item.textContent = raceResultText(entry, results);
    fragment.appendChild(item);
  }
  dom.raceResults.replaceChildren(fragment);
}

// Built on call, not at load: MP_CONSTANTS lives in multiplayer.js, and a
// load-time read would throw and stop solo if that file failed to load.
function rematchNotice() {
  const seconds = Math.round(MP_CONSTANTS.rematchTimeoutMs / 1000);
  return `Press Race again within ${seconds} seconds to stay in the room.`;
}

function rematchWarning() {
  const seconds = Math.round(MP_CONSTANTS.rematchWarningMs / 1000);
  return `${seconds} seconds left to press Race again, or you will go back to solo.`;
}

/**
 * The time limit after a race. Shown, not announced with the status, so
 * speech stays short; the warning is announced on its own. Hidden once the
 * player has pressed Race again.
 */
function rematchNoticeText() {
  const mp = state.mp;
  // No deadline: the server has no idle timer running for us (see onRoomState).
  if (state.phase !== 'finished' || mp.rematchRequested || mp.rematchDeadline === null) return '';
  return mp.rematchWarned ? rematchWarning() : rematchNotice();
}

/**
 * Rematch status line and button. aria-disabled, not `disabled`: a disabled
 * button drops keyboard focus to <body>; this one keeps it and ignores clicks.
 */
function renderRaceResultsStatus() {
  const mp = state.mp;
  dom.resBest.classList.remove('is-new');
  dom.resBest.textContent = [mp.resultsStatus, rematchNoticeText()].filter(Boolean).join(' ');
  dom.restartBtn.textContent = mp.rematchRequested ? 'Waiting for opponent…' : 'Race again';
  if (mp.rematchRequested) dom.restartBtn.setAttribute('aria-disabled', 'true');
  else dom.restartBtn.removeAttribute('aria-disabled');
}

/* 12.3 Connecting */

function startMultiplayer() {
  if (state.mode === 'multi' || !MP_ENABLED) return;
  clearConnectTimers();
  stopTimer();
  cancelResultAnnouncement();
  cancelAnimationFrame(restartAnnounceFrame);
  restartAnnounceFrame = 0;
  mpErrorCode = null;
  mpDisconnectCode = null;

  // instructionsSpoken: the "fix every mistake" rule was read out this session.
  state = createRaceState({ playerId: null, room: null, instructionsSpoken: false });
  const mp = state.mp;
  // A timestamp, so throttled timers in a hidden tab never extend the budget.
  mp.connectDeadline = performance.now() + connectBudgetMs(CONFIG.serverUrl);
  renderMpError();
  renderAll();
  announce('Connecting to the multiplayer server.');
  // A local server never sleeps, so only a remote one gets the waking notice.
  if (!isLoopbackUrl(CONFIG.serverUrl)) {
    wakeNoticeTimer = setTimeout(() => showWakeNotice(mp), MP_CONSTANTS.wakeNoticeDelayMs);
  }
  // The `state.mp === mp` checks drop a result that arrives after Solo (or a
  // new Multiplayer press) replaced this session.
  loadSocketIo(CONFIG.serverUrl, mp.connectDeadline).then(
    (ioFactory) => { if (state.mp === mp) connectSocket(ioFactory); },
    () => { if (state.mp === mp) handleSocketIoLoadFailure(); },
  );
}

/**
 * Shows (once) that the server is probably asleep. Announced once too: there
 * is no countdown and nothing per retry, so speech stays quiet while waiting.
 */
function showWakeNotice(mp) {
  wakeNoticeTimer = 0;
  if (state.mp !== mp || state.phase !== 'connecting') return;
  mp.waking = true;
  renderRacePanel();
  announce(WAKE_ANNOUNCEMENT);
}

/**
 * Loads the Socket.io client from the game server itself (the one allowed
 * outside script), once per page. Failed attempts are retried until
 * `deadline` (a performance.now() timestamp), because a waking host may
 * answer with an error page first. Giving up resets the cache so the next
 * Multiplayer press starts again.
 */
function loadSocketIo(serverUrl, deadline) {
  if (socketIoPromise !== null) return socketIoPromise;

  socketIoPromise = new Promise((resolve, reject) => {
    // A script that finished loading after an earlier timeout already defined io.
    if (typeof window.io === 'function') {
      resolve(window.io);
      return;
    }

    function clearAttemptTimers() {
      clearTimeout(socketIoAttemptTimer);
      socketIoAttemptTimer = 0;
      clearTimeout(socketIoRetryTimer);
      socketIoRetryTimer = 0;
    }

    function removeScript() {
      if (socketIoScript === null) return;
      socketIoScript.onload = null;
      socketIoScript.onerror = null;
      socketIoScript.remove();
      socketIoScript = null;
    }

    function succeed() {
      clearAttemptTimers();
      if (socketIoScript !== null) {
        // The loaded script stays in the page; only the handlers go.
        socketIoScript.onload = null;
        socketIoScript.onerror = null;
        socketIoScript = null;
      }
      socketIoCancel = null;
      resolve(window.io);
    }

    function giveUp() {
      clearAttemptTimers();
      removeScript();
      socketIoCancel = null;
      socketIoPromise = null;
      reject(new Error('Socket.io client could not be loaded'));
    }

    function failAttempt() {
      clearAttemptTimers();
      removeScript();
      // A removed script can still run if its download finished meanwhile.
      if (typeof window.io === 'function') {
        succeed();
        return;
      }
      const delay = retryDelayWithin(performance.now(), deadline, MP_CONSTANTS.wakeRetryDelayMs);
      if (delay === null) {
        giveUp();
        return;
      }
      socketIoRetryTimer = setTimeout(attempt, delay);
    }

    function attempt() {
      socketIoRetryTimer = 0;
      const script = document.createElement('script');
      socketIoScript = script;
      script.onload = () => {
        if (typeof window.io === 'function') succeed();
        else failAttempt(); // e.g. the host's error page instead of the script
      };
      script.onerror = failAttempt;
      socketIoAttemptTimer = setTimeout(failAttempt, Math.max(1000, deadline - performance.now()));
      script.src = `${serverUrl}/socket.io/socket.io.js`;
      document.head.appendChild(script);
    }

    socketIoCancel = giveUp;
    attempt();
  });

  return socketIoPromise;
}

/**
 * Stops a pending script load (Solo pressed while waking), so no retry runs
 * later and the next Multiplayer press starts a fresh load. A loaded script
 * stays cached. The pending promise rejects; startMultiplayer ignores it.
 */
function cancelSocketIoLoad() {
  if (socketIoCancel !== null) socketIoCancel();
}

function handleSocketIoLoadFailure() {
  // Ignored if the user went back to solo meanwhile, or another attempt connected.
  if (state.mode === 'multi' && state.phase === 'connecting' && mpSocket === null) {
    leaveMultiplayer('UNREACHABLE');
  }
}

function connectSocket(ioFactory) {
  // The user may have gone back to solo (or pressed Multiplayer again) while
  // the script was loading.
  if (state.mode !== 'multi' || state.phase !== 'connecting' || mpSocket !== null) return;

  let socket;
  try {
    socket = ioFactory(CONFIG.serverUrl, {
      transports: ['websocket'],
      reconnection: false,
      // Whatever is left of the budget; a timeout ends in connect_error.
      timeout: Math.max(1000, state.mp.connectDeadline - performance.now()),
      // A fresh connection per session, never a cached manager from a closed one.
      forceNew: true,
    });
  } catch {
    leaveMultiplayer('UNREACHABLE');
    return;
  }

  mpSocket = socket;
  socket.on('connect', () => onConnect(socket));
  socket.on('connect_error', () => onConnectError(socket, ioFactory));
  socket.on('disconnect', () => onDisconnect(socket));
  for (const [event, handler] of Object.entries(SERVER_EVENT_HANDLERS)) {
    socket.on(event, (data) => {
      if (isCurrentSocket(socket)) handler(data);
    });
  }
}

function onConnect(socket) {
  if (!isCurrentSocket(socket)) return;
  // The server is awake once the socket connects, so the waking notice must not
  // appear while the join ack is still on its way.
  clearTimeout(wakeNoticeTimer);
  wakeNoticeTimer = 0;
  // With a timeout, a server that never answers still ends in a clear message.
  socket.timeout(MP_CONSTANTS.joinAckTimeoutMs).emit('room:join', {}, (error, ack) => {
    if (!isCurrentSocket(socket)) return;
    if (error) {
      leaveMultiplayer('UNREACHABLE');
      return;
    }
    onJoinAck(ack);
  });
}

/**
 * A failed connect is retried while the budget lasts: the script may be
 * cached from an earlier session while the server has gone back to sleep.
 */
function onConnectError(socket, ioFactory) {
  if (!isCurrentSocket(socket)) return;
  if (state.phase !== 'connecting') {
    leaveMultiplayer('UNREACHABLE');
    return;
  }
  const mp = state.mp;
  teardownSocket();
  const delay = retryDelayWithin(performance.now(), mp.connectDeadline, MP_CONSTANTS.wakeRetryDelayMs);
  if (delay === null) {
    leaveMultiplayer('UNREACHABLE');
    return;
  }
  clearTimeout(connectRetryTimer);
  connectRetryTimer = setTimeout(() => {
    connectRetryTimer = 0;
    if (state.mp === mp) connectSocket(ioFactory);
  }, delay);
}

/** Any disconnect we did not cause (leaveMultiplayer removes this listener first). */
function onDisconnect(socket) {
  if (isCurrentSocket(socket)) leaveMultiplayer(mpDisconnectCode || 'DISCONNECTED');
}

function onJoinAck(raw) {
  // Connected: no waking notice or connect retry may follow, whatever the answer.
  clearConnectTimers();
  const ack = validateJoinAck(raw);
  if (ack === null) {
    leaveMultiplayer('BAD_RESPONSE'); // generic message
    return;
  }
  if (!ack.ok) {
    leaveMultiplayer(ack.error.code);
    return;
  }
  if (state.phase !== 'connecting') return;

  state.mp.session.playerId = ack.playerId;
  state.mp.session.room = ack.room;
  state.phase = 'waiting';
  renderPhase();
  renderTimer();
  renderRacePanel();
  renderRaceTracks();
  // Delayed, so a race:countdown arriving right behind it replaces this
  // message; the countdown then carries the rule (see onRaceCountdown).
  const session = state.mp.session;
  announceSoon('Connected. Waiting for an opponent. When the race starts, type the passage and fix every mistake to finish.',
    () => { session.instructionsSpoken = true; });
}

/* 12.4 Server events */

function onRoomState(raw) {
  const room = validateRoomState(raw);
  if (room === null || state.phase === 'connecting') return;
  const mp = state.mp;
  mp.session.room = room;

  // Countdown -> waiting: the opponent left before the start.
  // Finished -> waiting: our rematch with no opponent left (the server sends a
  // 'finished' snapshot first, then this one).
  if (room.phase === 'waiting' && (state.phase === 'countdown' || state.phase === 'finished')) {
    enterWaiting(state.phase === 'countdown'
      ? 'Your opponent left. Waiting for a new opponent.'
      : 'Waiting for a new opponent.');
    return;
  }

  // Normally race:end arrives first and the client is already 'finished'. If
  // it was lost (or failed validation), the room has moved on without us:
  // end the race here with no results, or the client would stay stuck.
  if (state.phase === 'running' && (room.phase === 'finished' || room.phase === 'waiting')) {
    endRace(null);
    // A 'waiting' room means the server already cleared its idle timer, so
    // no removal is coming: no deadline, notice or warning.
    if (room.phase === 'waiting') {
      mp.rematchDeadline = null;
      clearRematchWarnTimer();
      renderRaceResultsStatus();
    }
    // Joins endRace's pending "Race over." (see setResultsStatus).
    setResultsStatus(rematchStatus(room));
    return;
  }

  if (state.phase === 'finished') {
    setResultsStatus(rematchStatus(room));
  } else if (state.phase === 'running') {
    announceDepartures(room);
  }
  renderRacePanel();
  renderRaceTracks();
}

/**
 * Sets the results-card status line and announces it when it changes to a
 * new, non-empty text (#res-best is not a live region). room:state and the
 * rematch ack often repeat the same text, which is then not read twice.
 * race:end and room:state arrive back to back, so while "Race over…" is
 * still pending the status joins it: one message, in the right order.
 */
function setResultsStatus(next) {
  const mp = state.mp;
  if (next === mp.resultsStatus) return;
  mp.resultsStatus = next;
  renderRaceResultsStatus();
  if (!next || next === STATUS_WAITING_NEW_OPPONENT) return;
  if (resultAnnounceTimer !== 0) announceSoon(`${pendingAnnouncement} ${next}`);
  else announce(next);
}

/** "Your opponent left the race.", once per player per race. */
function announceDepartures(room) {
  const mp = state.mp;
  const selfId = getSelfId();
  for (const player of room.players) {
    if (player.id === selfId || player.connected || mp.departed[player.id]) continue;
    mp.departed[player.id] = true;
    announce(`${opponentSubject(labelFor(player.id, selfId, room.players))} left the race.`);
  }
}

/** Back to the race panel with no passage, keeping the session. */
function enterWaiting(message) {
  // The typing area and results card are about to be hidden; focus inside them
  // would fall to <body>, so it goes to the race heading instead.
  const focusWillBeLost = isFocusIn(dom.typingArea) || isFocusIn(dom.results);
  stopRaceTimers();
  state = createRaceState(state.mp.session);
  state.phase = 'waiting';
  renderAll();
  if (focusWillBeLost) dom.raceTitle.focus();
  announceSoon(message);
}

function onRaceCountdown(raw) {
  const data = validateCountdown(raw);
  if (data === null || state.phase === 'connecting' || state.phase === 'running') return;

  stopRaceTimers();
  state = createRaceState(state.mp.session, data);
  state.phase = 'countdown';
  // The local clock drives the display only; race:start unlocks typing.
  state.mp.countdownEndsAt = performance.now() + data.startsInMs;
  state.mp.countdownSeconds = Math.ceil(data.startsInMs / 1000);
  state.intervalId = setInterval(tick, CONFIG.tickMs);
  renderAll();

  // The player asked for a race and must be able to type at "Go".
  focusInput();
  const seconds = state.mp.countdownSeconds;
  const start = seconds > 0
    ? `Race starting in ${seconds} second${seconds === 1 ? '' : 's'}.`
    : 'Race starting.';
  // A second joiner's join message was cancelled by this countdown, so the
  // rule is said here instead, once per session.
  const session = state.mp.session;
  if (session.instructionsSpoken) {
    announceSoon(`${start} Get ready to type.`);
  } else {
    session.instructionsSpoken = true;
    announceSoon(`${start} Fix every mistake to finish.`);
  }
}

function onRaceStart(raw) {
  const data = validateRaceStart(raw);
  if (data === null || state.phase !== 'countdown') return;

  state.phase = 'running';
  state.startTime = performance.now();
  state.mp.raceTimeLimitMs = data.raceTimeLimitMs;
  state.duration = Math.ceil(data.raceTimeLimitMs / 1000);
  state.timeLeft = data.raceTimeLimitMs / 1000; // exact, as in tickRace
  if (state.intervalId === null) state.intervalId = setInterval(tick, CONFIG.tickMs);
  renderPhase();
  renderTimer();
  renderRacePanel();
  announce('Go!');
}

function milestoneMessage(label, milestone) {
  return milestone === 50 ? `${label} is halfway.` : `${label} is ${milestone}% through.`;
}

function onRaceUpdate(raw) {
  const data = validateRaceUpdate(raw);
  if (data === null || state.phase !== 'running') return;
  const mp = state.mp;
  const selfId = getSelfId();

  for (const entry of data.players) {
    const previous = mp.progress[entry.id];
    mp.progress[entry.id] = entry;
    // Own progress is never announced; the player can see and feel it.
    if (entry.id === selfId || entry.finished) continue;
    const milestone = crossedMilestone(previous ? previous.progress : 0, entry.progress, MP_CONSTANTS.milestones);
    if (milestone !== null && milestone > (mp.milestones[entry.id] || 0)) {
      mp.milestones[entry.id] = milestone;
      announce(milestoneMessage(labelFor(entry.id, selfId, getRoomPlayers()), milestone));
    }
  }
  renderRaceTracks();
  renderRacePanel();
}

function onPlayerFinish(raw) {
  const data = validatePlayerFinish(raw);
  if (data === null || state.phase !== 'running') return;
  const mp = state.mp;
  const selfId = getSelfId();

  // Show the finish right away rather than at the next race:update.
  mp.progress[data.id] = {
    id: data.id,
    correctChars: state.chars.length,
    progress: 100,
    wpm: data.wpm,
    accuracy: data.accuracy,
    finished: true,
    place: data.place,
  };

  const place = ordinal(data.place);
  if (data.id === selfId) {
    // The server agrees the passage is done; nothing more needs sending.
    mp.localDone = true;
    clearFlushTimer();
    mp.pendingKeys = '';
    announce(`You finished in ${place} place.`);
  } else {
    announce(`${labelFor(data.id, selfId, getRoomPlayers())} finished in ${place} place.`);
  }
  renderRacePanel();
  renderRaceTracks();
}

function onRaceEnd(raw) {
  const data = validateRaceEnd(raw);
  if (data === null || state.phase !== 'running') return;
  endRace(data.results);
}

/**
 * Running -> finished. `results` is the race:end list, or null when race:end
 * never arrived (the result grid then shows "--"). Runs once per race: both
 * callers require the 'running' phase, which this leaves.
 */
function endRace(results) {
  const mp = state.mp;

  stopRaceTimers();
  mp.pendingKeys = '';
  mp.results = results;
  mp.resultsStatus = '';
  mp.rematchRequested = false;
  state.phase = 'finished';
  // The server's rematch timer starts at race:end, so ours does too.
  mp.rematchDeadline = performance.now() + MP_CONSTANTS.rematchTimeoutMs;
  mp.rematchWarned = false;
  scheduleRematchWarning();

  renderPhase();
  renderRaceResults();
  renderRaceResultsStatus();

  // As in solo: focus the heading so a stray Space does not start a rematch.
  dom.resultsTitle.focus();
  const own = results ? results.find((entry) => entry.id === getSelfId()) : null;
  announceSoon(own
    ? `Race over. You placed ${ordinal(own.place)} of ${results.length}. ` +
      `${own.wpm} words per minute, ${own.accuracy} percent accuracy.`
    : 'Race over.');
}

/**
 * Warns ahead of the server's idle removal (WCAG 2.2.1). Timed from the
 * deadline rather than a fixed delay, so a failed rematch can re-arm it.
 */
function scheduleRematchWarning() {
  const mp = state.mp;
  clearRematchWarnTimer();
  if (mp.rematchWarned || mp.rematchDeadline === null) return;
  const delay = mp.rematchDeadline - MP_CONSTANTS.rematchWarningMs -
    MP_CONSTANTS.rematchWarningMarginMs - performance.now();
  mp.rematchWarnTimerId = setTimeout(() => {
    mp.rematchWarnTimerId = null;
    if (state.mp !== mp || state.phase !== 'finished' || mp.rematchRequested) return;
    mp.rematchWarned = true;
    renderRaceResultsStatus();
    announce(rematchWarning());
  }, Math.max(0, delay));
}

/**
 * Errors for events without an ack. Only IDLE_TIMEOUT needs handling: the
 * server closes the socket right after it, and that disconnect should say
 * why. Anything else is logged only.
 */
function onGameError(raw) {
  const code = raw && typeof raw.code === 'string' ? raw.code.slice(0, 64) : 'UNKNOWN';
  if (code === 'IDLE_TIMEOUT') {
    mpDisconnectCode = code;
    return;
  }
  console.warn('[multiplayer] server reported an error:', code);
}

const SERVER_EVENT_HANDLERS = Object.freeze({
  'room:state': onRoomState,
  'race:countdown': onRaceCountdown,
  'race:start': onRaceStart,
  'race:update': onRaceUpdate,
  'player:finish': onPlayerFinish,
  'race:end': onRaceEnd,
  'game:error': onGameError,
});

/* 12.5 Sending keystrokes (throttled, PROTOCOL.md race:progress) */

function queueKey(key) {
  const mp = state.mp;
  const next = appendKey(mp.pendingKeys, key, MP_CONSTANTS.maxKeysPerEvent);
  mp.pendingKeys = next.buffer;
  // A full buffer is sent at once, so no event exceeds the server's limit.
  if (next.flush) sendProgress(next.flush);
  if (mp.flushTimerId === null) {
    mp.flushTimerId = setTimeout(flushKeys, MP_CONSTANTS.progressIntervalMs);
  }
}

function flushKeys() {
  if (state.mode !== 'multi') return;
  clearFlushTimer();
  const keys = state.mp.pendingKeys;
  if (keys === '') return;
  state.mp.pendingKeys = '';
  sendProgress(keys);
}

function sendProgress(keys) {
  if (mpSocket === null || state.phase !== 'running' || state.mp.seq >= MP_CONSTANTS.seqMax) return;
  state.mp.seq += 1;
  mpSocket.emit('race:progress', { seq: state.mp.seq, keys });
}

/** The local text matches the whole passage; the server confirms with player:finish. */
function finishRaceLocally() {
  state.mp.localDone = true;
  flushKeys(); // now, so the finish time is not delayed by the throttle
  renderLiveStats(getElapsedMs());
  renderRacePanel();
}

/** Background tabs throttle timers to 1 s or more, so send what is buffered now. */
function handleVisibilityChange() {
  if (document.visibilityState === 'hidden' && state.mode === 'multi' && state.phase === 'running') {
    flushKeys();
  }
}

/* 12.6 Rematch, leaving and the mode switch */

function requestRematch() {
  const mp = state.mp;
  if (state.phase !== 'finished' || mp.rematchRequested || mpSocket === null) return;

  mp.rematchRequested = true;
  clearRematchWarnTimer();
  const hasOpponent = getRoomPlayers().some((player) => player.id !== getSelfId());
  setResultsStatus(hasOpponent ? 'Waiting for your opponent to race again.' : STATUS_WAITING_NEW_OPPONENT);
  renderRaceResultsStatus(); // the button changes even when the text does not

  const socket = mpSocket;
  socket.timeout(MP_CONSTANTS.ackTimeoutMs).emit('race:rematch', {}, (error, ack) => {
    // Ignore a late answer once a new race (or solo) has replaced this state.
    if (!isCurrentSocket(socket) || state.mp !== mp) return;
    onRematchAck(error ? null : ack);
  });
}

function onRematchAck(raw) {
  const ack = validateRematchAck(raw);
  const mp = state.mp;
  if (ack === null || !ack.ok) {
    mp.rematchRequested = false;
    mp.resultsStatus = errorMessage(ack === null ? 'BAD_RESPONSE' : ack.error.code);
    renderRaceResultsStatus();
    // The server's idle timer kept running, so the warning is still due.
    scheduleRematchWarning();
    // The button is usable again; say why it came back. Cleared first and
    // written on the next frame (as in restart), so the same error twice in
    // a row, such as RATE_LIMITED, is read again.
    announce('');
    requestAnimationFrame(() => {
      if (state.mp === mp) announce(mp.resultsStatus);
    });
    return;
  }
  mp.session.room = ack.room;
  setResultsStatus(rematchStatus(ack.room));
}

function teardownSocket() {
  const socket = mpSocket;
  if (socket === null) return;
  mpSocket = null;
  mpDisconnectCode = null;
  // Listeners first, so the disconnect below is not handled as a lost connection.
  socket.off();
  socket.disconnect();
}

/**
 * The single exit from multiplayer. `code` (optional) selects the message in
 * #mp-error, which the alert speaks; without one the live region says solo
 * mode is ready.
 */
function leaveMultiplayer(code) {
  if (state.mode !== 'multi') return;
  // Focus inside an area that is about to be hidden moves to the input (a
  // disconnect mid-race leaves the user able to type); otherwise it stays put.
  const moveFocus = isFocusIn(dom.typingArea) || isFocusIn(dom.racePanel) || isFocusIn(dom.results);
  teardownSocket();
  cancelSocketIoLoad();
  stopRaceTimers(); // also the waking notice and connect retry timers
  const duration = loadDuration();
  restart(duration, { message: code ? '' : `Solo mode. New test ready, ${duration} seconds.`, moveFocus });
  mpErrorCode = code || null;
  renderMpError();
}

function handleModeClick(event) {
  const button = event.target.closest('[data-mode]');
  if (!button || !dom.mode.contains(button)) return;
  const mode = button.dataset.mode;
  if (mode === state.mode) return;

  // Keyboard users keep focus on the button and hear its pressed state.
  if (mode === 'multi') {
    startMultiplayer();
    return;
  }
  leaveMultiplayer();
  // A mouse click (detail > 0) hands focus to the solo test.
  if (event.detail > 0) focusInput();
}

init();
