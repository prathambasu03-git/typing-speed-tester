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
             menu -> connecting -> waiting (room lobby) -> countdown -> running
             -> finished -> waiting (Race again, or the host started without
             this player, who sits that race out)
             connecting -> menu (join or create error, code kept)
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
  typeof parseRoomHash === 'function' && typeof validateStartAck === 'function' &&
  typeof hostChangeText === 'function' && typeof MP_CONSTANTS === 'object';

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
  invite: document.getElementById('invite'),
  inviteCode: document.getElementById('invite-code'),
  inviteCodeSpelled: document.getElementById('invite-code-spelled'),
  inviteJoinBtn: document.getElementById('invite-join-btn'),
  inviteDismissBtn: document.getElementById('invite-dismiss-btn'),
  racePanel: document.getElementById('race-panel'),
  raceTitle: document.getElementById('race-title'),
  mpMenu: document.getElementById('mp-menu'),
  createRoomBtn: document.getElementById('create-room-btn'),
  joinForm: document.getElementById('join-form'),
  roomCodeInput: document.getElementById('room-code-input'),
  roomCodeError: document.getElementById('room-code-error'),
  menuError: document.getElementById('menu-error'),
  roomInfo: document.getElementById('room-info'),
  roomCode: document.getElementById('room-code'),
  roomCodeSpelled: document.getElementById('room-code-spelled'),
  roomLink: document.getElementById('room-link'),
  copyLinkBtn: document.getElementById('copy-link-btn'),
  copyStatus: document.getElementById('copy-status'),
  soloTip: document.getElementById('solo-tip'),
  raceStatus: document.getElementById('race-status'),
  raceTracks: document.getElementById('race-tracks'),
  roomActions: document.getElementById('room-actions'),
  startBtn: document.getElementById('start-btn'),
  startHint: document.getElementById('start-hint'),
  extendBtn: document.getElementById('extend-btn'),
  leaveRoomBtn: document.getElementById('leave-room-btn'),
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
 * A fresh multiplayer session: who we are and the latest room snapshot (its
 * `code` is the room code). instructionsSpoken: the "fix every mistake" rule
 * was read out this session.
 */
function newSession() {
  return { playerId: null, room: null, instructionsSpoken: false };
}

/**
 * Returns a new multiplayer state. `session` ({ playerId, room }) is carried
 * from race to race; everything else starts fresh. Before replacing `state`
 * with this, the caller clears the old timers (stopRaceTimers).
 */
function createRaceState(session, { passage = '', raceTimeLimitMs = 0 } = {}) {
  const chars = passage.split(''); // ASCII words, split exactly like the server's passage
  const duration = Math.ceil(raceTimeLimitMs / 1000);
  return {
    mode: 'multi',
    // 'menu' | 'connecting' | 'waiting' | 'countdown' | 'running' | 'finished'.
    // 'waiting' is the room lobby view: the room is waiting, or it is finished
    // and this player pressed Race again (or joined since), or this player
    // sits out the race that is on.
    phase: 'menu',
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
      intent: null,              // { type: 'create' } | { type: 'join', code }, set when connecting
      menuError: null,           // { code, field: 'join' | 'create', text? }; code 'INPUT' = typed code error
      codeDraft: '',             // written into the code input only when the menu is entered
      startRequested: false,     // room:start sent, ack pending
      startStatus: '',           // start or Stay in room failure, shown in #race-status
      lobbyDeadline: null,       // performance.now() when the server closes an idle lobby
      lobbyWarned: false,        // the "closes in about 1 minute" warning is showing
      lobbyWarnTimerId: null,
      extendRequested: false,    // room:extend sent, ack pending
      copyStatus: '',            // result of the last Copy invite link press
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

// Room code from a #room= invite link, or null. Outside `state` so it
// survives restart(); cleared when the invite is used or dismissed.
let inviteCode = null;

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
// The list's accessible name as last written (index.html starts with this).
let trackLabel = 'Live progress';

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
  // and a long description would delay "Go!". The race rule is spoken once
  // per session, at the first countdown (onRaceCountdown), instead of living
  // in this description, which focus would read at every countdown.
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
  const noRace = state.mode === 'multi' &&
    (state.phase === 'menu' || state.phase === 'connecting' || state.phase === 'waiting');
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
  renderInvite();
  if (state.mode === 'multi') {
    renderRacePanel();
    renderRaceTracks();
    renderLobby();
    renderMenu();
    if (state.chars.length > 0) renderText();
    else clearText();
  } else {
    renderBest(best);
    renderText();
  }
}

/**
 * The invite banner, only in solo (it is replaced by the menu in multi).
 * spellRoomCode is only reached with an invite code, which needs
 * multiplayer.js, so this is safe when that file failed to load.
 */
function renderInvite() {
  const show = inviteCode !== null && state.mode === 'solo';
  dom.invite.hidden = !show;
  if (!show) return;
  dom.inviteCode.textContent = inviteCode;
  dom.inviteCodeSpelled.textContent = spellRoomCode(inviteCode);
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
// The text announceSoon is waiting to speak, so setResultsStatus can join it,
// with its onSpoken callback and the state it belongs to, so a joined message
// keeps both.
let pendingAnnouncement = '';
let pendingOnSpoken = null;
let pendingState = null;
let restartAnnounceFrame = 0;

function cancelResultAnnouncement() {
  clearTimeout(resultAnnounceTimer);
  resultAnnounceTimer = 0;
  pendingAnnouncement = '';
  pendingOnSpoken = null;
  pendingState = null;
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
  return typeof Element !== 'undefined' && target instanceof Element && target !== dom.input &&
    target.closest('button, a, input, select, textarea') !== null;
}

/**
 * Fields the user types into (the room code, the invite link). Explicit
 * comparisons first, so the check needs no real DOM; then any other text
 * field, so no future form control has its keys taken by the test.
 */
function isTextEntryTarget(target) {
  if (target === dom.roomCodeInput || target === dom.roomLink) return true;
  return typeof Element !== 'undefined' && target instanceof Element && target !== dom.input &&
    target.closest('input, textarea, select') !== null;
}

function handleKeydown(event) {
  // Keys typed into a form field belong to it: they must neither start nor
  // feed the solo test, and Space or Enter there must keep their meaning.
  if (isTextEntryTarget(event.target)) return;

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
    dom.createRoomBtn.addEventListener('click', () => connectToRoom({ type: 'create' }));
    dom.joinForm.addEventListener('submit', handleJoinSubmit);
    dom.copyLinkBtn.addEventListener('click', copyInviteLink);
    dom.startBtn.addEventListener('click', requestStart);
    dom.extendBtn.addEventListener('click', requestExtend);
    dom.leaveRoomBtn.addEventListener('click', leaveRoom);
    dom.inviteJoinBtn.addEventListener('click', handleInviteJoin);
    dom.inviteDismissBtn.addEventListener('click', handleInviteDismiss);
    window.addEventListener('hashchange', handleHashChange);
    dom.soloTip.textContent = SOLO_TIP;

    // An invite link only shows the banner: nothing is sent to the server
    // until the user presses Join room (or Multiplayer).
    inviteCode = parseRoomHash(window.location.hash);
    renderInvite();
  }

  // With an invite, focus its Join button; typing still reaches the test
  // through the idle redirect in handleKeydown.
  if (inviteCode !== null) dom.inviteJoinBtn.focus();
  else focusInput();

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
// before closing the socket (IDLE_TIMEOUT, ROOM_EXPIRED); null means an
// unexpected drop.
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

function clearLobbyWarnTimer() {
  if (state.mp && state.mp.lobbyWarnTimerId !== null) {
    clearTimeout(state.mp.lobbyWarnTimerId);
    state.mp.lobbyWarnTimerId = null;
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
  clearLobbyWarnTimer();
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
function announceSoon(message, onSpoken = null, expected = state) {
  cancelResultAnnouncement();
  pendingAnnouncement = message;
  pendingOnSpoken = onSpoken;
  pendingState = expected;
  resultAnnounceTimer = setTimeout(() => {
    resultAnnounceTimer = 0;
    pendingAnnouncement = '';
    pendingOnSpoken = null;
    pendingState = null;
    if (state !== expected) return;
    announce(message);
    if (onSpoken) onSpoken();
  }, CONFIG.resultAnnounceDelayMs);
}

/**
 * Announces now, or, while an announceSoon message is still pending, joins
 * it, so one snapshot never overwrites the message before it. A pending
 * message from a replaced state is stale: it is dropped, not brought back.
 */
function announceAfterPending(message) {
  if (!message) return;
  if (resultAnnounceTimer === 0) {
    announce(message);
  } else if (state !== pendingState) {
    cancelResultAnnouncement();
    announce(message);
  } else {
    // Same delay again, for the same state, with the original callback.
    announceSoon(`${pendingAnnouncement} ${message}`, pendingOnSpoken, pendingState);
  }
}

/**
 * For messages a user can trigger twice in a row (a failed start, a copy, a
 * bad code): cleared first and written on the next frame, as in restart(),
 * so the same text is read again. Dropped if `state` was replaced meanwhile.
 */
function announceRepeatable(message) {
  const expected = state;
  announce('');
  cancelAnimationFrame(restartAnnounceFrame);
  restartAnnounceFrame = requestAnimationFrame(() => {
    restartAnnounceFrame = 0;
    if (state === expected) announce(message);
  });
}

// Shown (and announced once) when the first connection to a remote server is
// still pending after MP_CONSTANTS.wakeNoticeDelayMs: the server is asleep.
// #race-hint is hidden while connecting, so these say how to cancel themselves.
const WAKE_STATUS = 'Waking up the game server, this can take up to a minute… Choose Solo to cancel.';
const WAKE_ANNOUNCEMENT = 'Waking up the game server, this can take up to a minute. Choose Solo to cancel.';

// Shown on the results card while the Race again ack is on its way. Never
// announced: the ack moves the player to the lobby, which says so.
const STATUS_BACK_TO_ROOM = 'Going back to the room…';

// Shown in the lobby (and announced once) about a minute before an idle
// room closes; Stay in room appears with it.
const LOBBY_WARNING = 'No race has started, so this room closes in about 1 minute. Press Stay in room to keep it open.';

// Error codes after which a failed create or join goes back to the menu with
// the code kept, instead of ending multiplayer. RATE_LIMITED is added by
// menuFieldFor, on the field of whichever was tried.
const JOIN_MENU_CODES = Object.freeze(['BAD_CODE', 'ROOM_NOT_FOUND', 'ROOM_FULL', 'RACE_IN_PROGRESS']);
const CREATE_MENU_CODES = Object.freeze(['TOO_MANY_ROOMS']);

/** 'join' or 'create' for an entry error shown in the menu, else null (solo). */
function menuFieldFor(code, intentType) {
  if (JOIN_MENU_CODES.includes(code)) return 'join';
  if (CREATE_MENU_CODES.includes(code)) return 'create';
  if (code === 'RATE_LIMITED') return intentType === 'join' ? 'join' : 'create';
  return null;
}

/** Results-card status line for a player still on their results. */
function rematchStatus(room) {
  const selfId = getSelfId();
  const others = room.players.filter((player) => player.id !== selfId);
  if (others.length === 0) return 'Everyone else left. Press Race again to go back to the room.';
  // Ready players pressed Race again, joined since the race, or sat it out.
  const n = others.filter((player) => player.ready).length;
  if (n > 0) return `${n} ${n === 1 ? 'player is' : 'players are'} back in the room.`;
  return '';
}

/** Said when Race again takes this player back to the room lobby. */
function rematchBackText() {
  const room = state.mp.session.room;
  const selfId = getSelfId();
  if (room && room.hostId === selfId) {
    if (canStartRace(room, selfId)) return 'Back in the room. You can start the race.';
    const hint = startHint(room, selfId);
    return hint ? `Back in the room. ${hint}` : 'Back in the room.';
  }
  return 'Back in the room. Waiting for the host to start.';
}

/* 12.2 Race rendering (state -> DOM, write only) */

/** The status line in the room lobby view (client phase 'waiting'). */
function lobbyStatusText() {
  const mp = state.mp;
  const room = mp.session.room;
  if (!room) return '';
  const selfId = getSelfId();
  const isHost = room.hostId === selfId;
  let text;
  if (mp.startStatus) {
    text = mp.startStatus;
  } else if (isSittingOut(room, selfId)) {
    text = SIT_OUT_MESSAGE;
  } else if (room.phase === 'finished') {
    text = isHost
      ? `${readyCount(room, selfId)} of ${room.players.length} players are back in the room. ` +
        'Players still on their results will join the next race.'
      : 'Waiting for the host to start the next race…';
  } else if (room.phase === 'waiting') {
    if (!isHost) text = 'Waiting for the host to start the race…';
    else if (room.players.length < 2) text = 'Share the code or link so others can join.';
    else text = `${room.players.length} of ${room.maxPlayers} players here. Press Start race when everyone is ready.`;
  } else {
    // This player races (inRace) and race:countdown is a moment away.
    text = 'Get ready…';
  }
  return mp.lobbyWarned ? `${text} ${LOBBY_WARNING}` : text;
}

function raceStatusText() {
  const mp = state.mp;
  switch (state.phase) {
    case 'menu':
      return ''; // the menu speaks for itself
    case 'connecting':
      return mp.waking ? WAKE_STATUS : 'Connecting to the multiplayer server…';
    case 'waiting':
      return lobbyStatusText();
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
  if (state.phase === 'waiting') {
    // The lobby view lists everyone, with where they are instead of progress.
    const room = state.mp.session.room;
    if (room.phase === 'finished') return player.ready ? 'in the room' : 'on the results';
    if (room.phase === 'countdown' || room.phase === 'racing') return player.inRace ? 'racing' : 'sitting out';
    return 'in the room';
  }
  const entry = state.mp.progress[player.id];
  if (!entry) return '0% · 0 wpm';
  if (entry.finished && entry.place !== null) return `finished ${ordinal(entry.place)} · ${entry.wpm} wpm`;
  return `${entry.progress}% · ${entry.wpm} wpm`;
}

function trackScale(player) {
  const entry = state.mp.progress[player.id];
  return entry ? entry.progress / 100 : 0;
}

/** " (host)" after the host's name, on the tracks and the results list. */
function hostSuffix(playerId) {
  const room = state.mp.session.room;
  return room && room.hostId === playerId ? ' (host)' : '';
}

/**
 * Players with a track: during this player's own countdown and race only the
 * racers (players who sit out have no progress); in the lobby view everyone.
 */
function listedPlayers() {
  const players = getRoomPlayers();
  if (state.phase === 'countdown' || state.phase === 'running') return players.filter((player) => player.inRace);
  return players;
}

/** Rebuilds the rows. Only when the players or the host change, since labels depend on them. */
function buildRaceTracks(players) {
  const selfId = getSelfId();
  const fragment = document.createDocumentFragment();
  trackRows = new Map();

  for (const player of players) {
    const item = document.createElement('li');
    item.className = player.id === selfId ? 'race-track race-track--self' : 'race-track';

    const name = document.createElement('span');
    name.className = 'race-name';
    name.textContent = labelFor(player.id, selfId, players) + hostSuffix(player.id);

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
  const players = listedPlayers();
  // An empty "Live progress" list (menu, connecting) is noise for screen readers.
  dom.raceTracks.hidden = players.length === 0;
  // In the lobby view the list says who is here, not how far they are.
  const label = state.phase === 'waiting' ? 'Players in the room' : 'Live progress';
  if (label !== trackLabel) {
    dom.raceTracks.setAttribute('aria-label', label);
    trackLabel = label;
  }
  const room = state.mp.session.room;
  const key = JSON.stringify([getSelfId(), room ? room.hostId : null, ...players.map((player) => player.id)]);
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
  const label = labelFor(entry.id, getSelfId(), results) + hostSuffix(entry.id);
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
  dom.restartBtn.textContent = mp.rematchRequested ? 'Going back…' : 'Race again';
  setAriaDisabled(dom.restartBtn, mp.rematchRequested);
}

/** aria-disabled, not `disabled`, so the button keeps keyboard focus. */
function setAriaDisabled(button, isDisabled) {
  if (isDisabled) button.setAttribute('aria-disabled', 'true');
  else button.removeAttribute('aria-disabled');
}

// Last text renderLobby wrote to each element, so it writes only what changed
// without reading the DOM back. Only renderLobby writes these elements.
const lobbyTexts = new Map();

function writeLobbyText(element, text) {
  if (lobbyTexts.get(element) === text) return;
  lobbyTexts.set(element, text);
  element.textContent = text;
}

/**
 * Menu and room lobby visibility, the room code and link, Start race, the
 * start hint and Stay in room. Room info and actions show only in the lobby
 * view, so this player's own countdown and race stay calm.
 */
function renderLobby() {
  const mp = state.mp;
  const room = mp.session.room;
  const beforeRoom = state.phase === 'menu' || state.phase === 'connecting';
  writeLobbyText(dom.raceTitle, beforeRoom ? 'multiplayer' : 'race room');
  dom.mpMenu.hidden = state.phase !== 'menu';
  const inLobby = state.phase === 'waiting' && room !== null;
  dom.roomInfo.hidden = !inLobby;
  dom.roomActions.hidden = !inLobby;
  if (!inLobby) return;

  const selfId = getSelfId();
  writeLobbyText(dom.roomCode, room.code);
  writeLobbyText(dom.roomCodeSpelled, `Room code ${spellRoomCode(room.code)}`);
  const link = buildShareLink(window.location.href, room.code) || '';
  if (lobbyTexts.get(dom.roomLink) !== link) {
    lobbyTexts.set(dom.roomLink, link);
    dom.roomLink.value = link;
  }
  writeLobbyText(dom.copyStatus, mp.copyStatus);
  // Only its hidden attribute changes, so a render never announces it.
  dom.soloTip.hidden = !isAloneInLobby(room);

  const isHost = room.hostId === selfId;
  dom.startBtn.hidden = !isHost;
  setAriaDisabled(dom.startBtn, !canStartRace(room, selfId) || mp.startRequested);
  writeLobbyText(dom.startBtn, mp.startRequested ? 'Starting…' : 'Start race');
  const hint = isHost ? startHint(room, selfId) : '';
  writeLobbyText(dom.startHint, hint);
  dom.startHint.hidden = hint === '';

  dom.extendBtn.hidden = !mp.lobbyWarned;
  setAriaDisabled(dom.extendBtn, mp.extendRequested);
  writeLobbyText(dom.extendBtn, mp.extendRequested ? 'Keeping the room open…' : 'Stay in room');
}

/** Inline errors in the menu: under the code input (join) or under Create (create). */
function renderMenu() {
  const error = state.mp.menuError;
  let joinText = '';
  if (error && error.field === 'join') joinText = error.code === 'INPUT' ? error.text : errorMessage(error.code);
  dom.roomCodeError.textContent = joinText;
  dom.roomCodeError.hidden = joinText === '';
  if (joinText) dom.roomCodeInput.setAttribute('aria-invalid', 'true');
  else dom.roomCodeInput.removeAttribute('aria-invalid');

  // Not a live region (like the join error): returnToMenu focuses Create,
  // whose aria-describedby reads this text once. Cleared on hide so a stale
  // message is never part of Create's description.
  if (error && error.field === 'create') {
    dom.menuError.hidden = false;
    dom.menuError.textContent = errorMessage(error.code);
  } else {
    dom.menuError.hidden = true;
    dom.menuError.textContent = '';
  }
}

/** Only when the menu is entered or the hash changes there, never while typing. */
function renderMenuInput() {
  dom.roomCodeInput.value = state.mp.codeDraft;
}

/* 12.3 Connecting */

/**
 * Multiplayer pressed: the menu (Create, or Join with a code). No socket yet;
 * the Socket.io script starts loading in the background, which wakes a
 * sleeping server while the user chooses. Focus stays on the mode button.
 */
function startMultiplayer({ announceMenu = true } = {}) {
  if (state.mode === 'multi' || !MP_ENABLED) return;
  clearConnectTimers();
  stopTimer();
  cancelResultAnnouncement();
  cancelAnimationFrame(restartAnnounceFrame);
  restartAnnounceFrame = 0;
  mpErrorCode = null;
  mpDisconnectCode = null;

  state = createRaceState(newSession());
  state.mp.codeDraft = inviteCode || '';
  renderMpError();
  renderAll();
  renderMenuInput();
  if (announceMenu) announce('Multiplayer. Create a room, or join one with a code.');
  prefetchSocketIo();
}

/**
 * Starts the script load with its own budget and ignores the outcome: a
 * failure resets the cache, so Create or Join loads again within theirs.
 */
function prefetchSocketIo() {
  loadSocketIo(CONFIG.serverUrl, performance.now() + connectBudgetMs(CONFIG.serverUrl)).catch(() => {});
}

/**
 * Create or Join pressed: the cold-start flow (one budget from this press,
 * retries, the waking notice), then room:create or room:join on connect.
 */
function connectToRoom(intent) {
  if (state.mode !== 'multi' || state.phase !== 'menu') return;
  clearConnectTimers();
  const mp = state.mp;
  mp.intent = intent;
  mp.menuError = null;
  mp.waking = false;
  state.phase = 'connecting';
  // A timestamp, so throttled timers in a hidden tab never extend the budget.
  mp.connectDeadline = performance.now() + connectBudgetMs(CONFIG.serverUrl);
  renderAll();
  // The menu that had focus is now hidden.
  dom.raceTitle.focus();
  announceSoon('Connecting to the multiplayer server.');
  // A local server never sleeps, so only a remote one gets the waking notice.
  if (!isLoopbackUrl(CONFIG.serverUrl)) {
    wakeNoticeTimer = setTimeout(() => showWakeNotice(mp), MP_CONSTANTS.wakeNoticeDelayMs);
  }
  loadAndConnect(mp);
}

/**
 * The `state.mp === mp` checks drop a result that arrives after Solo (or a
 * return to the menu) replaced this session.
 */
function loadAndConnect(mp) {
  loadSocketIo(CONFIG.serverUrl, mp.connectDeadline).then(
    (ioFactory) => { if (state.mp === mp) connectSocket(ioFactory); },
    () => onSocketIoLoadFailed(mp),
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
 * stays cached. The pending promise rejects; its callers ignore that, since
 * `state.mp` has changed by then.
 */
function cancelSocketIoLoad() {
  if (socketIoCancel !== null) socketIoCancel();
}

/**
 * The cached load may be the background one, with an earlier deadline than
 * this attempt's, so another load is started while this budget allows.
 */
function onSocketIoLoadFailed(mp) {
  // Ignored if the user went back to solo meanwhile, or another attempt connected.
  if (state.mp !== mp || state.phase !== 'connecting' || mpSocket !== null) return;
  const delay = retryDelayWithin(performance.now(), mp.connectDeadline, MP_CONSTANTS.wakeRetryDelayMs);
  if (delay === null) {
    leaveMultiplayer('UNREACHABLE');
    return;
  }
  clearTimeout(connectRetryTimer);
  connectRetryTimer = setTimeout(() => {
    connectRetryTimer = 0;
    if (state.mp === mp) loadAndConnect(mp);
  }, delay);
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
  const intent = state.mp.intent;
  const isJoin = intent !== null && intent.type === 'join';
  // With a timeout, a server that never answers still ends in a clear message.
  socket.timeout(MP_CONSTANTS.joinAckTimeoutMs).emit(
    isJoin ? 'room:join' : 'room:create',
    isJoin ? { code: intent.code } : {},
    (error, ack) => {
      if (!isCurrentSocket(socket)) return;
      if (error) {
        leaveMultiplayer('UNREACHABLE');
        return;
      }
      onEntryAck(ack);
    },
  );
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

/** The room:create or room:join answer. */
function onEntryAck(raw) {
  // Connected: no waking notice or connect retry may follow, whatever the answer.
  clearConnectTimers();
  const ack = validateJoinAck(raw);
  if (ack === null) {
    leaveMultiplayer('BAD_RESPONSE'); // generic message
    return;
  }
  if (state.phase !== 'connecting') return;
  const mp = state.mp;
  const intent = mp.intent || { type: 'create' };
  const isJoin = intent.type === 'join';

  if (!ack.ok) {
    // A wrong, full or busy room is the user's to fix: back to the menu with
    // the code kept. Anything else ends multiplayer, as before.
    const code = ack.error.code;
    // An invite to a room that does not exist (or a malformed one) is dead:
    // drop it from the address bar, or leaving multiplayer would offer it
    // again. A full or busy room, or a network error, may work later: kept.
    if (isJoin && (code === 'ROOM_NOT_FOUND' || code === 'BAD_CODE') &&
        parseRoomHash(window.location.hash) === intent.code) {
      replaceHash(null);
      inviteCode = null;
    }
    const field = menuFieldFor(code, intent.type);
    if (field === null) leaveMultiplayer(code);
    else returnToMenu({ code, field, codeDraft: isJoin ? intent.code : '' });
    return;
  }

  const room = ack.room;
  mp.session.playerId = ack.playerId;
  mp.session.room = room;
  state.phase = 'waiting';
  inviteCode = null; // used
  setLobbyDeadline(room);
  replaceHash(room.code);
  renderAll();

  // Delayed, so the focus move settles first. The race rule is not in these:
  // it is said at the first countdown (onRaceCountdown).
  const spelled = spellRoomCode(room.code);
  if (isJoin) {
    dom.raceTitle.focus();
    announceSoon(`Joined room ${spelled}. ` + (room.phase === 'finished'
      ? 'The others are on their results. You will race in the next one.'
      : 'Waiting for the host to start the race.'));
  } else {
    dom.copyLinkBtn.focus();
    announceSoon(`Room ${spelled} created. Share the invite link. You can start the race when another player joins.`);
  }
}

/**
 * Back to the menu in multiplayer: a create or join error (shown inline, the
 * code kept in the input), or Leave room. The socket is closed; the script
 * stays loaded, so the next attempt is fast.
 */
function returnToMenu({ code = null, field = null, codeDraft = '' } = {}) {
  teardownSocket();
  stopRaceTimers();
  state = createRaceState(newSession());
  state.mp.menuError = code ? { code, field } : null;
  state.mp.codeDraft = codeDraft || '';
  renderAll();
  renderMenuInput();
  // The input's aria-describedby includes the error, so focus reads it.
  if (field === 'join') dom.roomCodeInput.focus();
  else if (field === 'create') dom.createRoomBtn.focus();
}

function leaveRoom() {
  if (state.mode !== 'multi' || state.phase !== 'waiting') return;
  returnToMenu();
  replaceHash(null);
  dom.createRoomBtn.focus();
  announceSoon('You left the room.');
}

/**
 * The lobby deadline from a snapshot's expiresInMs. A snapshot that leaves
 * the deadline where it was (a leave, a ready change: only latency apart)
 * keeps the warning as it is; a later one (join, Stay in room, back to
 * waiting) hides it and schedules a new one; a clearly earlier one (this
 * device slept and its clock fell behind) corrects it so the warning is not
 * late. Returns true only when it hid a showing warning because the room
 * stays open longer, so the caller can say so; never when the room left
 * waiting (next === null), which has its own announcement.
 */
function setLobbyDeadline(room) {
  const mp = state.mp;
  const next = room.expiresInMs === null ? null : performance.now() + room.expiresInMs;
  if (next !== null && mp.lobbyDeadline !== null) {
    const shift = next - mp.lobbyDeadline;
    // Snapshots of one deadline differ by latency either way; within the
    // warning's own safety margin that is jitter, which must never hide and
    // repeat the warning.
    if (Math.abs(shift) < MP_CONSTANTS.lobbyWarningMarginMs) return false;
    if (shift < 0) {
      // Earlier: the warning (shown or not) stays as it is, only sooner.
      mp.lobbyDeadline = next;
      scheduleLobbyWarning(); // fires now if already due
      return false;
    }
  }
  const hidesWarning = mp.lobbyWarned;
  mp.lobbyDeadline = next;
  mp.lobbyWarned = false;
  scheduleLobbyWarning();
  // Stay in room is about to be hidden; focus on it would fall to <body>.
  if (hidesWarning && document.activeElement === dom.extendBtn) dom.raceTitle.focus();
  return hidesWarning && next !== null;
}

/** Warns ahead of the server closing an idle lobby (WCAG 2.2.1). */
function scheduleLobbyWarning() {
  const mp = state.mp;
  clearLobbyWarnTimer();
  if (mp.lobbyWarned || mp.lobbyDeadline === null) return;
  const delay = mp.lobbyDeadline - MP_CONSTANTS.lobbyWarningMs -
    MP_CONSTANTS.lobbyWarningMarginMs - performance.now();
  mp.lobbyWarnTimerId = setTimeout(() => {
    mp.lobbyWarnTimerId = null;
    if (state.mp !== mp || state.phase !== 'waiting' || mp.lobbyDeadline === null) return;
    mp.lobbyWarned = true;
    renderLobby();
    renderRacePanel();
    // Repeatable: the live region may still hold this text from the last
    // warning, which a plain write would not make screen readers read again.
    announceRepeatable(LOBBY_WARNING);
  }, Math.max(0, delay));
}

/**
 * Background tabs throttle timers, so the warning can be late or not yet
 * fired. On return, schedule it again from the deadline: it fires now if due.
 */
function recheckLobbyWarning() {
  const mp = state.mp;
  if (state.mode !== 'multi' || state.phase !== 'waiting' || mp.lobbyWarned || mp.lobbyDeadline === null) return;
  scheduleLobbyWarning();
}

/* 12.4 Server events */

function onRoomState(raw) {
  const room = validateRoomState(raw);
  if (room === null || state.phase === 'menu' || state.phase === 'connecting') return;
  const mp = state.mp;
  const selfId = getSelfId();
  const prev = mp.session.room;
  const prevCanStart = prev !== null && canStartRace(prev, selfId);
  mp.session.room = room;
  // A failed start's message belongs to the old snapshot.
  mp.startStatus = '';

  // The host started the next race while this player was still on their
  // results: they sit it out in the room lobby.
  if (state.phase === 'finished' && isSittingOut(room, selfId)) {
    enterSittingOut();
    return;
  }

  // The server has this player ready, so it handled their Race again even if
  // the ack is late, lost or timed out: go to the lobby as the ack would.
  // Without this the server would seat them in the next race while they sit
  // on their results. The new state drops a late ack (its `state.mp === mp`
  // guard).
  if (state.phase === 'finished' && room.phase === 'finished' && findSelf(room, selfId)?.ready === true) {
    enterWaiting(rematchBackText());
    return;
  }
  // The same, found only once the host has started: the server seated this
  // player. race:countdown follows straight away and takes them from the
  // results card to the countdown (isSeatedForCountdown), so nothing is said
  // here that would only delay "Race starting".
  if (state.phase === 'finished' && room.phase === 'countdown' && findSelf(room, selfId)?.inRace === true) {
    return;
  }

  // Countdown -> waiting: too few racers were left to start.
  // Finished -> waiting: normally the rematch ack has already moved this
  // player to the lobby; this is the fallback.
  if (room.phase === 'waiting' && (state.phase === 'countdown' || state.phase === 'finished')) {
    enterWaiting(state.phase === 'countdown'
      ? 'A player left, so the race was cancelled. Back in the room.'
      : rematchBackText());
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

  // One announcement per snapshot, built from parts in a fixed order.
  const parts = [];
  // A player who sat the race out has no race:end, so this snapshot is the
  // only sign it ended.
  if (state.phase === 'waiting' && isSittingOut(prev, selfId) &&
      (room.phase === 'finished' || room.phase === 'waiting')) {
    parts.push('The race is over.');
  }
  if (state.phase === 'waiting' && prev !== null) parts.push(...membershipTexts(prev, room, selfId));
  // Someone else's join or Stay in room hid the warning. This player's own
  // Stay in room is said by onExtendAck, so it is not said twice here.
  if (state.phase === 'waiting' && setLobbyDeadline(room) && room.phase === 'waiting' && !mp.extendRequested) {
    parts.push('The room stays open.');
  }
  if (state.phase === 'running') parts.push(...departureTexts(room));
  const hostText = hostChangeText(prev, room, selfId, state.phase);
  if (hostText) parts.push(hostText);
  if (state.phase === 'waiting' && !hostText && room.hostId === selfId &&
      !prevCanStart && canStartRace(room, selfId)) {
    parts.push('You can start the race now.');
  }

  // Focus never moves for a host change: the new host's Start race appears
  // in place, and the old host is the one who left.
  if (state.phase === 'finished') {
    // Moves "(host)" on the results list (at most a few rows, only then).
    if (prev !== null && prev.hostId !== room.hostId) renderRaceResults();
    setResultsStatus(rematchStatus(room), parts.join(' '));
  } else {
    announceAfterPending(parts.join(' '));
  }
  renderRacePanel();
  renderRaceTracks();
  renderLobby();
}

/** "Player N joined the room." / "Player N left the room." against `prev`. */
function membershipTexts(prev, room, selfId) {
  const texts = [];
  const nowIds = new Set(room.players.map((player) => player.id));
  const prevIds = new Set(prev.players.map((player) => player.id));
  for (const player of prev.players) {
    if (player.id !== selfId && !nowIds.has(player.id)) {
      texts.push(`${labelFor(player.id, selfId, prev.players)} left the room.`);
    }
  }
  for (const player of room.players) {
    if (player.id !== selfId && !prevIds.has(player.id)) {
      texts.push(`${labelFor(player.id, selfId, room.players)} joined the room.`);
    }
  }
  return texts;
}

/**
 * Sets the results-card status line and announces it when it changes to a
 * new, non-empty text (#res-best is not a live region). room:state and the
 * rematch ack often repeat the same text, which is then not read twice.
 * race:end and room:state arrive back to back, so while "Race over…" is
 * still pending the status joins it: one message, in the right order.
 * `lead` (a host change) is said first, in the same message.
 */
function setResultsStatus(next, lead = '') {
  const mp = state.mp;
  const changed = next !== mp.resultsStatus;
  if (changed) {
    mp.resultsStatus = next;
    renderRaceResultsStatus();
  }
  const spoken = changed && next !== STATUS_BACK_TO_ROOM ? next : '';
  announceAfterPending([lead, spoken].filter(Boolean).join(' '));
}

/** "Player N left the race.", once per player per race. */
function departureTexts(room) {
  const mp = state.mp;
  const selfId = getSelfId();
  const texts = [];
  for (const player of room.players) {
    if (player.id === selfId || !player.inRace || player.connected || mp.departed[player.id]) continue;
    mp.departed[player.id] = true;
    texts.push(`${labelFor(player.id, selfId, room.players)} left the race.`);
  }
  return texts;
}

/** Back to the room lobby view with no passage, keeping the session. */
function enterWaiting(message) {
  // The typing area and results card are about to be hidden; focus inside them
  // would fall to <body>, so it goes to the race heading instead.
  const focusWillBeLost = isFocusIn(dom.typingArea) || isFocusIn(dom.results);
  stopRaceTimers();
  state = createRaceState(state.mp.session);
  state.phase = 'waiting';
  setLobbyDeadline(state.mp.session.room);
  renderAll();
  if (focusWillBeLost) dom.raceTitle.focus();
  announceSoon(message);
}

/**
 * The host started without this player: results card -> room lobby view.
 * New state, so the rematch warning timer is cleared and a late rematch ack
 * is dropped by its `state.mp === mp` guard.
 */
function enterSittingOut() {
  const focusWillBeLost = isFocusIn(dom.results) || isFocusIn(dom.typingArea);
  stopRaceTimers();
  state = createRaceState(state.mp.session);
  state.phase = 'waiting';
  setLobbyDeadline(state.mp.session.room); // null: the room is not waiting
  renderAll();
  if (focusWillBeLost) dom.raceTitle.focus();
  announceSoon(SIT_OUT_MESSAGE);
}

/**
 * Race events go to the whole room; a player who sits out ignores them.
 * race:start, race:update, player:finish and race:end also need the client
 * phase (countdown or running) that only a seated race:countdown leads to
 * (see isSeatedForCountdown); this is the second line of defence.
 */
function isSatOut() {
  const room = state.mp.session.room;
  if (room === null) return false;
  const selfId = getSelfId();
  if (isSittingOut(room, selfId)) return true;
  const self = findSelf(room, selfId);
  return state.phase === 'waiting' && self !== null && !self.inRace;
}

/**
 * A positive seat check: room:state with the countdown always comes first, so
 * the stored room must be counting down with this player in it. From the
 * lobby view, a repeated countdown, or the results card: there, inRace means
 * the server handled a Race again whose ack was lost or late (it clears ready
 * for every racer at race end, so only a rematch seats them). A player on
 * their results who was not seated has been moved to the lobby by that
 * room:state (enterSittingOut).
 */
function isSeatedForCountdown() {
  if (state.phase !== 'waiting' && state.phase !== 'countdown' && state.phase !== 'finished') return false;
  const room = state.mp.session.room;
  if (room === null || room.phase !== 'countdown') return false;
  const self = findSelf(room, getSelfId());
  return self !== null && self.inRace === true;
}

function onRaceCountdown(raw) {
  const data = validateCountdown(raw);
  if (data === null || !isSeatedForCountdown()) return;

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
  // The rule is said at the first countdown of the session. It is marked as
  // spoken only once actually written, so a cancelled message (state replaced
  // within the delay) leaves it to be said at the next countdown.
  const session = state.mp.session;
  if (session.instructionsSpoken) {
    announceSoon(`${start} Get ready to type.`);
  } else {
    announceSoon(`${start} Fix every mistake to finish.`, () => { session.instructionsSpoken = true; });
  }
}

function onRaceStart(raw) {
  const data = validateRaceStart(raw);
  if (data === null || state.phase !== 'countdown' || isSatOut()) return;

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
  if (data === null || state.phase !== 'running' || isSatOut()) return;
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
  if (data === null || state.phase !== 'running' || isSatOut()) return;
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
  if (data === null || state.phase !== 'running' || isSatOut()) return;
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
 * Errors for events without an ack. Only IDLE_TIMEOUT and ROOM_EXPIRED need
 * handling: the server closes the socket right after them, and that
 * disconnect should say why. Anything else is logged only.
 */
function onGameError(raw) {
  const code = raw && typeof raw.code === 'string' ? raw.code.slice(0, 64) : 'UNKNOWN';
  if (code === 'IDLE_TIMEOUT' || code === 'ROOM_EXPIRED') {
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

/**
 * Background tabs throttle timers to 1 s or more: send what is buffered on
 * the way out, and catch up on the lobby warning on the way back.
 * Registered only when MP_ENABLED.
 */
function handleVisibilityChange() {
  if (state.mode !== 'multi') return;
  if (document.visibilityState === 'hidden') {
    if (state.phase === 'running') flushKeys();
  } else {
    recheckLobbyWarning();
  }
}

/* 12.6 Rematch, start and Stay in room */

function requestRematch() {
  const mp = state.mp;
  if (state.phase !== 'finished' || mp.rematchRequested || mpSocket === null) return;

  mp.rematchRequested = true;
  clearRematchWarnTimer();
  setResultsStatus(STATUS_BACK_TO_ROOM);
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
  // Race again always leads to the room lobby view, whether the room is
  // still finished or already waiting.
  mp.session.room = ack.room;
  enterWaiting(rematchBackText());
}

/** Start race (host only, in the lobby view). */
function requestStart() {
  const mp = state.mp;
  const room = mp.session.room;
  const selfId = getSelfId();
  if (state.phase !== 'waiting' || room === null || room.hostId !== selfId || mpSocket === null) return;
  // The button is aria-disabled, not disabled, so a press lands here: say why.
  if (!canStartRace(room, selfId)) {
    announceRepeatable(startHint(room, selfId) || errorMessage('NOT_ENOUGH_PLAYERS'));
    return;
  }
  if (mp.startRequested) return;

  mp.startRequested = true;
  mp.startStatus = '';
  renderLobby();
  renderRacePanel();
  const socket = mpSocket;
  socket.timeout(MP_CONSTANTS.ackTimeoutMs).emit('room:start', {}, (error, ack) => {
    if (!isCurrentSocket(socket) || state.mp !== mp) return;
    onStartAck(error ? null : ack);
  });
}

/** Success needs nothing here: race:countdown follows and replaces `state`. */
function onStartAck(raw) {
  const ack = validateStartAck(raw);
  if (ack !== null && ack.ok) return;
  const mp = state.mp;
  mp.startRequested = false;
  // A timeout or a bad ack gets the generic message.
  mp.startStatus = errorMessage(ack === null ? 'BAD_RESPONSE' : ack.error.code);
  renderLobby();
  renderRacePanel();
  announceRepeatable(mp.startStatus);
}

/** Stay in room, shown with the lobby warning. */
function requestExtend() {
  const mp = state.mp;
  if (state.phase !== 'waiting' || !mp.lobbyWarned || mp.extendRequested || mpSocket === null) return;
  mp.extendRequested = true;
  renderLobby();
  const socket = mpSocket;
  socket.timeout(MP_CONSTANTS.ackTimeoutMs).emit('room:extend', {}, (error, ack) => {
    if (!isCurrentSocket(socket) || state.mp !== mp) return;
    onExtendAck(error ? null : ack);
  });
}

function onExtendAck(raw) {
  const ack = validateRoomAck(raw);
  const mp = state.mp;
  mp.extendRequested = false;
  if (ack === null || !ack.ok) {
    // The button stays, so the user can try again. startStatus is the
    // lobby's one line for a failed action.
    mp.startStatus = errorMessage(ack === null ? 'BAD_RESPONSE' : ack.error.code);
    renderLobby();
    renderRacePanel();
    announceRepeatable(mp.startStatus);
    return;
  }
  mp.session.room = ack.room;
  mp.startStatus = '';
  setLobbyDeadline(ack.room); // hides the warning (and moves focus off Stay in room)
  renderLobby();
  renderRacePanel();
  renderRaceTracks();
  if (ack.room.expiresInMs !== null) {
    const minutes = Math.round(ack.room.expiresInMs / 60000);
    announceSoon(`The room stays open for ${minutes} more minute${minutes === 1 ? '' : 's'}.`);
  }
}

/* 12.7 Invite links and the menu */

// Shown when the link could not be copied for the user (no clipboard access,
// or an insecure page): it is selected in the read-only field instead.
const COPY_FALLBACK_TEXT = "The link is selected. Copy it with your device's copy command.";

function copyInviteLink() {
  const mp = state.mp;
  const room = mp && mp.session.room;
  if (state.phase !== 'waiting' || !room) return;
  const link = buildShareLink(window.location.href, room.code);
  if (link === null) return;

  const report = (text) => {
    mp.copyStatus = text;
    renderLobby();
    announceRepeatable(text);
  };
  const fallback = () => {
    if (state.mp !== mp) return;
    dom.roomLink.focus();
    if (typeof dom.roomLink.select === 'function') dom.roomLink.select();
    report(COPY_FALLBACK_TEXT);
  };
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (!clipboard || typeof clipboard.writeText !== 'function' || !window.isSecureContext) {
    fallback();
    return;
  }
  try {
    clipboard.writeText(link).then(() => {
      if (state.mp === mp) report('Invite link copied.');
    }, fallback);
  } catch {
    fallback();
  }
}

/**
 * Puts the room's invite link in the address bar (or removes it), without
 * a reload and without firing hashchange. Fails quietly where history is
 * unavailable.
 */
function replaceHash(code) {
  try {
    const location = window.location;
    // '' keeps the path and query and drops the hash.
    const url = code
      ? buildShareLink(location.href, code)
      : (location.pathname || '') + (location.search || '');
    if (url !== null) window.history.replaceState(null, '', url);
  } catch {
    // No history API, or a sandbox that refuses it: the URL just stays as it is.
  }
}

/** An invite link pasted into this tab's address bar. Ignored in a room. */
function handleHashChange() {
  const code = parseRoomHash(window.location.hash);
  if (code === null) return;
  if (state.mode === 'solo') {
    inviteCode = code;
    renderInvite();
  } else if (state.phase === 'menu') {
    state.mp.codeDraft = code;
    renderMenuInput();
  }
}

function handleJoinSubmit(event) {
  event.preventDefault();
  if (state.mode !== 'multi' || state.phase !== 'menu') return;
  const value = dom.roomCodeInput.value; // user input, read as typed
  const error = roomCodeInputError(value);
  if (error) {
    // Focus stays in the input, so the error is announced instead.
    state.mp.menuError = { code: 'INPUT', field: 'join', text: error };
    renderMenu();
    announceRepeatable(error);
    return;
  }
  connectToRoom({ type: 'join', code: normalizeRoomCode(value) });
}

function handleInviteJoin() {
  if (inviteCode === null || state.mode !== 'solo') return;
  const code = inviteCode;
  inviteCode = null;
  startMultiplayer({ announceMenu: false });
  connectToRoom({ type: 'join', code });
}

function handleInviteDismiss() {
  inviteCode = null;
  replaceHash(null);
  renderInvite();
  // The banner that had focus is hidden. A link pasted while solo results
  // show has no visible input to go to, so focus goes to what is on screen.
  if (state.mode === 'solo' && state.phase !== 'finished') focusInput();
  else if (state.phase === 'finished') dom.resultsTitle.focus();
  else dom.modeButtons[0].focus();
}

/* 12.8 Leaving and the mode switch */

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
  if (state.mp.session.room !== null) {
    replaceHash(null); // the room is gone; an old link must not look current
  } else {
    // Never entered a room, so an invite in the address bar was not used: it
    // survives, and the banner (drawn by restart) matches it again.
    inviteCode = parseRoomHash(window.location.hash);
  }
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
