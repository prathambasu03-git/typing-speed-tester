# PLAN: Multiplayer M1, one room races end to end

## 1. Goal

Two players open the app, choose **Multiplayer**, and race the same passage in
one shared room. Each sees both players' live progress and, at the end, the
server's results and finish order, then can race again. Solo mode is unchanged
and still works with no server.

## 2. Assumptions

- **One fixed room** (`ROOM_ID = 'main'`), no codes, no lobby. Anyone who
  opens Multiplayer joins it. `MAX_PLAYERS = 2` and `MIN_PLAYERS = 2` are
  constants; nothing else hard-codes "2".
- **The race starts automatically** when the room has `MIN_PLAYERS` ready
  players. Joining counts as ready; after a race each player presses
  "Race again" (rematch) to become ready again.
- **No player names in M1.** The client labels players itself: "You" and
  "Opponent" (or "Opponent 2" if the cap is raised). This avoids rendering
  any user text from the server. Names arrive with the M2 lobby.
- **The passage is finite** (30 words from `WORDS`), not the infinite solo text.
  A player **finishes only when every passage character is correct**; at the
  end of the passage with mistakes, they must Backspace and fix them. This
  stops random key mashing from winning.
- **Multiplayer results are not saved** to `typing:history` or `typing:best`.
  Those stay solo-only (saved results are M4). No new `localStorage` keys.
- **Server URL:** a `<meta name="typing-server-url" content="http://localhost:3000">`
  tag in `index.html`, read once by `resolveServerUrl()`. M5 changes the
  `content` to the deployed URL. A query-string override is deliberately
  **not** supported: the client runs a script from that URL, so a link could
  otherwise inject code into the page.
- **Multiplayer needs the page served over http(s)** (GitHub Pages or a local
  static server). Pages opened from `file://` send `Origin: null`, which the
  server refuses unless `ALLOW_NULL_ORIGIN=true` (local dev only). Solo still
  works from `file://`.
- **Progress is sent as keystrokes, not as the typed text.** See Design 4.2.
- **Node 20.12 or later** for the server (`process.loadEnvFile`,
  `String.prototype.isWellFormed`), so no `dotenv` dependency is needed.

## 3. Current state

- `index.html`: loads `words.js`, `stats.js`, `script.js` with `defer`.
  Toolbar has `#settings` (duration buttons with `aria-pressed`) and the live
  stats `<dl>`; `#typing-area` holds the char spans, `#hidden-input`,
  `#typing-hint`, `#restart-inline`; `#results` card; `#history` card;
  `#announcer` (`aria-live="polite"`, `aria-atomic="true"`).
- `words.js`: top-level `const WORDS` (frozen array). **No Node export.**
- `stats.js`: pure `DURATIONS`, `isValidDuration`, `isValidRecord`,
  `randomWords`, `generateChars`, `calculateWpm`, `calculateAccuracy`,
  `computeStats(snapshot, elapsedMs)`; exports via a `typeof module` guard.
  `computeStats` takes `{ results, totalKeystrokes, correctKeystrokes, duration }`
  and floors accuracy.
- `script.js`:
  - `CONFIG`, `STORAGE_KEYS`, `dom` lookup.
  - `createInitialState(duration)` returns the solo `state` (`phase`
    `'idle' | 'running' | 'finished'`, `chars`, `index`, `results`,
    `timeLeft`, `startTime`, `intervalId`, `totalKeystrokes`,
    `correctKeystrokes`). `restart()` replaces `state` with a new one.
  - `prefs` and the announce timer handles live outside `state` because
    `restart()` replaces it.
  - Render functions: `renderText`, `renderWordsText`, `renderChar`,
    `renderCaret`, `renderPhase`, `renderSettings`, `renderTimer`,
    `renderLiveStats`, `renderBest`, `renderResults`, `renderHistory`,
    `renderAll`, `announce`.
  - Flow: `handleKeydown`/`handleMobileInput` → `handleCharacter` /
    `handleBackspace` → `startTest` on first key → `tick` (100 ms, display
    only, time from `performance.now()`) → `finishTest` → `saveResult`.
  - `extendTextIfNeeded` appends words near the end (infinite text).
  - Escape restarts; `#restart-inline` and `#restart-btn` call `restart()`.
- `tests/stats.test.js`: `node --test` suite for `stats.js`, including a
  `vm` check that `stats.js` and `words.js` run as classic scripts, and an
  assertion that `globalThis.WORDS` is undefined in Node.
- No `server/` directory exists.

## 4. Design

### 4.1 Sharing logic between client and server

The server reuses the root `stats.js` (`computeStats`, `generateChars`) and
`words.js` (`WORDS`), so WPM and accuracy are computed by the **same code** on
both sides:

- `words.js` gets a `typeof module` export guard, like `stats.js`.
- `server/src/shared.js` is the **only** server file that reaches outside
  `server/`: `require('../../stats.js')` and `require('../../words.js')`, and
  re-exports `{ computeStats, generateChars, WORDS }`.
- Risk for M5: the Docker build context must be the repo root (or copy those
  two files in). Isolating the paths in `shared.js` keeps that a one-file change.

### 4.2 Progress model: keystroke deltas

The client sends `race:progress { seq, keys }`, where `keys` is the
keystrokes since the last event (each code point one key, `'\b'` for
Backspace). The server replays them against its own passage with `applyKeys`,
which mirrors `handleCharacter`/`handleBackspace`.

Why keystrokes and not the typed text so far:

- **Accuracy needs history.** Solo accuracy counts every keystroke, including
  mistakes later fixed. A snapshot of the current text loses that; a keystroke
  stream keeps it, so the server can compute `correctKeystrokes /
  totalKeystrokes` itself.
- **Bounded work and size.** Each event is at most 64 units and costs O(keys)
  on the server, whatever the passage length. Sending the whole typed text
  grows with progress.
- **Authority.** The server decides what is correct, where the caret is, and
  when the passage is complete. The client cannot claim a position.
- **Ready for M3.** Anti-cheat can later look at the key stream timing per
  event.

Trade-off: a dropped event (rate limit) desyncs the server from the client.
Normal clients cannot trip the limit (see 4.6), so M1 accepts this. Results are
always the server's numbers.

### 4.3 Server layout (`server/`)

```
server/
  package.json          scripts: start, test; engines node >=20.12
  .env.example          every env variable, with safe defaults
  .gitignore            node_modules/, .env
  src/
    index.js            entry: load config, createServer(config).listen(PORT)
    config.js           loadConfig(env) -> frozen config; process.loadEnvFile in try/catch
    constants.js        protocol constants (PROTOCOL.md section 2), frozen
    shared.js           require ../../stats.js and ../../words.js
    origin.js           isAllowedOrigin(origin, config) (pure)
    validate.js         validateJoin, validateProgress, validateRematch (pure)
    rateLimit.js        createBucket, takeToken (pure, injected now)
    race.js             room state machine and scoring (pure, injected now)
    roomStore.js        in-memory store: getRoom, saveRoom, deleteRoom
    game.js             Socket.io wiring, timers, broadcasts
    app.js              createServer(options): Express + http + Socket.io
  test/                 server-tester only
```

Module responsibilities and signatures:

- **`constants.js`**: `MAX_PLAYERS 2`, `MIN_PLAYERS 2`, `COUNTDOWN_MS 3000`,
  `RACE_TIME_LIMIT_MS 120000`, `PASSAGE_WORD_COUNT 30`,
  `PASSAGE_MAX_LENGTH 1000`, `MAX_KEYS_PER_EVENT 64`,
  `BROADCAST_INTERVAL_MS 200`, `RATE_LIMIT_CAPACITY 20`,
  `RATE_LIMIT_REFILL_PER_SEC 10`, `RATE_LIMIT_ERROR_INTERVAL_MS 1000`,
  `SEQ_MAX 2147483647`, `BACKSPACE '\b'`, `ROOM_ID 'main'`,
  `MAX_HTTP_BUFFER_SIZE 4096`, `ERROR_CODES` (frozen map of the codes in
  PROTOCOL.md section 7).
- **`config.js`**: `loadConfig(env = process.env)` returns
  `{ port, corsOrigins: string[], allowLocalhost, allowNullOrigin,
  maxConnectionsPerIp }`. Invalid values fall back to defaults with a
  `console.warn`. Calls `process.loadEnvFile('.env')` inside `try/catch` (a
  missing file is fine).
- **`origin.js`**: `isAllowedOrigin(origin, { corsOrigins, allowLocalhost,
  allowNullOrigin }) -> boolean`. Rules in PROTOCOL.md section 1. Localhost
  regex: `/^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/`.
- **`validate.js`**: `isPlainObject(v)`, `validateJoin(payload)`,
  `validateRematch(payload)`, `validateProgress(payload)`. Each returns
  `{ ok: true, value }` or `{ ok: false, code: 'BAD_PAYLOAD', message }`.
  `validateProgress` enforces `seq` integer in `1..SEQ_MAX`, `keys` string of
  length `1..MAX_KEYS_PER_EVENT`, `keys.isWellFormed()`, and no character in
  `/[\u0000-\u0007\u0009-\u001F\u007F-\u009F]/`.
- **`rateLimit.js`**: `createBucket(capacity, refillPerSec, now) ->
  { tokens, updatedAt, capacity, refillPerSec }`;
  `takeToken(bucket, now) -> boolean` (refills from elapsed time, capped at
  capacity, then takes one token if available). Mutates the bucket; no timers.
- **`race.js`** (all pure; `now` is passed in, never read from a clock;
  randomness comes from the `pickPassage` function passed to `game.js`):
  - `createRoom(id, { maxPlayers, minPlayers }) -> Room`
  - `addPlayer(room, { id, socketId }) -> { ok: true, player } | { ok: false, code }`
    (checks `ALREADY_JOINED` by socketId, then `ROOM_FULL`, then
    `RACE_IN_PROGRESS`; assigns the lowest free `slot`; `ready: true`)
  - `removePlayer(room, socketId, now) -> { removed: boolean, player }`
    (racing: mark `connected = false`, `leftAt = now`, `room.dirty = true`;
    otherwise remove from the array)
  - `setReady(room, socketId) -> { ok, code? }`
  - `shouldStartCountdown(room) -> 'countdown' | 'waiting' | null` (the start
    check in PROTOCOL.md section 3)
  - `beginCountdown(room, passage, now, countdownMs)`: sets phase, passage
    (array of chars), `startAt = now + countdownMs`, `finishCount = 0`, resets
    every player's race fields.
  - `beginRace(room)`: phase `racing`.
  - `applyKeys(room, player, keys, now) -> { changed: boolean, finished: boolean }`
    (PROTOCOL.md section 4, `race:progress`). Iterate with `for (const ch of keys)`.
    Keep `correctCount` and `incorrectCount` per player so the finish check is
    O(1).
  - `isRaceOver(room) -> boolean` (at least one connected player, and every
    connected player has finished).
  - `buildProgress(room, now) -> { elapsedMs, players: ProgressEntry[] }`
  - `buildResults(room, now) -> ResultEntry[]` (PROTOCOL.md section 6).
  - `endRace(room)`: phase `finished`, drop disconnected players, reset `ready`.
  - `toSnapshot(room) -> RoomSnapshot`.
  - Player shape:
    `{ id, socketId, slot, connected, ready, index, results: (null|'correct'|'incorrect')[],
       totalKeystrokes, correctKeystrokes, correctCount, incorrectCount,
       lastSeq, finishedAt, leftAt, place }`.
  - Room shape:
    `{ id, phase, maxPlayers, minPlayers, players: Player[], passage: string[] | null,
       startAt: number | null, finishCount, dirty }`.
- **`roomStore.js`**: `createMemoryRoomStore() -> { getRoom(id), saveRoom(room),
  deleteRoom(id), clear() }`. Synchronous `Map` in M1. Race logic only reaches
  rooms through this object. Note for M4/M5: a Redis store will be async, so
  `game.js` will need per-room serialization (a promise queue) at that point;
  do not add it now.
- **`game.js`**: `registerGame(io, options) -> { clearAllTimers() }` where
  `options` includes `store`, `now`, `pickPassage`, `countdownMs`,
  `raceTimeLimitMs`, `broadcastIntervalMs`, `rateLimit`. Responsibilities:
  - `socket.use` middleware: per-socket bucket (`takeToken`); when empty, drop
    the packet, answer the ack with `RATE_LIMITED` if the last argument is a
    function, else emit `game:error` `RATE_LIMITED` (throttled to one per
    `RATE_LIMIT_ERROR_INTERVAL_MS`).
  - Handlers `onJoin`, `onProgress`, `onRematch`, `onDisconnect`, each
    wrapped by `safeHandler(fn)` (try/catch, answers `INTERNAL`).
  - Uses `socket.join(ROOM_ID)` and `io.to(ROOM_ID).emit(...)`. A socket whose
    join failed is not in the Socket.io room and receives no broadcasts.
  - Timers in a `Map<roomId, { countdown, raceLimit, broadcast }>`;
    `clearRoomTimers(roomId)` on every phase exit and room deletion.
  - Emits in the exact order given in PROTOCOL.md.
  - Tracks `socket.data.playerId` and `socket.data.bucket`; nothing per socket
    outlives the `disconnect` handler.
  - Default `pickPassage = () => generateChars(PASSAGE_WORD_COUNT, WORDS).join('')`.
- **`app.js`**: `createServer(options) -> { app, httpServer, io, listen(port) ->
  Promise<number>, close() -> Promise<void> }`. Express with
  `app.disable('x-powered-by')` and `GET /health -> 200 { status: 'ok' }`.
  Socket.io options: `cors: { origin: (o, cb) => cb(null, isAllowedOrigin(o, cfg)) }`,
  `allowRequest` (origin check plus per-IP concurrent connection count from
  `req.socket.remoteAddress`, decremented on disconnect),
  `maxHttpBufferSize: 4096`, `serveClient: true`. `listen(0)` resolves to the
  real port, for tests. `close()` closes `io`, calls `clearAllTimers()`, and
  closes the HTTP server.
- **`index.js`**: `createServer({ ...loadConfig() }).listen(config.port)`,
  logs the port, and closes cleanly on `SIGINT`/`SIGTERM`.

Dependencies: `express` (^5), `socket.io` (^4.8). Dev: `socket.io-client`
(^4.8). Nothing else.

`.env.example`:

```
PORT=3000
# Comma-separated exact origins (no trailing slash, no path)
CORS_ORIGINS=https://prathambasu03-git.github.io
# Allow http://localhost:<any port> and http://127.0.0.1:<any port>
ALLOW_LOCALHOST=true
# Allow Origin: null (pages opened from file://). Local development only.
ALLOW_NULL_ORIGIN=false
MAX_CONNECTIONS_PER_IP=10
```

### 4.4 Room state machine

As specified in PROTOCOL.md section 3. The cases the brief asks about:

- **Player leaves during the countdown:** countdown timer cleared, passage
  dropped, phase back to `waiting`, `room:state` sent. The remaining client
  goes back to "Waiting for an opponent".
- **Player disconnects mid-race:** marked `connected: false` with `leftAt`;
  numbers frozen; `room:state` sent. The race continues for the others. If
  every remaining connected player has already finished, the race ends now.
  If nobody is connected, all timers are cleared and the room is deleted.
- **Third player:** `room:join` ack `{ ok: false, error: { code: 'ROOM_FULL' } }`
  (or `RACE_IN_PROGRESS` if a slot is free but a race is on, possible only if
  `MAX_PLAYERS > MIN_PLAYERS`). The client disconnects and falls back to solo
  with a message.
- **Rematch:** after `race:end`, each player presses "Race again"
  (`race:rematch`). When all players in the room are ready and there are at
  least `MIN_PLAYERS`, a new countdown starts with a new passage. If the
  opponent left, the remaining player's rematch moves the room to `waiting`,
  and the next joiner starts a countdown.

### 4.5 Client design

**New file `multiplayer.js`** (pure, no DOM, no `window`, classic script with a
`typeof module` export guard, loaded after `stats.js` and before `script.js`):

- `MP_CONSTANTS` (frozen): `progressIntervalMs: 150`, `maxKeysPerEvent: 64`,
  `connectTimeoutMs: 5000`, `passageMaxLength: 1000`, `seqMax: 2147483647`,
  `backspace: '\b'`, `defaultServerUrl: 'http://localhost:3000'`,
  `milestones: [50]`.
- `resolveServerUrl(value) -> string | null`: `new URL(value)` in try/catch;
  only `http:`/`https:`; returns `url.origin`. `null` for empty, invalid or
  other protocols (`javascript:`, `data:`, `file:`).
- `appendKey(buffer, key, max) -> { buffer, flush }`: if
  `buffer.length + key.length > max`, returns `{ buffer: key, flush: buffer }`
  (send the old buffer now); else `{ buffer: buffer + key, flush: null }`.
- `validateRoomState(data)`, `validateCountdown(data)`, `validateRaceStart(data)`,
  `validateRaceUpdate(data)`, `validatePlayerFinish(data)`,
  `validateRaceEnd(data)`, `validateJoinAck(data)`, `validateRematchAck(data)`:
  each returns a clean copy of the payload (only known fields) or `null`,
  using the limits in PROTOCOL.md sections 4 and 5. `validateCountdown`
  rejects a passage with control characters or longer than `passageMaxLength`.
- `labelFor(playerId, selfId, players) -> string`: `'You'` for self, else
  `'Opponent'`, or `'Opponent N'` when there is more than one opponent
  (numbered 1..n in slot order).
- `ordinal(n) -> string`: `1 -> '1st'`, `2 -> '2nd'`, `3 -> '3rd'`,
  `4 -> '4th'`, `11 -> '11th'`, `12 -> '12th'`, `13 -> '13th'`,
  `21 -> '21st'`, `22 -> '22nd'`.
- `crossedMilestone(previous, current, milestones) -> number | null`: the
  highest milestone `m` with `previous < m <= current`, else `null`.
- `errorMessage(code) -> string`: client-owned text per error code, e.g.
  `ROOM_FULL -> 'The race room is full. Try again in a minute.'`,
  `RACE_IN_PROGRESS -> 'A race is already running. Try again in a minute.'`,
  `UNREACHABLE -> 'Could not reach the multiplayer server. You are playing solo.'`,
  `DISCONNECTED -> 'Lost connection to the multiplayer server. You are playing solo.'`,
  default `'Something went wrong with multiplayer.'`. (`UNREACHABLE` and
  `DISCONNECTED` are client-only codes, never sent by the server.)
- `formatRaceTime(ms) -> string`: `41300 -> '41.3s'`.

**`state` in multiplayer.** The single `state` object stays the source of
truth. New fields on every state:

- `mode: 'solo' | 'multi'` (solo state from `createInitialState` sets
  `'solo'`, `mp: null`).
- `wrongCount`: number of `'incorrect'` entries in `results`, kept up to date
  in `handleCharacter`/`handleBackspace` in both modes (O(1) finish check).

New `createRaceState(session, { passage, raceTimeLimitMs } = {})` returns:

```js
{
  mode: 'multi',
  phase: 'connecting',       // 'connecting' | 'waiting' | 'countdown' | 'running' | 'finished'
  chars: [],                 // passage chars (from race:countdown)
  index: 0, results: [], wrongCount: 0,
  totalKeystrokes: 0, correctKeystrokes: 0,
  duration: 0,               // race limit in whole seconds, for renderTimer
  timeLeft: 0, startTime: null, intervalId: null,
  mp: {
    session,                 // { playerId, room } carried between races
    countdownEndsAt: null,   // performance.now() based, display only
    raceTimeLimitMs: 0,
    seq: 0,                  // last seq sent
    pendingKeys: '',
    flushTimerId: null,
    localDone: false,        // local text matches the whole passage
    progress: {},            // id -> latest ProgressEntry from race:update
    milestones: {},          // id -> last announced milestone
    results: null,           // ResultEntry[] from race:end
    rematchRequested: false,
    resultsStatus: '',       // text for #res-best in multi (rematch status)
  },
}
```

`session = { playerId: string | null, room: RoomSnapshot | null }` survives
across races: each new countdown does
`state = createRaceState(state.mp.session, { passage, raceTimeLimitMs })`.
Before replacing `state`, always clear the old `intervalId` and
`mp.flushTimerId`.

The socket is a handle, not data, so it lives outside `state` as
`let mpSocket = null`, next to `resultAnnounceTimer`. So does
`let socketIoPromise = null` (the script loads once per page).

**Connection flow** (new section "12. Multiplayer" in `script.js`):

1. User presses **Multiplayer** → `startMultiplayer()`: stop any solo timer,
   hide `#mp-error`, `state = createRaceState({ playerId: null, room: null })`,
   `renderAll()`, status "Connecting to the multiplayer server…".
2. `loadSocketIo(serverUrl) -> Promise<Function>`: creates
   `<script src="${serverUrl}/socket.io/socket.io.js">` once (cached in
   `socketIoPromise`), resolves with `window.io` on `load` if
   `typeof io === 'function'`, rejects on `error` or after
   `connectTimeoutMs`. On reject, remove the script element and reset
   `socketIoPromise` to `null` so a later attempt retries.
3. `connectSocket(io)`: if `state.mode !== 'multi'` (user went back to solo
   while loading), do nothing. Else `io(serverUrl, { transports: ['websocket'],
   reconnection: false, timeout: MP_CONSTANTS.connectTimeoutMs })`; registers
   listeners for `connect`, `connect_error`, `disconnect`, `room:state`,
   `race:countdown`, `race:start`, `race:update`, `player:finish`,
   `race:end`, `game:error`.
4. On `connect`: `emit('room:join', {}, onJoinAck)`. On success store
   `playerId` and `room` in `state.mp.session`, phase `waiting`, announce
   "Connected. Waiting for an opponent." (or go straight on if a
   `race:countdown` follows).
5. Every listener first checks `state.mode === 'multi'` and that the socket
   is still `mpSocket` (ignores events from a socket being torn down), then
   validates the payload, updates `state`, and calls render functions.

**Fallback to solo:** `leaveMultiplayer(code)` is the single exit path. It
removes listeners, calls `mpSocket.disconnect()`, sets `mpSocket = null`,
clears `flushTimerId` and `intervalId`, then
`restart(loadDuration(), { message: '', moveFocus })` and, if `code` is given,
unhides `#mp-error` and writes `errorMessage(code)` into it. Called on:
script load failure or timeout (`'UNREACHABLE'`), `connect_error`
(`'UNREACHABLE'`), a failed join ack (its `error.code`), an unexpected
`disconnect` (`'DISCONNECTED'`), and pressing **Solo** or **Back to solo**
(no code, no message). `moveFocus` is `true` only when focus was inside
`#typing-area` (so a disconnect mid-race keeps the user able to type);
otherwise focus stays where it is.

**Event handling:**

- `room:state` → `session.room = room`. If `state.phase` is `countdown` and the
  room phase is `waiting` (opponent left during countdown): clear the
  interval, `state = createRaceState(session)` with phase `waiting`,
  `renderAll()`, announce "Your opponent left. Waiting for a new opponent.".
  If `state.phase` is `finished`, set `mp.resultsStatus` from the room:
  opponent gone → "Your opponent left. Press Race again to wait for a new
  one."; opponent ready and you not → "Your opponent wants a rematch.";
  you ready → "Waiting for your opponent to race again."; then
  `renderRaceResultsStatus()`. If an opponent's `connected` turned false
  during `running`, announce "Your opponent left the race." once. Always
  `renderRacePanel()`.
- `race:countdown` → clear old timers,
  `state = createRaceState(session, { passage, raceTimeLimitMs })`, phase
  `countdown`, `chars = passage.split('')` (the passage is ASCII words from
  `WORDS`, split exactly like the server's `generateChars`),
  `results = new Array(chars.length).fill(null)`, set `countdownEndsAt`,
  start `setInterval(tick, CONFIG.tickMs)`, `renderAll()`, focus the input,
  announce "Race starting in 3 seconds. Get ready to type." (seconds from
  `startsInMs`).
- `race:start` → phase `running`, `startTime = performance.now()`,
  `duration = Math.ceil(raceTimeLimitMs / 1000)`, `timeLeft = duration`,
  keep the interval, `renderPhase()`, `renderTimer()`, announce "Go!".
- `race:update` → store each entry in `state.mp.progress[id]`;
  `renderRaceTracks()`; for each **opponent**, if
  `crossedMilestone(prevProgress, entry.progress, MP_CONSTANTS.milestones)`
  is non-null and above `mp.milestones[id]`, announce "Opponent is halfway."
  and record it. Own progress is never announced.
- `player:finish` → for self: announce "You finished in 1st place.", status
  line "You finished 1st. Waiting for the race to end."; for an opponent:
  announce "Opponent finished in 1st place.".
- `race:end` → `state.mp.results = results`, phase `finished`, clear interval
  and flush timer, `renderPhase()`, `renderRaceResults()`, focus
  `#results-title`, then (after `CONFIG.resultAnnounceDelayMs`, like
  `finishTest`) announce "Race over. You placed 1st of 2. 62 words per minute,
  97 percent accuracy.".
- `game:error` → `RATE_LIMITED`, `BAD_PAYLOAD` and `INTERNAL` are logged with
  `console.warn` only; nothing is rendered.
- `disconnect` (any reason except one caused by `leaveMultiplayer`, which
  removes the listener first) → `leaveMultiplayer('DISCONNECTED')`.

**Typing in multiplayer** (changes to existing functions):

- `handleCharacter(key)`: in multi, return unless `phase === 'running'` and
  `!state.mp.localDone`; return if `index >= chars.length`; return if the
  local race time is up (the server ends the race); never call `startTest()`
  or `extendTextIfNeeded()`. After applying the key: `queueKey(key)`; if
  `index === chars.length && wrongCount === 0`, set `localDone = true` and
  `flushKeys()` immediately.
- `handleBackspace()`: in multi, return if `localDone` or phase is not
  `running`; after a real Backspace (index was > 0), `queueKey(MP_CONSTANTS.backspace)`.
- `handleKeydown`: Escape does nothing in multi (no accidental leave). The
  existing `phase === 'finished'` check stays; the new guards live in
  `handleCharacter`/`handleBackspace`.
- `tick()`: branch on mode. Multi `countdown`: status line "Race starts in N"
  (N = `Math.ceil((countdownEndsAt - now) / 1000)`, min 0), written only when
  N changes. Multi `running`: `timeLeft` from `startTime` and `duration`,
  `renderTimer()`, `renderLiveStats(elapsed)` (local estimate); at 0 clear the
  interval but do not finish (wait for `race:end`).

### 4.6 Throttling

**Client:** `queueKey(key)` calls `appendKey(state.mp.pendingKeys, key, 64)`.
If it returns `flush`, send that immediately (`sendProgress(flush)`). If no
`flushTimerId` is set, set `setTimeout(flushKeys, 150)`. `flushKeys()` clears
the timer, sends `pendingKeys` if non-empty, and resets it. So in normal
typing there is at most one `race:progress` per 150 ms (about 6.7 per
second), with three immediate flushes: buffer full (64 units in 150 ms means
over 5000 WPM, never a human), passage completed (so the finish time is not
delayed by up to 150 ms), and `visibilitychange` to hidden (background tabs
throttle timers to 1 s or more). `sendProgress(keys)` does
`state.mp.seq += 1; mpSocket.emit('race:progress', { seq: state.mp.seq, keys })`.

**Server inbound:** token bucket per socket, capacity 20, refill 10 per
second, shared by all events. A normal client uses about 6.7 per second, so it
never runs out; a flood is dropped at 10 per second. `maxHttpBufferSize` 4 KB
and the 64-unit `keys` cap bound each event.

**Server outbound:** `race:update` per room every 200 ms (5 per second), only
when `room.dirty` is set by `applyKeys`/disconnect, plus one final update at
race end. `player:finish` is sent immediately. The client renders each
`race:update` as it arrives with DOM writes only (no extra client throttle
needed at 5 per second).

### 4.7 UI elements

- **Mode switch** in the toolbar, before `#settings`:
  `<div id="mode" class="settings" role="group" aria-label="Game mode">` with
  `<button type="button" class="setting-btn" data-mode="solo" aria-pressed="true">solo</button>`
  and `<button ... data-mode="multi" aria-pressed="false">multiplayer</button>`.
  Hidden (`hidden`) if `multiplayer.js` failed to load, the meta URL is invalid,
  or the word list failed (`renderLoadError`).
- **Connection error:** `<p id="mp-error" class="load-error" role="alert" hidden></p>`
  directly after the toolbar section. Unhide before writing text (as
  `renderLoadError` does). Hidden again by `startMultiplayer()` and by
  `startTest()`.
- **Race panel** before `#typing-area`:
  `<section id="race-panel" class="race-panel card" aria-labelledby="race-title" hidden>`
  - `<h2 id="race-title" class="card-title">race</h2>`
  - `<p id="race-status" class="race-status"></p>`: "Connecting…",
    "Waiting for an opponent…", "Race starts in 3", "Go!",
    "You finished 1st. Waiting for the race to end.". **Not** a live region
    (the per-second countdown would be chatty); key moments go through
    `announce()`.
  - `<ul id="race-tracks" class="race-tracks" aria-label="Live progress"></ul>`,
    one `<li class="race-track">` per player, built with `createElement` by
    `renderRaceTracks()` when the set of player ids changes, then updated in
    place:
    - `<span class="race-name">` ("You" / "Opponent"),
    - `<span class="race-meta">` ("45% · 62 wpm", "finished 1st",
      "left the race"),
    - `<div class="race-bar" aria-hidden="true"><div class="race-bar-fill"></div></div>`,
      fill set with `style.transform = \`scaleX(${progress / 100})\``
      (no layout). `.race-track--self` gets the accent fill.
    The text is not live; screen-reader users can read the list any time, and
    milestones are announced (see 4.5). Rows are shown from `waiting` on (with
    0%), so the player sees themself and the opponent appear.
- **Typing area in multi:** `aria-label` "Race passage" on `#typing-area`;
  `#restart-inline` hidden; the input's `aria-describedby` set to
  `"race-hint words-text"` (and back to `"typing-hint words-text"` in solo),
  because `aria-describedby` still reads hidden elements. New
  `<p id="race-hint" class="hint" hidden>Type the passage. Fix every mistake to finish.</p>`
  in `.typing-footer`. Typing area hidden in `connecting` and `waiting`
  (no passage yet), shown in `countdown` and `running`.
- **Toolbar in multi:** `#settings` hidden; the `best` live stat hidden
  (`id="live-best-stat"` on its wrapper `<div>`).
- **Results card in multi:** `#results-title` text "Race results"; `#res-best`
  is reused as the rematch status line (class `is-new` removed, text from
  `mp.resultsStatus`, e.g. "Waiting for your opponent to race again.");
  new `<ol id="race-results" class="race-results" hidden>` after the result
  grid, one `<li>` per `ResultEntry`: "1st · You · 62 wpm · 97% · 41.3s"
  (status `unfinished`: "did not finish" instead of the time; `left`: "left
  the race"). Own entry also fills `#res-wpm`, `#res-acc`, `#res-raw`,
  `#res-chars`, `#res-time` from the server's numbers. `#restart-btn` text
  "Race again" (sends `race:rematch`, then `disabled` with text "Waiting for
  opponent…" until the next countdown); new
  `<button id="leave-btn" class="secondary-btn" type="button" hidden>Back to solo</button>`
  after it. In solo, restore "Results", "Restart test", re-enable the button
  and hide the multi-only elements.

## 5. File-by-file changes

### Server changes (backend-builder)

1. **`server/package.json`** (new): `"name": "typing-test-server"`,
   `"private": true`, `"type": "commonjs"`, `"engines": { "node": ">=20.12" }`,
   scripts `"start": "node src/index.js"`, `"test": "node --test test/"`;
   dependencies `express`, `socket.io`; devDependency `socket.io-client`.
2. **`server/.env.example`** (new): exactly the block in 4.3.
3. **`server/.gitignore`** (new): `node_modules/`, `.env`.
4. **`server/src/constants.js`**: as 4.3.
5. **`server/src/config.js`**: `loadConfig(env)`. Parse booleans as the exact
   strings `'true'`/`'false'`; `CORS_ORIGINS` split on commas, trimmed, empty
   entries dropped; `PORT` and `MAX_CONNECTIONS_PER_IP` integers in range or
   default.
6. **`server/src/shared.js`**: as 4.1. Throws a clear error at startup if
   `WORDS` is not a non-empty array.
7. **`server/src/origin.js`**, **`validate.js`**, **`rateLimit.js`**,
   **`race.js`**, **`roomStore.js`**: pure modules as in 4.3. Export
   everything the tests need.
8. **`server/src/game.js`**: as 4.3, implementing PROTOCOL.md exactly
   (event names, payloads, ack shapes, emit order, error codes).
9. **`server/src/app.js`**: `createServer(options)`. Options default to
   constants/config; tests override `countdownMs`, `raceTimeLimitMs`,
   `broadcastIntervalMs`, `pickPassage`, `rateLimit`
   (`{ capacity, refillPerSec }`), `maxConnectionsPerIp`, `corsOrigins`,
   `allowLocalhost`, `allowNullOrigin`.
10. **`server/src/index.js`**: entry point.

### Client changes (frontend-builder)

1. **`words.js`**: append
   `if (typeof module !== 'undefined' && module.exports) { module.exports = { WORDS }; }`.
   Nothing else changes. (This is build step 1, before the server.)
2. **`multiplayer.js`** (new): the pure functions and `MP_CONSTANTS` in 4.5,
   with a header comment like `stats.js` and a `typeof module` export guard.
3. **`index.html`**:
   - `<meta name="typing-server-url" content="http://localhost:3000">` in
     `<head>`.
   - `<script src="multiplayer.js" defer></script>` between `stats.js` and
     `script.js`.
   - Mode group `#mode`, `id="live-best-stat"` on the best wrapper,
     `#mp-error`, `#race-panel` (with `#race-title`, `#race-status`,
     `#race-tracks`), `#race-hint`, `#race-results`, `#leave-btn`, as in 4.7.
4. **`script.js`**:
   - Dependency guard: unchanged for `stats.js`. Add
     `const MP_AVAILABLE = typeof resolveServerUrl === 'function' && typeof validateRoomState === 'function';`
     A missing `multiplayer.js` hides `#mode` and never blocks solo.
   - `CONFIG`: add `serverUrl` from
     `resolveServerUrl(document.querySelector('meta[name="typing-server-url"]')?.content)`
     when `MP_AVAILABLE`, else `null`.
   - `dom`: add `mode`, `modeButtons`, `mpError`, `racePanel`, `raceStatus`,
     `raceTracks`, `raceHint`, `raceResults`, `leaveBtn`, `liveBestStat`.
   - `createInitialState`: add `mode: 'solo'`, `mp: null`, `wrongCount: 0`.
   - Add `createRaceState(session, race)` (4.5).
   - `handleCharacter`, `handleBackspace`: maintain `wrongCount` (when a slot
     goes to or from `'incorrect'`); multi guards and `queueKey` (4.5).
   - `handleKeydown`: skip the Escape restart when `state.mode === 'multi'`.
   - `tick`: mode branch (4.5).
   - `startTest`: hide `#mp-error`.
   - `restart`: unchanged signature; it always produces solo state. In multi
     it is reached only through `leaveMultiplayer`. `#restart-inline` is
     hidden in multi; `#restart-btn` gets one click handler that calls
     `requestRematch()` in multi and `restart()` in solo.
   - `renderPhase`: in multi, `#typing-area` hidden unless phase is
     `countdown` or `running`; `#results` shown only when `finished`;
     `#race-panel` shown in every multi phase except `finished`. Keep
     `body.dataset.phase = state.phase`.
   - New `renderMode()`: `aria-pressed` on mode buttons; toggles `#settings`,
     `#live-best-stat`, `#restart-inline`, `#typing-hint`/`#race-hint`, input
     `aria-describedby`, `#typing-area` `aria-label`, results title, restart
     button text and `disabled`, `#race-results`, `#leave-btn`. Called from
     `renderAll()`.
   - New `renderRacePanel()` (status text), `renderRaceTracks()` (build rows
     when the set of player ids changes, else update text and transform only),
     `renderRaceResults()` (own numbers into `#res-*`, rows into
     `#race-results`), `renderRaceResultsStatus()` (writes
     `mp.resultsStatus` to `#res-best`, sets the restart button's text and
     `disabled` from `mp.rematchRequested`). All text via `textContent`.
   - `renderAll(best)`: call `renderMode()`; in multi skip `renderBest`, and
     call `renderText()` only when `chars.length > 0` (otherwise clear
     `#words`).
   - New functions: `startMultiplayer()`, `loadSocketIo(url)`,
     `connectSocket(io)`, `onJoinAck(ack)`, `onRoomState`, `onRaceCountdown`,
     `onRaceStart`, `onRaceUpdate`, `onPlayerFinish`, `onRaceEnd`,
     `onGameError`, `onDisconnect`, `queueKey(key)`, `flushKeys()`,
     `sendProgress(keys)`, `requestRematch()`, `leaveMultiplayer(code)`,
     `handleModeClick(event)`, `handleVisibilityChange()`.
   - `requestRematch()`: set `mp.rematchRequested = true`,
     `renderRaceResultsStatus()`, `emit('race:rematch', {}, ack)`. A failed
     ack sets `rematchRequested = false`, `mp.resultsStatus =
     errorMessage(code)` and re-renders (button enabled again). A successful
     ack updates `session.room` and the status line.
   - `init()`: wire `#mode` click (event delegation via `handleModeClick`),
     `#leave-btn` click → `leaveMultiplayer()`, `visibilitychange` →
     `handleVisibilityChange()` (flush in multi `running`). Hide `#mode` if
     `!MP_AVAILABLE || CONFIG.serverUrl === null`. `renderLoadError()` also
     hides `#mode`.
   - Mode click on **Multiplayer** while already in multi, or **Solo** while in
     solo: no-op. **Solo** while in multi: `leaveMultiplayer()`. Keyboard
     activation keeps focus on the button; a mouse click (`event.detail > 0`)
     moves focus to the input only when the result is solo.
5. **`style.css`**:
   - `.race-panel`, `.race-status` (`color: var(--text)`), `.race-tracks`
     (no list style, `margin: 1rem 0 0`, `padding: 0`), `.race-track` as a
     2-column grid: name and meta on the first row, bar spanning both columns
     on the second.
   - `.race-bar`: `height: 0.5rem; background: var(--border); border-radius: 999px; overflow: hidden;`
     `.race-bar-fill`: `height: 100%; background: var(--text); transform-origin: left; transform: scaleX(0); transition: transform 0.2s linear;`
     `.race-track--self .race-bar-fill { background: var(--accent); }`
     Verify each fill against `--border` reaches 3:1 in both themes.
   - `.race-meta`: `color: var(--text-dim); font-family: var(--font-mono); font-variant-numeric: tabular-nums;`
   - `.race-results`: styled like `.history-list`.
   - `.secondary-btn`: full width like `.primary-btn` but
     `background: transparent; border: 1px solid var(--border); color: var(--text); margin-top: 0.75rem;`
   - `.primary-btn:disabled`: `cursor: not-allowed; filter: none; opacity`
     must not drop text below 4.5:1 (prefer leaving colors unchanged; the
     text itself says "Waiting for opponent…").
   - Add `.race-bar-fill` to the reduced-motion `transition: none` list.
   - At `max-width: 600px`, `#mode` centred like `.settings`.
6. **No change** to `stats.js` or `tests/` (qa-tester owns `tests/`).

### Build order

1. frontend-builder: `words.js` export guard only (the server needs it).
2. backend-builder: `server/` steps 1–10. Smoke-test `GET /health`.
3. server-tester: `server/test/` suite.
4. frontend-builder: client steps 2–5.
5. Reviews (backend-reviewer, code-reviewer, accessibility-auditor), fix loop.
6. qa-tester: `tests/multiplayer.test.js` and the `words.js` export test.
7. docs-writer: README section on running the server and multiplayer.

## 6. Accessibility

- **Keyboard flow:** Tab reaches the mode group (two toggle buttons with
  `aria-pressed`), the duration group (solo only), the typing input, and on
  the results card "Race again" and "Back to solo". Escape never leaves a
  race. Tab is never captured.
- **Focus:** pressing Multiplayer keeps focus on the button (keyboard); the
  status line and `announce()` report progress. On `race:countdown` focus
  moves to the input, because the user asked for a race and must be able to
  type at "Go"; the announcement says so. On `race:end` focus moves to
  `#results-title` (as in solo, so a stray Space does not rematch). On
  fallback to solo, focus moves to the input only if it was in the typing
  area; the `#mp-error` alert explains why.
- **Live regions:** one polite `#announcer` for all race announcements, plus
  `#mp-error` (`role="alert"`) for connection failures. Announcements are
  limited to: connected and waiting (once), countdown start (once), "Go!",
  opponent halfway (once per race), each finish (once per player), opponent
  left (once), race over (once). No per-second or per-update speech. The
  progress rows and `#race-status` are not live.
- **Progress bars** are `aria-hidden` decoration; the same information is in
  the row text ("Opponent 45% · 62 wpm").
- **Contrast:** all new text uses `--text`, `--text-dim` or `--accent` on
  `--surface`/`--bg`, already 4.5:1 in both themes. Bar fills must reach 3:1
  against the track (WCAG 1.4.11).
- **360px:** race rows stack (name/meta line, then full-width bar); the mode
  group and duration group stack in the existing column toolbar; results rows
  wrap. No fixed widths.
- **Reduced motion:** bar transitions off.

## 7. Edge cases

Client:

- **Server unreachable / script 404 / timeout:** after at most 5 s,
  `#mp-error` "Could not reach the multiplayer server. You are playing solo."
  and solo state. Pressing Multiplayer again retries (the cached promise was
  reset).
- **Invalid meta URL:** mode group hidden; solo unaffected.
- **`multiplayer.js` missing:** `MP_AVAILABLE` false, mode group hidden.
- **Corrupt or empty `localStorage`:** unchanged handling; multiplayer adds no
  stored data.
- **Room full / race in progress:** join ack error → `errorMessage(code)` and
  solo.
- **Disconnect mid-race:** message and a fresh solo test.
- **Opponent leaves during countdown:** back to waiting, announced.
- **Rapid Solo/Multiplayer toggling:** `leaveMultiplayer` tears down the
  socket and listeners first; listeners ignore events if the socket is not
  `mpSocket`. A pending `loadSocketIo` that resolves after the user went back
  to solo does not connect (`connectSocket` checks `state.mode`).
- **Tab hidden mid-race:** buffered keys flushed on `visibilitychange`;
  timers are display-only, time comes from timestamps.
- **Paste/drop:** already blocked; nothing is queued.
- **IME / mobile keyboards:** `handleMobileInput` already feeds
  `handleCharacter`/`handleBackspace`, so keys are queued the same way.
- **Very fast typing:** 64-unit cap flushes immediately; the server bucket is
  far above human rates.
- **End of passage with mistakes:** further characters are ignored locally and
  on the server; the race hint says to fix mistakes.
- **Malformed server payload:** validator returns `null`, message ignored.

Server:

- **Simultaneous finishes:** Node processes events one at a time; places are
  assigned in processing order and are always unique. `timeMs` can be equal.
- **Late events:** `race:progress` after `race:end` or before `race:start` is
  ignored silently. A rematch outside `finished` gets `NOT_FINISHED`.
- **Duplicate / out-of-order progress:** `seq <= lastSeq` ignored.
- **Same socket joins twice:** `ALREADY_JOINED`.
- **Third player:** `ROOM_FULL`.
- **Player leaves during countdown:** timer cleared, back to `waiting`.
- **All players leave:** every timer cleared, room deleted; nothing leaks.
- **Cheating attempts in M1 scope:** client-sent WPM/time/position fields are
  ignored (extra fields); huge payloads cut at 4 KB; long or control-character
  `keys` rejected; floods rate-limited; the server decides correctness and
  finish. Plausibility checks (impossible speed, scripted typing) are M3.
- **Handler throws:** `safeHandler` answers `INTERNAL`, logs, keeps running.
- **Bad origin / too many connections per IP:** refused in `allowRequest`.
- **`close()` while a race runs (tests, SIGTERM):** all timers cleared.

## 8. Testing notes

### `server/test/` (server-tester, `npm test --prefix server`)

Pure units (no sockets):

- `validate.test.js`: `validateProgress` accepts `{ seq: 1, keys: 'a' }`,
  `{ seq: 2147483647, keys: 'a'.repeat(64) }`, `{ seq: 3, keys: 'ab\bc' }`;
  rejects `null`, `[]`, `'x'`, `{}`, `seq` `0`, `-1`, `1.5`, `'1'`,
  `2147483648`, `keys` `''`, `'a'.repeat(65)`, `123`, `'a\nb'`, `'a\u0000'`,
  `'\u007f'`, `'\ud800'` (lone surrogate). `validateJoin`/`validateRematch`
  accept `{}` and `undefined`, reject `null`, `[]`, `'x'`, `1`.
- `origin.test.js`: GitHub Pages origin allowed;
  `https://prathambasu03-git.github.io/` (trailing slash) and
  `https://evil.github.io` refused; `http://localhost:8080` and
  `http://127.0.0.1` allowed only with `allowLocalhost`;
  `http://localhost.evil.com` refused; `'null'` allowed only with
  `allowNullOrigin`; `undefined` allowed.
- `rateLimit.test.js`: 20 takes succeed at t=0, the 21st fails; after 100 ms
  one more succeeds; never exceeds capacity after a long idle.
- `race.test.js` (fake `now`, fixed passage `'ab cd'`):
  - `applyKeys`: `'ab cd'` → finished, place 1, `correctKeystrokes 5`;
    `'ax\bb cd'` → finished, `totalKeystrokes 6`, `correctKeystrokes 5`,
    accuracy 83; `'ab cx'` → not finished (incorrect at end), extra keys after
    the end ignored and not counted; `'\b'` at index 0 ignored; keys after
    finishing in the same batch ignored.
  - `addPlayer`: third player `ROOM_FULL`; join during `countdown`/`racing`
    `RACE_IN_PROGRESS` (with `maxPlayers 3`); same socket `ALREADY_JOINED`;
    slots 1 and 2, slot 1 reused after a leave.
  - `shouldStartCountdown`: two ready players in `waiting` → `'countdown'`;
    one ready player in `finished` → `'waiting'`; two players with one not
    ready in `finished` → `null`.
  - `buildResults`: finisher at 30 s with 150 correct chars → wpm 60; order
    finished by place, then unfinished by `correctChars`, then `left`;
    places unique 1..n.
  - `removePlayer` during racing marks `connected: false` and freezes stats.

Socket integration (`createServer({ countdownMs: 50, raceTimeLimitMs: 2000,
broadcastIntervalMs: 20, pickPassage: () => 'ab cd' })`, `listen(0)`,
`socket.io-client` with `transports: ['websocket']`, close everything in
`after`/`afterEach`):

- `race.flow.test.js`, **two-client race simulation:** A joins (ack `ok`,
  `room.phase 'waiting'`); B joins; both receive `room:state` (`countdown`)
  then `race:countdown` with `passage 'ab cd'`; then `race:start`. A sends
  `{ seq: 1, keys: 'ab' }`, both receive a `race:update` where A has
  `correctChars 2`, `progress 40`. A sends `{ seq: 2, keys: ' cd' }` →
  `player:finish` `{ id: A, place: 1 }`. B sends `{ seq: 1, keys: 'ab cd' }`
  → `player:finish` place 2 → `race:end` `reason 'all_finished'`, results
  `[A place 1, B place 2]`, both `status 'finished'` → `room:state` phase
  `finished` with both `ready: false`. Both send `race:rematch` → new
  `race:countdown`.
- **Time limit:** with `raceTimeLimitMs: 200`, nobody finishes → `race:end`
  `reason 'time_limit'`, statuses `'unfinished'`, ordered by `correctChars`.
- **Third client:** `ROOM_FULL` ack.
- **Leave during countdown:** B disconnects before `race:start` → A gets
  `room:state` `waiting`, and no `race:start` arrives within 200 ms.
- **Disconnect mid-race:** A finishes, B disconnects → `race:end` arrives with
  B `status 'left'`. Or B disconnects first and A finishes → `race:end`.
- **Both disconnect mid-race:** a new client can join afterwards and gets a
  fresh `waiting` room (proves the room and timers were cleared).
- **Late and duplicate events:** progress before `race:start` changes nothing;
  a reused `seq` is ignored; progress after `race:end` is ignored; rematch
  while `racing` → `NOT_FINISHED`.
- **Client-sent scores ignored:** `{ seq: 1, keys: 'a', wpm: 999, finished: true }`
  → the server's own `wpm`, not finished.
- **Bad payloads:** `race:progress` with `keys: 'a'.repeat(65)` → `game:error`
  `BAD_PAYLOAD`; `room:join` with no ack → `game:error` `BAD_PAYLOAD`.
- **Rate limit:** with `rateLimit: { capacity: 3, refillPerSec: 0 }`, the 4th
  event gets `RATE_LIMITED`.
- **Simultaneous finish:** both clients send their final keys back to back;
  places are 1 and 2, unique.
- `http.test.js`: `GET /health` → 200 `{ status: 'ok' }`; a client with
  `extraHeaders: { origin: 'https://evil.example' }` gets `connect_error`;
  one with the GitHub Pages origin connects; `/socket.io/socket.io.js` → 200.

### `tests/` (qa-tester, `node --test tests/`)

- `tests/multiplayer.test.js` (require `../multiplayer.js`, plus a `vm` test
  that it runs as a classic script with no `document`/`window`):
  - `resolveServerUrl`: `'http://localhost:3000'` → `'http://localhost:3000'`;
    `'https://example.com/path/'` → `'https://example.com'`; `''`, `undefined`,
    `'not a url'`, `'javascript:alert(1)'`, `'data:text/html,x'`,
    `'file:///C:/x'`, `'ftp://x'` → `null`.
  - `appendKey`: `('', 'a', 64)` → `{ buffer: 'a', flush: null }`;
    `('a'.repeat(64), 'b', 64)` → `{ buffer: 'b', flush: 'a'.repeat(64) }`;
    `('a'.repeat(63), '😀', 64)` (2 units) → flushes the 63.
  - Each `validate*`: accepts a well-formed sample from PROTOCOL.md section 5,
    strips unknown fields, rejects wrong types, out-of-range numbers
    (`progress 101`, `place 0`, `accuracy -1`), unknown `phase`/`status`/
    `reason`, a passage of 1001 chars or with `'\n'`, `null`, arrays.
  - `ordinal`: 1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111.
  - `crossedMilestone`: `(40, 55, [50])` → 50; `(50, 60, [50])` → null;
    `(0, 100, [25, 50, 75])` → 75; `(60, 40, [50])` → null.
  - `labelFor`: self → `'You'`; one opponent → `'Opponent'`; two opponents →
    `'Opponent 1'`, `'Opponent 2'` by slot.
  - `errorMessage`: known codes give their text; an unknown code gives the
    default.
  - `formatRaceTime`: `41300` → `'41.3s'`, `0` → `'0.0s'`, `120000` → `'120.0s'`.
- In `tests/stats.test.js` or a new file: `require('../words.js').WORDS` is a
  non-empty frozen array, and `globalThis.WORDS` is still undefined after
  requiring it.

## 9. Out of scope

- **M2:** lobby UI, multiple rooms, room codes, invite links, player names,
  host/ready-up controls.
- **M3:** anti-cheat beyond validation and rate limits: impossible-speed and
  burst checks, key-timing heuristics, kicking cheaters.
- **M4:** Redis, PostgreSQL, Prisma, saved race results, leaderboards, HTTP
  rate limiting for new endpoints.
- **M5:** Docker, Docker Compose, GitHub Actions CI, deployment, the
  production server URL in the meta tag, `docs/DEPLOY.md`, proxy-aware client
  IPs (`trust proxy`).
- Reconnecting to a race after a dropped connection.
- Clock sync or latency compensation for the start signal.
- Saving multiplayer results to `typing:history` or `typing:best`.
- Spectators and more than `MAX_PLAYERS` per room.

## 10. Changes after build

The user approved this plan as written. The backend-builder made four
deviations, which the lead accepted. `docs/PROTOCOL.md` now matches the server
and takes precedence over sections 4.3 and 8 above where they differ.

1. **WPM floor everywhere.** `wpm` and `rawWpm` in `race:update`,
   `player:finish` and `race:end` are computed over `max(elapsedMs, 1000)`,
   then clamped (`wpm` 0..1000, `rawWpm` 0..5000, `accuracy` 0..100).
   `timeMs` stays the real elapsed time. (PROTOCOL.md section 6.) The
   `buildResults` test in 8 (150 correct chars at 30 s → wpm 60) is
   unaffected.
2. **`startAt` resets when the race begins.** `beginRace(room, now)` (not
   `beginRace(room)`) sets `startAt = now` when the countdown timer actually
   fires, so a late timer never shortens the race. The `startAt` set by
   `beginCountdown` is only provisional.
3. **Rematch that moves `finished` → `waiting`** emits, in order: ack,
   `room:state` (phase `finished`, this player `ready: true`), `room:state`
   (phase `waiting`). Client impact: when a `room:state` with phase `waiting`
   arrives while the client is in `finished` (after the player's own rematch,
   with the opponent gone), the client moves to its `waiting` phase. The
   results card is hidden. The race panel is shown with "Waiting for an
   opponent…" and the player's own track row. There is one announcement,
   "Waiting for a new opponent.". This is the same screen as a first join.
   The next `race:countdown` then proceeds as normal.
4. **Idempotent rematch while `waiting`** (the player is already ready):
   only the ack, no `room:state` broadcast.
5. **Review fixes decided by the lead (backend-reviewer H1, L3, L1).**
   - **Idle timeout in `finished` (H1).** New server constant
     `REMATCH_TIMEOUT_MS = 60000`, which `createServer({ rematchTimeoutMs })`
     can override. When the room enters `finished`, the server starts a
     rematch timer. If it fires while the room is still `finished`, then for
     every player with `ready === false` the server emits
     `game:error { code: 'IDLE_TIMEOUT', message }` to that socket and then
     calls `socket.disconnect(true)`. The normal disconnect path removes the
     player, emits `room:state` and runs the start check. So a ready player
     left in the room gets a countdown if two ready players remain, or moves
     to `waiting` otherwise. The timer is cleared on every exit from
     `finished` and when the room is deleted. New error code
     `IDLE_TIMEOUT` (PROTOCOL.md sections 3 and 7).
     - Client impact: `onGameError` remembers an `IDLE_TIMEOUT`, and the
       `disconnect` that follows calls `leaveMultiplayer('IDLE_TIMEOUT')`
       instead of `'DISCONNECTED'`. `errorMessage` needs a client-owned
       text for it, for example "You were idle on the results screen, so
       you left the race room. You are playing solo."
   - **Join timeout (L3).** New server constant `JOIN_TIMEOUT_MS = 10000`,
     which `createServer({ joinTimeoutMs })` can override. A socket that has
     not joined successfully within that time is disconnected, with no event
     first. The timer is cleared on a successful join and on disconnect.
     After a failed `room:join` ack, the server also disconnects the socket
     on the next tick, after the ack has been delivered. The client already
     disconnects on a failed ack, so client behaviour is unchanged.
     Exceptions (accepted after build): `ALREADY_JOINED` never triggers the
     next-tick disconnect (the socket keeps its seat), and only failures
     answered through the join ack (`BAD_PAYLOAD` with an ack, `ROOM_FULL`,
     `RACE_IN_PROGRESS`) do; a no-ack join, a rate-limited join and
     `INTERNAL` are left to `JOIN_TIMEOUT_MS` (PROTOCOL.md section 4,
     `room:join`).
   - **Passage fallback and rematch re-check (L1).** If a custom
     `pickPassage` throws or returns an invalid passage, `startCountdown`
     logs it and uses the default picker. An idempotent `race:rematch` while
     `waiting` re-runs the start check after the ack. It emits nothing extra
     unless the check changes the phase (then the normal countdown emits
     follow). This refines item 4.
   - Server tests to add (server-tester), all with short timers:
     - the rematch timeout disconnects only players who are not ready, each
       receiving `IDLE_TIMEOUT` first;
     - after that, a joiner can enter the room;
     - a socket that never joins is disconnected after `joinTimeoutMs`;
     - a failed join (for example `ROOM_FULL`) is followed by a server
       disconnect;
     - a throwing `pickPassage` still produces a valid `race:countdown`.
