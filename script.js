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
   ========================================================================== */

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
});

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
  settings: document.getElementById('settings'),
  settingButtons: document.querySelectorAll('#settings [data-duration]'),
  timer: document.getElementById('timer'),
  liveWpm: document.getElementById('live-wpm'),
  liveAcc: document.getElementById('live-acc'),
  liveBest: document.getElementById('live-best'),
  typingArea: document.getElementById('typing-area'),
  track: document.getElementById('words-track'),
  words: document.getElementById('words'),
  caret: document.getElementById('caret'),
  input: document.getElementById('hidden-input'),
  restartInline: document.getElementById('restart-inline'),
  results: document.getElementById('results'),
  resWpm: document.getElementById('res-wpm'),
  resAcc: document.getElementById('res-acc'),
  resRaw: document.getElementById('res-raw'),
  resChars: document.getElementById('res-chars'),
  resTime: document.getElementById('res-time'),
  resBest: document.getElementById('res-best'),
  restartBtn: document.getElementById('restart-btn'),
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
    phase: 'idle',                              // 'idle' | 'running' | 'finished'
    chars,                                      // expected characters
    index: 0,                                   // position of the next character to type
    results: new Array(chars.length).fill(null), // null | 'correct' | 'incorrect'
    duration,                                   // seconds
    timeLeft: duration,                         // seconds (may be fractional)
    startTime: null,                            // ms timestamp from Date.now()
    intervalId: null,                           // setInterval handle
    totalKeystrokes: 0,                         // every printable key typed
    correctKeystrokes: 0,                       // printable keys that matched
  };
}

// Preferences outlive a single test, so they are kept apart from `state`
// (createInitialState would otherwise wipe them on every restart).
const prefs = { theme: loadTheme() };

let state = createInitialState(loadDuration());

// One <span> per character, same order as state.chars. Lets us update a single
// character in O(1) instead of re-rendering the whole text.
let spans = [];

// Pixel height of one text line. A layout measurement, not app state.
let lineHeight = 0;

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
  measureLineHeight();
  renderCaret(null);
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
  if (!span) return;
  span.classList.add('current');
  positionCaret(span);
}

function positionCaret(span) {
  if (dom.typingArea.hidden) return; // hidden elements have no layout

  // offsetLeft/offsetTop are relative to .words-track (the positioned parent).
  const x = span.offsetLeft;
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

function renderPhase() {
  dom.body.dataset.phase = state.phase;
  const finished = state.phase === 'finished';
  dom.typingArea.hidden = finished;
  dom.results.hidden = !finished;
}

function renderSettings() {
  for (const button of dom.settingButtons) {
    const isActive = Number(button.dataset.duration) === state.duration;
    button.setAttribute('aria-pressed', String(isActive));
  }
}

function renderTimer() {
  dom.timer.textContent = String(Math.ceil(state.timeLeft));
}

function renderLiveStats(elapsedMs) {
  const stats = computeStats(state, Math.max(elapsedMs, CONFIG.minLiveElapsedMs));
  dom.liveWpm.textContent = String(stats.wpm);
  dom.liveAcc.textContent = state.totalKeystrokes === 0 ? '--' : `${stats.accuracy}%`;
}

function renderBest() {
  const best = getBest(state.duration);
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
function renderAll() {
  renderPhase();      // must run first: the text must be visible to be measured
  renderSettings();
  renderTimer();
  renderLiveStats(0);
  renderBest();
  renderText();
}

/* ---------- 8. Timer ---------- */

function stopTimer() {
  if (state.intervalId !== null) {
    clearInterval(state.intervalId);
    state.intervalId = null;
  }
}

function startTest() {
  stopTimer(); // guard: never allow two intervals (the "double speed timer" bug)
  state.phase = 'running';
  state.startTime = Date.now();
  state.intervalId = setInterval(tick, CONFIG.tickMs);
  renderPhase();
}

function tick() {
  if (state.phase !== 'running') return;

  // Real elapsed time from the clock. Interval ticks drift and get throttled
  // in background tabs, so they are never counted.
  const elapsedMs = Date.now() - state.startTime;
  state.timeLeft = Math.max(0, state.duration - elapsedMs / 1000);

  if (state.timeLeft === 0) {
    finishTest();
    return;
  }

  renderTimer();
  renderLiveStats(elapsedMs);
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
  renderBest();
  announce(
    `Test complete. ${stats.wpm} words per minute, ${stats.accuracy} percent accuracy.` +
    (saved.isNewBest ? ' New personal best!' : '')
  );

  dom.restartBtn.focus();
}

function restart(duration = state.duration) {
  stopTimer();
  state = createInitialState(duration);
  writeStorage(STORAGE_KEYS.duration, duration);
  announce('');
  renderAll();
  focusInput();
}

/* ---------- 9. Core typing logic ---------- */

function handleCharacter(key) {
  if (state.phase === 'finished') return;
  if (state.phase === 'idle') startTest();

  const i = state.index;
  const isCorrect = key === state.chars[i];

  state.results[i] = isCorrect ? 'correct' : 'incorrect';
  state.totalKeystrokes += 1;
  if (isCorrect) state.correctKeystrokes += 1;
  state.index += 1;

  extendTextIfNeeded();
  renderChar(i);
  renderCaret(i);
}

function handleBackspace() {
  if (state.phase !== 'running' || state.index === 0) return;

  const previousIndex = state.index;
  state.index -= 1;
  state.results[state.index] = null;
  // Keystroke counters are NOT decreased: a mistake still counts against accuracy.

  renderChar(state.index);
  renderCaret(previousIndex);
}

/** Infinite text: append more words when the caret gets close to the end. */
function extendTextIfNeeded() {
  if (state.chars.length - state.index > CONFIG.extendThreshold) return;

  const more = [' ', ...generateChars(CONFIG.extendWordCount)];
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
  // Tab = restart. Shift+Tab is left alone so keyboard users can still move focus.
  if (event.key === 'Tab') {
    if (event.shiftKey) return;
    event.preventDefault();
    restart();
    return;
  }

  // Shortcuts like Ctrl+R or Cmd+C must keep working and never count as typing.
  if (event.ctrlKey || event.metaKey) return;

  // IME composition / Android soft keyboards report 'Unidentified' or 'Process'.
  // Those are handled by the `input` event in handleMobileInput instead.
  if (event.isComposing || event.key === 'Unidentified' || event.key === 'Process') return;

  // Let Space/Enter activate a focused button instead of typing.
  if (isInteractiveTarget(event.target) && (event.key === ' ' || event.key === 'Enter')) return;

  // Space would scroll the page, even after the test finishes.
  if (event.key === ' ') event.preventDefault();

  if (state.phase === 'finished') return;

  if (event.key === 'Backspace') {
    event.preventDefault();
    handleBackspace();
    return;
  }

  // Printable characters have a one-character key. Shift, CapsLock, Alt,
  // arrows, F1-F12, Escape, Enter... all have longer names and are ignored.
  if (event.key.length !== 1) return;

  // preventDefault also stops the hidden input receiving the character, so the
  // `input` event never fires for it and the key is never counted twice.
  event.preventDefault();
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

function handleSettingsClick(event) {
  const button = event.target.closest('[data-duration]');
  if (!button || !dom.settings.contains(button)) return;

  const duration = Number(button.dataset.duration);
  if (!isValidDuration(duration)) return;
  restart(duration);
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

function init() {
  applyTheme(prefs.theme);

  document.addEventListener('keydown', handleKeydown);
  dom.input.addEventListener('input', handleMobileInput);
  dom.typingArea.addEventListener('click', focusInput);
  dom.settings.addEventListener('click', handleSettingsClick); // event delegation
  dom.restartBtn.addEventListener('click', () => restart());
  dom.restartInline.addEventListener('click', () => restart());
  dom.themeToggle.addEventListener('click', (event) => {
    toggleTheme();
    // Mouse click (detail > 0): hand focus back to the test so the next Space
    // types instead of toggling again. Keyboard users keep focus on the button.
    if (event.detail > 0) focusInput();
  });
  window.addEventListener('resize', handleResize);

  renderAll();
  renderHistory(loadHistory());
  focusInput();

  // Web fonts can change character widths after load; re-measure once ready.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(handleResize);
  }
}

init();
