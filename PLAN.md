# PLAN: Multiplayer M2, lobby and room codes

The full M1 plan and the D (Deploy to Render) plan are in git history at
commit `323eb71` (`git show 323eb71:PLAN.md`). `docs/PROTOCOL.md` (version
M2 r2) is the single source of truth for every event; where this plan and the
protocol differ, the protocol wins. Section 12 lists the changes made after
the backend review.

## 1. Goal

A player presses **Multiplayer**, then **Create a room**, and gets a short room
code with a **Copy invite link** button next to it to send to friends. Up to
four players join with the code or the link, see each other in the room
lobby, and the host presses **Start race** (enabled once 2 players are in).
After a race the host can start again with whoever pressed **Race again**;
the others sit that race out and join the next one. A visitor on their own can
open the invite link in a second tab to try a race. Solo still works with no
server, including from `file://`.

## 2. Carried over from M1 and D (still binding, do not undo)

- **Server-authoritative race.** The server owns the passage, start time,
  WPM, accuracy, finish and order. The client sends only `race:progress
  { seq, keys }` (keystroke deltas, `'\b'` = Backspace, max 64 units, about
  one event per 150 ms). Client-sent scores are ignored.
- **Caps and limits:** per-socket token bucket (20, refill 10/s) on every
  event; `maxHttpBufferSize` 4096; `MAX_CONNECTIONS_PER_IP` 10; payload
  validation in `server/src/validate.js`; `safeHandler` answers `INTERNAL`.
- **Accepted deviations (old section 10):** WPM over `max(elapsed, 1000)` and
  clamped; `startAt` reset when the countdown timer fires; the emit order for a
  rematch that moves `finished → waiting` (ack, `room:state` finished,
  `room:state` waiting); idempotent rematch in `waiting` (ack only); passage
  fallback when `pickPassage` throws.
- **Countdown** `COUNTDOWN_MS` 3000, display-only on the client; only
  `race:start` unlocks typing. Race limit 120 s.
- **Rematch rules:** after `race:end` the `ready` of every player who raced
  is false (M2: players who sat out stay ready, see 5.1 decision 3); "Race
  again" sets it. `REMATCH_TIMEOUT_MS` 60000: players not ready are sent
  `IDLE_TIMEOUT` and disconnected; the client warns 20 s before (WCAG 2.2.1).
  M2 adds only one rule: a host start clears this timer (5.1 decision 3).
- **Join timeout** `JOIN_TIMEOUT_MS` 10000 and the next-tick kick after a
  failed entry ack (`ALREADY_JOINED` never kicks).
- **Cold-start client flow (D):** one budget per connection attempt
  (`wakeTimeoutMs` 90000 remote, `localConnectTimeoutMs` 5000 loopback),
  retries every `wakeRetryDelayMs` 3000 while `retryDelayWithin` allows,
  waking notice after `wakeNoticeDelayMs` 3000 (remote only, announced once),
  `joinAckTimeoutMs` 10000, `ackTimeoutMs` 5000, Solo cancels at any time
  (`cancelSocketIoLoad`, `clearConnectTimers`), `state.mp === mp` guards.
- **No request before intent:** nothing is sent to the server before a user
  action. No warm-up on page load or hover.
- **`pickServerUrl(meta, location)`:** `file://` is solo only; loopback pages
  use `http://localhost:3000`; placeholder, loopback-on-public and mixed
  content give `null`. No query-string server override.
- **`TRUST_PROXY_HOPS`** (Render: 1) via `getClientIp`; the same key now also
  drives the M2 per-IP limits.
- **Socket.io client script** only from `<server>/socket.io/socket.io.js`,
  only after a user action. No CDN, no build, classic `defer` scripts.
- **Accessibility:** one polite `#announcer`, `role="alert"` only for errors,
  `#race-status` not live, no per-second speech, focus moved only when the
  focused element is hidden or the user must act (countdown → input, race end
  → results heading), `aria-disabled` (not `disabled`) on buttons that keep
  focus, 4.5:1 text, 3:1 UI boundaries, no horizontal scroll at 360px,
  reduced motion respected.
- **Never `innerHTML`** with server, stored or user data; `textContent` and
  input `.value` only. All server payloads validated in `multiplayer.js`.
- Multiplayer results are not saved to `typing:history` / `typing:best`.

## 3. Assumptions

- **Codes only, no public lobby list or quick match in M2** (user decision 1).
  Strangers can no longer meet by pressing Multiplayer; that is the main cost.
  To make up for it, the lobby tells a lone visitor they can open the invite
  link in a second tab, and the README says the same.
- **2 to 4 players** (`MAX_PLAYERS 4`, `MIN_PLAYERS 2`), host starts (user
  decision 2).
- **Host succession by join order** (user's words: "the next player who
  joined"): the server keeps a per-room `joinSeq` per player and passes the
  host to the connected player with the smallest one. Slots are only labels.
- **Rematch with whoever is ready** (user's words: "the host can start again
  with whoever pressed Race again"): players who have not pressed Race again
  when the host starts stay in the room and sit that race out; they are not
  kicked. The host pressing Start counts as the host's own Race again.
- **Sitting-out players do not watch the race.** They see the room lobby with
  "The host started a new race. You'll join the next one." and the players
  marked "racing" or "sitting out", not live progress (smallest design;
  spectating is out of scope).
- **The `ROOM_FULL` text names 4 players** as a fixed string: the client does
  not learn the room's `maxPlayers` from a failed join, and `MAX_PLAYERS` is a
  server constant that only tests override.
- **No nicknames.** Players are "You" and "Player N" (N = slot), with
  "(host)" after the host's name.
- **No new `localStorage` keys.** The invite code lives in the URL hash only.
- **No new env vars.** `MAX_ROOMS` and the per-IP limits are constants that
  `createServer(options)` can override for tests. `render.yaml` is unchanged.
- **Reconnecting is not supported.** A dropped player can join again with the
  code as a new player while the room is `waiting` or `finished` (new
  `joinSeq`, so they go to the back of the host queue).
- **Share link base** is the current page (`location.origin + pathname`), so
  it is `https://prathambasu03-git.github.io/typing-speed-tester/#room=K7QM2X`
  on the live site and works the same on a localhost page.
- **Background script load on Multiplayer press** (user decision 4). Pressing
  Multiplayer is user intent (the D rule), so `socket.io.js` starts loading
  then, waking a cold server while the user chooses Create or Join. The socket
  connects only on Create or Join.
- **Lobby timeout 10 min with Stay in room** (user decision 3).

## 4. Current state

Server:

- `server/src/constants.js:20-22`: `ROOM_ID 'main'`, `MAX_PLAYERS 2`,
  `MIN_PLAYERS 2`. `ERROR_CODES` at `:7`.
- `server/src/game.js`:
  - `:76` `roomLimits` read from options, but `app.js:101-111` never passes
    `maxPlayers`/`minPlayers`.
  - `:224` `runStartCheck` starts a countdown automatically (via
    `race.shouldStartCountdown`).
  - `:252` `failJoin` (next-tick kick). `:261` `onJoin` uses
    `store.getRoom(ROOM_ID) || race.createRoom(ROOM_ID, ...)` (`:272`).
  - `:295`, `:325`, `:356`: `onProgress`, `onRematch`, `onDisconnect` all look
    up `ROOM_ID`.
  - `:200` rematch timer, `:207` `onRematchTimeout`, `:430` join timer,
    `:403` per-socket rate-limit middleware.
- `server/src/race.js`: `createRoom` `:21`, `addPlayer` `:70` (already checks
  `ROOM_FULL` before `RACE_IN_PROGRESS`, `:72-75`; keep that order),
  `removePlayer` `:88` (racing branch marks every player disconnected),
  `setReady` `:102`, `shouldStartCountdown` `:116`, `beginCountdown` `:125`
  (resets every player), `cancelCountdown` `:135`, `markWaiting` `:152`,
  `applyKeys` `:192`, `isRaceOver` `:215` (all connected players), `endRace`
  `:340`, `toSnapshot(room)` `:348` (no code, host or expiry).
- `server/src/validate.js:26` `validateJoin` accepts only `{}`/`undefined`.
- `server/src/roomStore.js:7` `createMemoryRoomStore` (`getRoom`, `saveRoom`,
  `deleteRoom`, `clear`; no size).
- `server/src/rateLimit.js`: `createBucket`, `takeToken` (no way to peek).
- `server/src/app.js:67` `ipOf(req)`; the client IP is not available to
  `game.js`.
- `server/test/helpers.js:103` `client.join = () => emitAck('room:join', {})`;
  `:158` `racing()` relies on the automatic start. About 80 call sites in
  `race.flow`, `race.edge`, `timeouts`, `race`, `roomStore` and `constants`
  tests use `join()`/`joined()`/`ROOM_ID`/`'main'`.

Client:

- `index.html:75-80` `#race-panel` (title, `#race-status`, `#race-tracks`).
  `:132-135` results card with `#race-results`, `#restart-btn`, `#leave-btn`.
- `multiplayer.js`: `MP_CONSTANTS` `:15`, `MP_LIMITS` `:53`,
  `validateRoomState` `:240`, `validateJoinAck` `:316`, `validateRematchAck`
  `:324`, `labelFor` `:339` ("Opponent N" by position), `ERROR_MESSAGES`
  `:371`.
- `script.js`:
  - `createRaceState` `:231` (phase starts at `'connecting'`).
  - `renderPhase` `:409`, `renderMode` `:426`; **stale comment `:436-439`**
    says the race instructions are spoken in `onJoinAck`, but they can also be
    spoken by `onRaceCountdown`.
  - `handleKeydown` `:856`: a document-level listener that sends every
    printable key to the test. A new text input (room code) would have its
    keys stolen.
  - `init` `:1011`. Section 12 from `:1061`: `rematchStatus` `:1169`
    (two-player wording), `raceStatusText` `:1192`, `buildRaceTracks` `:1237`,
    `renderRaceResults` `:1310`, `renderRaceResultsStatus` `:1358`,
    `startMultiplayer` `:1369` (connects straight away), `loadSocketIo`
    `:1418`, `handleSocketIoLoadFailure` `:1509`, `onConnect` `:1547` (emits
    `room:join {}`), `onJoinAck` `:1593`, `onRoomState` `:1623`,
    `enterWaiting` `:1694`, `onRaceCountdown` `:1706`, `endRace` `:1819`,
    `onGameError` `:1870`, `requestRematch` `:1934` (stays on the results card
    with "Waiting for your opponent…"), `onRematchAck` `:1952`,
    `leaveMultiplayer` `:1989`, `handleModeClick` `:2003`.
  - **Bug `:1728-1733`:** `onRaceCountdown` sets
    `session.instructionsSpoken = true` before `announceSoon` has spoken the
    message (it can still be cancelled), so the rule may never be read.
- `tests/helpers/load-script.js:218`: fake `window` has `location` without
  `hash`, and no `history` or `navigator`.

M1 open items and how M2 resolves them:

- **(a) A scripted client could hold the single room forever** by always
  rematching. With private rooms, holding a room only blocks that room; other
  players create their own. One IP (one IPv4 address or one IPv6 /64, see
  section 12) can hold at most 10 rooms (one socket per room,
  `MAX_CONNECTIONS_PER_IP` 10, and `ALREADY_JOINED` stops a socket from
  creating a second) and create at most 3 per minute; the store holds 200.
  Filling the store needs 20 or more IPv4 addresses or IPv6 /64s, which is
  accepted for this free-tier hobby server (M3 can tighten it).
- **(b)** fixed in `onRaceCountdown` (section 6, item C3-S12).
- **(c)** comment rewritten (section 6, item C3-S5).

## 5. Design

### 5.1 Decisions

1. **Lobby model: private rooms by code only.** Create → share code or link
   → join by code. A public list or quick match is kept for later: it brings
   back a shared public room (the M1 hold-forever problem), needs matchmaking
   rules, and doubles the client flows. A later `room:quick` event fits the
   protocol without changes to the others. The room lobby shows the code with
   **Copy invite link** right next to it, and, while you are the only player,
   the line "Racing alone? Open the invite link in a second tab to try it
   out." (5.4 Rendering).
2. **Room size 2–4.** The race UI already handles N players (track rows,
   results list, `MP_LIMITS.maxRoomPlayers` 8). Four rows fit at 360px (each
   row is two short lines). Results already order N players. Labels become
   "Player N" by slot, which stay stable when others leave (M1's
   "Opponent N" renumbered). A fifth player gets `ROOM_FULL`, shown inline in
   the join menu with the code kept: "That room is full (4 players). Ask the
   host for a new room or try another code." `ROOM_FULL` is checked before
   `RACE_IN_PROGRESS`, so a full room says "full" in every phase.
3. **Start rule: the host presses Start race.**
   - **In the lobby (`waiting`):** Start race is enabled once at least 2
     players are in. Until then it is `aria-disabled` (focusable) with the
     visible hint "Waiting for at least one more player." (the M1 Race again
     pattern). The server still answers `NOT_ENOUGH_PLAYERS`.
   - **After a race (`finished`):** pressing **Race again** takes a player
     straight to the room lobby (the room itself stays `finished`). The
     host's Start race there is enabled once at least 2 players, the host
     included, have pressed Race again (or joined since the race). The server
     counts a host's `room:start` as the host's own Race again, so it accepts
     it even if the host's rematch has not arrived; the client only shows
     Start after Race again anyway.
   - **When the host starts from `finished`:** every player who pressed Race
     again (or joined since), plus the host, races (`inRace: true`). Everyone
     else **sits out**: they stay in the room, are set `ready: true` (they are
     now lobby players for the next race), get no track, progress or result
     in this race, and their client leaves the results card for the room
     lobby with "The host started a new race. You'll join the next one."
   - **The 60 s rematch timer is kept** exactly as M1 while the room is
     `finished`: a player who raced and never presses Race again within 60 s
     of `race:end` is removed with `IDLE_TIMEOUT`. The one new rule: a host
     start clears that timer, so players moved into the lobby by the new race
     are never removed by the old timer. When that new race ends, only its
     racers get `ready: false` and a fresh 60 s timer; the sat-out players
     stay ready.
   - **If everyone presses Race again**, the return check moves the room to
     `waiting` (as planned before), the lobby timer starts, and the host
     starts as usual.
4. **Room codes: 6 characters from `ABCDEFGHJKMNPQRSTVWXYZ23456789`** (30
   symbols; no 0, 1, I, L, O, U; dropping U avoids accidental words). 729
   million codes. Generated with `crypto.randomInt` (unbiased), retried on
   collision up to 10 times. Case-insensitive input: the client strips spaces
   and hyphens and uppercases; the server accepts only the canonical form.
   Global cap `MAX_ROOMS` 200. Guessing: only failed joins (`BAD_CODE`,
   `ROOM_NOT_FOUND`) cost a per-IP token (10, refill 1 per 6 s), so a NAT full
   of real players is not blocked, while one limiter key (one IPv4 address or
   one IPv6 /64, section 12) needs on the order of 200 days to expect a single
   hit against a full server (PROTOCOL.md section 2). The bound depends on
   keying IPv6 by /64: with full-address keys one IPv6 host could rotate
   addresses and guess without limit.
   **Second tab check:** a lone visitor racing against a second tab uses 2 of
   the 10 connections per IP, 1 create token (of 3) and no join-failure
   tokens; even four tabs fit. No limit changes needed.
5. **Share link uses the hash: `#room=K7QM2X`.** The hash is never sent to
   GitHub's servers (no code in their logs or in `Referer`), changing it does
   not reload the page, and it is easy to parse without `URLSearchParams`.
   The page never connects because of the hash: it shows an invite banner with
   a **Join room** button. Copy uses `navigator.clipboard.writeText` in a
   secure context; otherwise (or on failure) the link stays in a read-only
   field that is focused and selected, with instructions.
6. **Lifecycle:** the creator is in the room from the start, so there is
   never an empty room: a room is deleted when its last player leaves. A room
   in `waiting` expires after `LOBBY_TIMEOUT_MS` 600000 (10 min) since the
   last create, join, extend or return to `waiting`. This matters on Render:
   an abandoned lobby tab would otherwise keep the free instance awake around
   the clock. The client warns 60 s before and offers **Stay in room**
   (`room:extend`), which satisfies WCAG 2.2.1. **Host succession:** when the
   host leaves, in any phase (lobby, countdown, race, results), the host
   passes to the connected player who joined earliest (smallest `joinSeq`),
   whether racing, sitting out or on results. Join order, not slot: slots are
   reused (B leaves slot 2, D joins into slot 2, A leaves: C, who joined
   before D, becomes host). Mid-countdown the countdown continues if at least
   2 racers remain. The 60 s rematch timer runs only in `finished`, the lobby
   timer only in `waiting`; they never overlap. The 10 s join timeout is
   unaffected: the socket connects only after the user has chosen, so it
   creates or joins at once.
7. **Protocol:** `room:create {}` → `{ ok, playerId, room }`; `room:join
   { code }` → the same ack shape (one validator); `room:start {}` (host) →
   `{ ok }`; `room:extend {}` → `{ ok, room }`. Leaving stays "disconnect".
   The client's start event is `room:start`, not `race:start`, because
   `race:start` is already a server → client event. `RoomSnapshot` gains
   `code`, `hostId`, `minPlayers`, `expiresInMs`; `PlayerSummary` gains
   `inRace`. Race events still go to the whole Socket.io room; clients that
   sit out ignore them (one room name per game room, no second channel).
   Clean break, no M1 compatibility (client and server ship together).
8. **Client flow:** solo → Multiplayer → **menu** (Create / Join form, no
   socket yet) → connecting (D cold-start flow, for create and for join) →
   **waiting** (room lobby: code + Copy invite link, link field, players,
   Start for the host) → countdown → running → finished → Race again (back to
   the room lobby) or Back to solo. A join error (`ROOM_NOT_FOUND`,
   `ROOM_FULL`, …) returns to the menu with an inline error and the code
   kept, not to solo. An unreachable server and lost connections still fall
   back to solo (CLAUDE.md rule).
9. **Nicknames: out of scope.** They need validation, moderation questions
   and rendering of user text from the server. "You" / "Player N" is enough.

### 5.2 Server design

#### New module `server/src/roomCode.js` (pure; randomness injected)

```js
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const ROOM_CODE_PATTERN = /^[A-HJKMNP-TV-Z2-9]{6}$/;
function isValidRoomCode(value) -> boolean            // typeof string && pattern
function generateRoomCode(randomInt = crypto.randomInt) -> string
  // 6 x ROOM_CODE_ALPHABET[randomInt(0, ROOM_CODE_ALPHABET.length)]
function createUniqueCode(isTaken, randomInt = crypto.randomInt, maxAttempts = ROOM_CODE_MAX_ATTEMPTS)
  -> string | null                                    // null after maxAttempts taken codes
```

Pattern and alphabet must agree; a test checks it (section 9).

#### New module `server/src/ipLimiter.js` (pure; `now` injected)

```js
function createIpLimiter({ capacity, refillPerSec, maxEntries = IP_LIMIT_MAX_ENTRIES,
                           sweepIntervalMs = IP_LIMIT_SWEEP_MS }) -> {
  has(ip, now) -> boolean,      // at least one token, without taking it
  consume(ip, now) -> boolean,  // takes one token if available
  sweep(now),                   // drops buckets that have refilled to capacity
  size() -> number,
}
```

- Buckets come from `rateLimit.js`. Export a new `refill(bucket, now)` there
  (the refill step `takeToken` already does) so `has` can peek.
- Lazy sweep: `has` and `consume` call `sweep(now)` first when
  `now - lastSweepAt >= sweepIntervalMs`. No timers.
- An IP with no bucket counts as a full bucket (`has` is true).
- If `maxEntries` is reached and a new IP arrives: sweep; if still full, the
  call is allowed without tracking (`has`/`consume` return true) and
  `console.warn` is logged at most once per sweep interval. Failing open is
  chosen because failing closed would let one attacker with many IPs block
  everyone.

#### `server/src/constants.js`

Remove `ROOM_ID`. Set `MAX_PLAYERS: 4`. Add `MAX_ROOMS: 200`,
`ROOM_CODE_LENGTH: 6`, `ROOM_CODE_ALPHABET`, `ROOM_CODE_INPUT_MAX: 16`,
`ROOM_CODE_MAX_ATTEMPTS: 10`, `LOBBY_TIMEOUT_MS: 600000`,
`CREATE_LIMIT_CAPACITY: 3`, `CREATE_LIMIT_REFILL_PER_SEC: 0.05`,
`JOIN_FAIL_LIMIT_CAPACITY: 10`, `JOIN_FAIL_LIMIT_REFILL_PER_SEC: 1 / 6`,
`IP_LIMIT_MAX_ENTRIES: 10000`, `IP_LIMIT_SWEEP_MS: 60000`. Add to
`ERROR_CODES`: `BAD_CODE`, `ROOM_NOT_FOUND`, `TOO_MANY_ROOMS`, `NOT_HOST`,
`NOT_ENOUGH_PLAYERS`, `PLAYERS_NOT_READY`, `NOT_WAITING`, `ROOM_EXPIRED`.
`ROOM_CODE_PATTERN` lives only in `roomCode.js`.

#### `server/src/race.js` changes

- `createRoom(code, { maxPlayers, minPlayers })`: `id = code`, plus
  `hostId: null`, `lobbyDeadline: null`, `nextJoinSeq: 1`.
- `createPlayer(id, socketId, slot, joinSeq)`: adds `joinSeq` and
  `inRace: false` (plus the M1 fields; `ready: true` as now).
- `addPlayer`: unchanged checks and order (`ALREADY_JOINED`, `ROOM_FULL`,
  `RACE_IN_PROGRESS`); the new player gets `joinSeq = room.nextJoinSeq++`;
  after adding, if `room.hostId === null`, set it to the new player's id.
- New `reassignHost(room) -> boolean` (true if `hostId` changed): keep the
  host if it is still a connected member; else set `hostId` to the connected
  player with the **smallest `joinSeq`**, or `null`. Called inside
  `removePlayer` (every branch), at the end of `endRace`, and in
  `abandonRace`.
- `removePlayer(room, socketId, now)`: the racing branch (mark
  `connected = false`, `leftAt`) applies only when `player.inRace`; a player
  sitting out during `racing` is removed from the array like in any other
  phase (`removed: true`).
- New `racers(room) -> Player[]`: `room.players.filter((p) => p.inRace)`.
- `beginCountdown(room, passage, now, countdownMs)`: first seats the racers:
  for each player `p.inRace = p.ready || p.id === room.hostId`, then
  `p.ready = true` for every player; then as M1, but `resetRaceFields` only
  for racers.
- `cancelCountdown(room)` and `markWaiting(room)`: also set every
  `inRace = false` (and `ready = true`, already true).
- New `abandonRace(room)`: phase `waiting`, `passage = null`,
  `startAt = null`, `finishCount = 0`, remove players with
  `connected === false`, every `inRace = false`, `ready = true`,
  `reassignHost(room)`.
- `applyKeys`: also returns "no change" when `!player.inRace`.
- `isRaceOver(room)`: over **connected racers** only: `const live =
  racers(room).filter((p) => p.connected); return live.length > 0 &&
  live.every((p) => p.finishedAt !== null);`
- New `hasConnectedRacer(room) -> boolean` (used by the disconnect path).
- `buildResults(room, now)`: over `racers(room)` only.
- `endRace(room)`: as M1 (remove disconnected, then) set `ready = false` only
  for players with `inRace`; players sitting out keep `ready = true`; then
  `reassignHost`.
- Replace `shouldStartCountdown(room)` with
  `shouldReturnToWaiting(room) -> boolean`: phase `finished`, at least one
  player, all ready.
- New `canStart(room, playerId) -> { ok: true } | { ok: false, code }`, in
  this order: `NOT_HOST` (`playerId !== room.hostId`), `RACE_IN_PROGRESS`
  (phase `countdown`/`racing`), `NOT_ENOUGH_PLAYERS` (`players.length <
  minPlayers`), `PLAYERS_NOT_READY` (phase `finished` and
  `room.players.filter((p) => p.ready || p.id === playerId).length <
  minPlayers`).
- New `isHost(room, playerId) -> boolean`.
- `toSnapshot(room, now)`: adds `code: room.id`, `minPlayers`, `hostId`,
  `expiresInMs` (`phase === 'waiting' && lobbyDeadline !== null ?
  Math.max(0, Math.round(lobbyDeadline - now)) : null`), and per player
  `inRace`. Not `joinSeq`, socket ids or IPs. Every caller passes `now()`.
- `progressSnapshot` / `race:update` entries and `player:finish` only for
  racers (they already come from players with race fields; filter by
  `inRace`).

#### `server/src/roomStore.js`

Add `size() -> number` (`rooms.size`). Keep the rest.

#### `server/src/validate.js`

- `validateCreate(payload)`, `validateStart(payload)`, `validateExtend(payload)`:
  `validateEmptyPayload` with their event names.
- `validateJoin(payload)`: plain object, `code` a string of length
  `1..ROOM_CODE_INPUT_MAX`, else `BAD_PAYLOAD`. Returns `{ ok: true, value:
  { code } }`. The format check is not here (it answers `BAD_CODE`).

#### `server/src/app.js`

Pass `ipOf` to `registerGame`, plus new options `maxPlayers`, `minPlayers`,
`maxRooms`, `lobbyTimeoutMs`, `createLimit { capacity, refillPerSec }`,
`joinFailLimit { capacity, refillPerSec }`, `randomInt`. Update the options
comment.

#### `server/src/game.js`

Per-socket data: `socket.data.roomId` (null until create/join succeeds) and
`socket.data.ip = ipOf ? ipOf(socket.request) : 'unknown'` (set in the
`connection` handler; this must be the limiter key, `limiterKey` of the
`getClientIp` address, see section 12), plus the M1 fields.

Two limiters per `registerGame`: `createLimiter` and `joinFailLimiter`
(`createIpLimiter` with the option values or constants).

Helper `roomOf(socket)`: `socket.data.roomId ? store.getRoom(roomId) : null`.
All handlers use it instead of `ROOM_ID`. `io.to(room.id)` uses the code as
the Socket.io room name (6-character codes cannot collide with 20-character
socket ids).

The timers entry gains `lobby`; `clearRoomTimers` clears it.
`startLobbyTimer(room)`: clear `lobby`, set `room.lobbyDeadline = now() +
lobbyTimeoutMs`, `setTimeout(safeTimer(() => onLobbyTimeout(room.id)),
lobbyTimeoutMs)`. `onLobbyTimeout(roomId)`: if the room is `waiting`, set
`room.closing = true`, collect the sockets first, emit `game:error
{ code: 'ROOM_EXPIRED', message: 'No race started; the room closed' }` to
each, then `socket.disconnect(true)` each. The disconnect path for a closing
room only removes the player (no host handover, no `room:state`) and deletes
the room when it is empty (section 12). `startCountdown` already calls
`clearRoomTimers`
(now also clearing `lobby`, and still clearing `rematch`, which is what
protects sat-out players from the old rematch timer); it also sets
`room.lobbyDeadline = null`. It works from `waiting` and from `finished`
(seating happens in `race.beginCountdown`).

`failEntry(socket, ack, code, message)` (renamed from `failJoin`): same
behaviour, used by create and join; the "already seated" condition becomes
`socket.data.roomId`.

`enterRoom(socket, room, player)`: `socket.data.roomId = room.id`,
`socket.data.playerId`, `clearJoinTimers`, `socket.join(room.id)`.

Handlers (each wrapped by `safeHandler`; emit order exactly as PROTOCOL.md):

- `onCreate(socket, payload, ack)`: no ack → `game:error BAD_PAYLOAD`;
  `validateCreate` fails → `failEntry BAD_PAYLOAD`; `socket.data.roomId` set
  → ack `ALREADY_JOINED` (no kick); `!createLimiter.consume(ip, now())` →
  `failEntry RATE_LIMITED`; `store.size() >= maxRooms` → `failEntry
  TOO_MANY_ROOMS`; `code = createUniqueCode((c) => store.getRoom(c) !== null,
  randomInt)`, `null` → `failEntry TOO_MANY_ROOMS`. Then `createRoom`,
  `addPlayer` (becomes host), `saveRoom`, `enterRoom`, `startLobbyTimer`, ack
  `{ ok: true, playerId, room: toSnapshot(room, now()) }`, `emitRoomState`.
- `onJoin(socket, payload, ack)`: no ack → `game:error`; `validateJoin` fails
  → `failEntry BAD_PAYLOAD`; `roomId` set → ack `ALREADY_JOINED`;
  `!joinFailLimiter.has(ip, now())` → `failEntry RATE_LIMITED`;
  `!isValidRoomCode(code)` → `consume`, `failEntry BAD_CODE`; no room →
  `consume`, `failEntry ROOM_NOT_FOUND`; `addPlayer` failure → `failEntry`
  with its code (`ROOM_FULL` before `RACE_IN_PROGRESS`). Success:
  `saveRoom`, `enterRoom`, `startLobbyTimer` if phase `waiting`, ack,
  `emitRoomState`, then `runReturnCheck` if phase `finished`.
- `onStart(socket, payload, ack)`: no ack → `game:error`; `validateStart`
  fails → ack `BAD_PAYLOAD`; `roomOf` / `findPlayer` → `NOT_IN_ROOM`;
  `race.canStart(room, player.id)` failure → ack its code. Success (phase
  `waiting` or `finished`): ack `{ ok: true }`, then `startCountdown(room)`
  (`room:state` with `inRace` flags, then `race:countdown`).
- `onExtend(socket, payload, ack)`: `BAD_PAYLOAD`, `NOT_IN_ROOM`,
  `NOT_WAITING`; success: `startLobbyTimer(room)`, ack `{ ok: true, room }`,
  `emitRoomState`.
- `onProgress`: as M1 with `roomOf`; `applyKeys` ignores players sitting out.
- `onRematch`: as M1 with `roomOf`. In `waiting`: ack `{ ok: true, room }`
  only. From `finished`: `setReady`, ack, `emitRoomState`, `runReturnCheck`.
  In `countdown`/`racing`: `NOT_FINISHED` (as M1; this is what a player
  sitting out gets if their Race again arrives after the host's start).
- `runReturnCheck(room)` (replaces `runStartCheck`): if
  `race.shouldReturnToWaiting(room)`: `clearRoomTimers`, `markWaiting`,
  `startLobbyTimer`, `saveRoom`, `emitRoomState`. It never starts a
  countdown.
- `onDisconnect`: `room = roomOf(socket)`.
  - `racing`: `removePlayer` (host reassigned inside). If no player is left
    at all: delete (M1). Else if `!race.hasConnectedRacer(room)` (only sat-out
    players remain): clear the race timers, `race.abandonRace(room)`,
    `startLobbyTimer`, `saveRoom`, `emitRoomState` (phase `waiting`), no
    `race:end`. Else: `emitRoomState`, then the end check (M1).
  - Otherwise: delete when empty; in `countdown` with fewer than
    `minPlayers` **racers** left (`race.racers(room).length`): clear timers,
    `cancelCountdown`, `startLobbyTimer`; then `emitRoomState`; then
    `runReturnCheck` when `finished`.
- Wiring: `room:create`, `room:join`, `room:start`, `room:extend`,
  `race:progress`, `race:rematch`, `disconnect`.

### 5.3 Protocol summary

| Event | Dir | Payload | Ack | Errors |
|-------|-----|---------|-----|--------|
| `room:create` | C→S | `{}` | `{ ok, playerId, room }` | BAD_PAYLOAD, ALREADY_JOINED, RATE_LIMITED, TOO_MANY_ROOMS |
| `room:join` | C→S | `{ code }` | `{ ok, playerId, room }` | BAD_PAYLOAD, ALREADY_JOINED, RATE_LIMITED, BAD_CODE, ROOM_NOT_FOUND, ROOM_FULL, RACE_IN_PROGRESS |
| `room:start` | C→S (host) | `{}` | `{ ok }` | BAD_PAYLOAD, NOT_IN_ROOM, NOT_HOST, RACE_IN_PROGRESS, NOT_ENOUGH_PLAYERS, PLAYERS_NOT_READY (finished: fewer than 2 ready, host counted) |
| `room:extend` | C→S | `{}` | `{ ok, room }` | BAD_PAYLOAD, NOT_IN_ROOM, NOT_WAITING |
| `race:progress` | C→S | `{ seq, keys }` | none | unchanged (sitting out: ignored) |
| `race:rematch` | C→S | `{}` | `{ ok, room }` | unchanged (NOT_FINISHED only in countdown/racing) |
| `room:state` | S→C | `RoomSnapshot` (+ code, hostId, minPlayers, expiresInMs; players + `inRace`) | | |
| `race:countdown`, `race:start`, `race:update`, `player:finish`, `race:end` | S→C | unchanged; racers only in entries; ignored by clients sitting out | | |
| `game:error` | S→C | `{ code, message }`; new server-initiated `ROOM_EXPIRED` | | |

### 5.4 Client design

#### `multiplayer.js` additions (pure)

- `MP_CONSTANTS` adds `roomCodeLength: 6`,
  `roomCodeAlphabet: 'ABCDEFGHJKMNPQRSTVWXYZ23456789'`,
  `lobbyWarningMs: 60000`, `lobbyWarningMarginMs: 3000`.
- `MP_LIMITS` adds `expiresInMsMax: 3600000`.
- `ROOM_CODE_PATTERN = /^[A-HJKMNP-TV-Z2-9]{6}$/`.
- `ROOM_CODE_FORMAT_MESSAGE =
  'Room codes have 6 letters and numbers, like K7QM2X. They never use 0, 1, I, L, O or U.'`
- `SOLO_TIP = 'Racing alone? Open the invite link in a second tab to try it out.'`
- `SIT_OUT_MESSAGE = "The host started a new race. You'll join the next one."`
- `normalizeRoomCode(input) -> string`: non-string → `''`; remove every
  whitespace character and `-`; `toUpperCase()`. `' k7q-m2x '` → `'K7QM2X'`.
- `isValidRoomCode(code) -> boolean`: string and pattern.
- `roomCodeInputError(input) -> string`: `''` when
  `isValidRoomCode(normalizeRoomCode(input))`; `'Enter a room code.'` when the
  normalised value is empty; otherwise `ROOM_CODE_FORMAT_MESSAGE`.
- `parseRoomHash(hash) -> string | null`: matches
  `/^#room=([A-Za-z0-9 -]{1,16})$/`; the capture normalised and validated,
  else `null`. `'#room=k7qm2x'` → `'K7QM2X'`; `''`, `'#'`, `'#room='`,
  `'#room=K7QM2'`, `'#room=K7QM2X&x=1'`, `'#ROOM=K7QM2X'`, `'#room=<b>'`,
  non-string → `null`.
- `buildShareLink(pageHref, code) -> string | null`: `null` unless
  `isValidRoomCode(code)`; `new URL(pageHref)` in try/catch; `null` unless
  `http:`/`https:`; `url.hash = 'room=' + code`; return `url.href` (keeps path
  and query, replaces any old hash).
- `spellRoomCode(code) -> string`: characters joined by single spaces
  (`'K7QM2X'` → `'K 7 Q M 2 X'`), for screen-reader text.
- `findSelf(room, selfId) -> PlayerSummary | null`.
- `isSittingOut(room, selfId) -> boolean`: `(room.phase === 'countdown' ||
  room.phase === 'racing')` and self exists with `inRace === false`.
- `readyCount(room, selfId) -> number`: players with `ready === true`, plus
  self if self is not ready (the host's Start counts as its Race again; for a
  non-host the number is never used).
- `canStartRace(room, selfId) -> boolean`: `room.hostId === selfId &&
  (room.phase === 'waiting' || room.phase === 'finished') &&
  room.players.length >= room.minPlayers && readyCount(room, selfId) >=
  room.minPlayers`.
- `startHint(room, selfId) -> string` (why Start race is disabled; `''` when
  it is enabled or self is not the host):
  - `canStartRace` → `''`; not host → `''`;
  - phase `countdown`/`racing` → `'A race is on. You can start the next one when it ends.'`;
  - `players.length < minPlayers` → `'Waiting for at least one more player.'`;
  - otherwise (phase `finished`, too few ready) →
    `'Waiting for at least one more player to press Race again.'`.
- `isAloneInLobby(room) -> boolean`: `room.phase === 'waiting' &&
  room.players.length === 1` (drives `SOLO_TIP`).
- `hostChangeText(prev, room, selfId, clientPhase) -> string` (the one host
  announcement for a `room:state`; `''` when there is nothing to say):
  - `''` if `prev` is `null`, `prev.hostId === room.hostId`, or
    `room.hostId === null`;
  - self became host: `'You are now the host.'` plus, by `clientPhase`:
    - `'waiting'` and `isSittingOut(room, selfId)`:
      `' You can start the next race when this one ends.'`;
    - `'waiting'`, otherwise: `' You can start the race.'` if
      `canStartRace`, else `' ' + startHint(room, selfId)`;
    - `'finished'`: `' Press Race again, then Start race.'`;
    - `'countdown'`/`'running'`: nothing more;
  - someone else became host: `` `${labelFor(room.hostId, selfId, room.players)} is now the host.` ``
    only when `clientPhase` is `'waiting'` or `'finished'`; `''` during
    `'countdown'`/`'running'` (the "(host)" label still moves; no speech
    mid-race for a change that does not affect this player).
- `labelFor(playerId, selfId, players)`: `'You'` for self, else
  `` `Player ${slot}` `` using that player's `slot` from `players`, or
  `'Player'` if not found. (Replaces "Opponent"/"Opponent N".)
- `validateRoomState`: adds `code` (`isValidRoomCode`), `minPlayers`
  (`1..maxPlayers`), `hostId` (`null`, or the id of one of the players; `null`
  only when `players` is empty), `expiresInMs` (`null`, or an integer
  `0..expiresInMsMax`; must be `null` unless `phase === 'waiting'`), and per
  player `inRace` (boolean; must be `false` for every player when `phase ===
  'waiting'`). Returns them in the clean copy.
- `validateJoinAck` is used for both create and join (same shape).
- New `validateRoomAck(data)` (`{ ok: true, room }` or the error form) for
  `room:extend`; `validateRematchAck` becomes an alias of it (export name
  kept).
- New `validateStartAck(data)`: `{ ok: true }` or the error form.
- `ERROR_MESSAGES` additions (all client-owned):
  - `BAD_CODE`: `ROOM_CODE_FORMAT_MESSAGE`
  - `ROOM_NOT_FOUND`: `'No room has that code. Check it, or ask for a new link: rooms close when everyone leaves.'`
  - `ROOM_FULL`: `'That room is full (4 players). Ask the host for a new room or try another code.'`
  - `RACE_IN_PROGRESS`: `'That room is in a race right now. Try again when it ends.'`
  - `TOO_MANY_ROOMS`: `'The game server is busy. Try again in a few minutes.'`
  - `NOT_HOST`: `'Only the host can start the race.'`
  - `NOT_ENOUGH_PLAYERS`: `'You need at least 2 players to start.'`
  - `PLAYERS_NOT_READY`: `'At least one more player needs to press Race again before you can start.'`
  - `NOT_WAITING`: `'The room is not waiting for a race.'`
  - `ROOM_EXPIRED`: `'The room closed because no race started for 10 minutes. You are playing solo.'`
  - `RATE_LIMITED`, `IDLE_TIMEOUT`, `UNREACHABLE`, `DISCONNECTED`: unchanged.
- Export every new function, `ROOM_CODE_PATTERN`, `ROOM_CODE_FORMAT_MESSAGE`,
  `SOLO_TIP` and `SIT_OUT_MESSAGE`.

#### `state` changes (`script.js`)

`createRaceState(session, race)`:

- `phase` default becomes `'menu'`:
  `'menu' | 'connecting' | 'waiting' | 'countdown' | 'running' | 'finished'`.
  Client phase `waiting` is "the room lobby view": shown while the room is
  `waiting`, while the room is `finished` and this player has pressed Race
  again (or joined after the race), and while the room is
  `countdown`/`racing` and this player sits out.
- New `mp` fields:
  - `intent: null` (`{ type: 'create' } | { type: 'join', code }`, set when
    connecting);
  - `menuError: null` (`{ code, field: 'join' | 'create' }`; `code` is a
    server code, or `'INPUT'` with `text` for a client-side code error);
  - `codeDraft: ''` (written into the input only when the menu is entered);
  - `startRequested: false`;
  - `lobbyDeadline: null`, `lobbyWarned: false`, `lobbyWarnTimerId: null`,
    `extendRequested: false`;
  - `copyStatus: ''`;
  - `startStatus: ''` (start failure text shown in `#race-status` until the
    next render that changes it).
- `newSession()` returns `{ playerId: null, room: null,
  instructionsSpoken: false }`. The room code is `session.room.code`.

Outside `state` (survives `restart()`): `let inviteCode = null;` (from the
hash; cleared when used or dismissed).

#### Flow

1. **Page load (`init`)**: if `MP_ENABLED` and
   `parseRoomHash(window.location.hash)` gives a code, set `inviteCode`,
   `renderInvite()`, and focus `#invite-join-btn` instead of the input. No
   server contact. Also `window.addEventListener('hashchange',
   handleHashChange)` (only when `MP_ENABLED`).
2. **Multiplayer pressed** → `startMultiplayer({ announceMenu = true } = {})`:
   the existing cleanup, then `state = createRaceState(newSession())`, phase
   `'menu'`, `mp.codeDraft = inviteCode || ''`, `renderMpError()`,
   `renderAll()`, `renderMenuInput()`, and if `announceMenu`, announce
   `'Multiplayer. Create a room, or join one with a code.'`. Then
   `prefetchSocketIo()`: `loadSocketIo(CONFIG.serverUrl, performance.now() +
   connectBudgetMs(CONFIG.serverUrl)).catch(() => {})` (silent; a failure
   resets the cache, so a later connect loads again). Focus stays on the mode
   button.
3. **Create** (`#create-room-btn`) → `connectToRoom({ type: 'create' })`.
   **Join** (`#join-form` submit, `preventDefault`) → `handleJoinSubmit`:
   read `dom.roomCodeInput.value`, `error = roomCodeInputError(value)`; if
   error: `mp.menuError = { code: 'INPUT', field: 'join', text: error }`,
   `renderMenu()`, `announce(error)`, focus stays in the input; else
   `connectToRoom({ type: 'join', code: normalizeRoomCode(value) })`.
   **Invite Join** (`#invite-join-btn`) → `handleInviteJoin`: `code =
   inviteCode`, `inviteCode = null`, `startMultiplayer({ announceMenu: false
   })`, then `connectToRoom({ type: 'join', code })`.
4. **`connectToRoom(intent)`** (the D cold-start code moved out of
   `startMultiplayer`): `clearConnectTimers()`; `mp.intent = intent`;
   `mp.menuError = null`; phase `'connecting'`; `mp.connectDeadline =
   performance.now() + connectBudgetMs(url)`; `renderAll()`; focus
   `#race-title` (the menu that had focus is now hidden); announce
   `'Connecting to the multiplayer server.'`; waking timer (remote only, as
   D); `loadSocketIo(url, mp.connectDeadline).then((io) => { if (state.mp ===
   mp) connectSocket(io); }, () => onSocketIoLoadFailed(mp))`.
   - `onSocketIoLoadFailed(mp)` (replaces `handleSocketIoLoadFailure`): ignore
     unless `state.mp === mp && phase === 'connecting' && mpSocket === null`.
     The cached load may be the prefetch with an earlier deadline, so:
     `delay = retryDelayWithin(performance.now(), mp.connectDeadline,
     wakeRetryDelayMs)`; `null` → `leaveMultiplayer('UNREACHABLE')`; else
     `connectRetryTimer = setTimeout(() => { if (state.mp === mp)
     loadSocketIo(url, mp.connectDeadline).then(...same...); }, delay)`.
5. **`onConnect`**: emits `'room:create'` with `{}` or `'room:join'` with
   `{ code }` from `mp.intent`, with the same `joinAckTimeoutMs` timeout and
   handling, into `onEntryAck` (renamed `onJoinAck`).
6. **`onEntryAck(raw)`**: `clearConnectTimers()`; `ack =
   validateJoinAck(raw)`; `null` → `leaveMultiplayer('BAD_RESPONSE')`.
   - Failure with a **menu code**: `BAD_CODE`, `ROOM_NOT_FOUND`, `ROOM_FULL`,
     `RACE_IN_PROGRESS` (field `'join'`), `TOO_MANY_ROOMS` (field
     `'create'`), `RATE_LIMITED` (field from `intent.type`) →
     `returnToMenu({ code, field, codeDraft })`, where `codeDraft` is the
     intent's code for joins. (`ROOM_FULL` therefore shows "That room is full
     (4 players). Ask the host for a new room or try another code." under the
     code input, with the code still in it.)
   - Any other failure → `leaveMultiplayer(code)` (solo, as M1).
   - Success: `session.playerId`, `session.room = ack.room`, phase
     `'waiting'`, `setLobbyDeadline(ack.room)`, `replaceHash(code)`,
     `renderAll()`.
     - Create: focus `#copy-link-btn`; `announceSoon('Room ' + spell + '
       created. Share the invite link. You can start the race when another
       player joins.')`. (The solo tip is visible text next to the link and
       is not added to this announcement, to keep it short.)
     - Join: focus `#race-title`; `announceSoon('Joined room ' + spell + '. '
       + (room.phase === 'finished' ? 'The others are on their results. You
       will race in the next one.' : 'Waiting for the host to start the
       race.'))`.
     - Neither text carries the race rule any more (it is said at the first
       countdown, see fix (b)).
7. **`returnToMenu({ code, field, codeDraft } = {})`**: `teardownSocket()`,
   `stopRaceTimers()`, `state = createRaceState(newSession())`, phase
   `'menu'`, `mp.menuError = code ? { code, field } : null`, `mp.codeDraft =
   codeDraft || ''`, `renderAll()`, `renderMenuInput()`. Focus: field
   `'join'` → `#room-code-input` (its `aria-describedby` includes the error,
   so it is read on focus; no extra announce); field `'create'` →
   `#create-room-btn`, with the text in `#menu-error` (`role="alert"`,
   unhidden before writing). **Leave room** (`#leave-room-btn`) →
   `leaveRoom()`: `returnToMenu()`, `replaceHash(null)`, focus
   `#create-room-btn`, announce `'You left the room.'`.
8. **`onRoomState(raw)`** additions (client phases `waiting`, `countdown`,
   `running`, `finished`; `menu` and `connecting` ignore it as now). Keep the
   previous snapshot (`prev = mp.session.room`) and `prevCanStart =
   canStartRace(prev, selfId)` before storing the new one.
   - **Sitting out:** if the client phase is `'finished'` and
     `isSittingOut(room, selfId)` (the host started without this player):
     `enterSittingOut()`: `state = createRaceState(session)` with phase
     `'waiting'` (this clears the rematch warning timer through
     `stopRaceTimers`, and any pending rematch ack is ignored by the
     `state.mp === mp` guard), `renderAll()`, move focus to `#race-title` if
     focus was inside the (now hidden) results card, and `announceSoon(
     SIT_OUT_MESSAGE)`. Return (no other announcement for this snapshot).
   - **One announcement per snapshot**, built from parts in this order and
     sent with a single `announce` call if non-empty:
     1. in client phase `waiting` only: `'Player N joined the room.'` /
        `'Player N left the room.'` for each id added or removed against
        `prev` (label from the snapshot the player appears in);
     2. `hostChangeText(prev, room, selfId, clientPhase)`;
     3. in client phase `waiting`, self is host, the host text (2) is empty,
        and `canStartRace` went from `false` (`prevCanStart`) to `true`:
        `'You can start the race now.'`.
     Example: host A leaves the lobby of B and C; B hears "Player 1 left the
     room. You are now the host. You can start the race."; C hears "Player 1
     left the room. Player 2 is now the host."
   - **Focus on a host change:** never moved. The new host's `#start-btn` is
     unhidden in place; nothing that had focus disappears (the old host is
     the one who left).
   - `setLobbyDeadline(room)`: `mp.lobbyDeadline = room.expiresInMs === null
     ? null : performance.now() + room.expiresInMs`; `mp.lobbyWarned =
     false`; `scheduleLobbyWarning()`. If a warning was showing and focus is
     on `#extend-btn` (about to be hidden), focus `#race-title`.
   - The M1 transitions stay, with new texts: countdown → waiting:
     `enterWaiting('A player left, so the race was cancelled. Back in the room.')`;
     finished → waiting (fallback; normally the rematch ack has already moved
     this client to the lobby, see item 11): `enterWaiting(rematchBackText())`.
     A client in the lobby view while the room was `racing` (sitting out)
     that gets `waiting` (race abandoned) or `finished` (race over) stays in
     the lobby view with no transition message; only the status line
     changes. `enterWaiting` calls `setLobbyDeadline(room)` after creating the
     state.
   - In client phase `finished`, if `prev.hostId !== room.hostId`, call
     `renderRaceResults()` so the "(host)" label moves on the results list
     (at most 4 rows, only on a host change).
   - Then `renderRacePanel()`, `renderRaceTracks()`, `renderLobby()`.
9. **Race events while sitting out:** `onRaceCountdown`, `onRaceStart`,
   `onRaceUpdate`, `onPlayerFinish` and `onRaceEnd` return at once when
   `isSittingOut(session.room, selfId)` or when the client phase is
   `'waiting'` and self's `inRace` is `false`. (`room:state` with phase
   `countdown` always arrives before `race:countdown`, so the flag is
   current.) A lobby-view player whose `inRace` is `true` (they pressed Race
   again, or joined) takes `race:countdown` exactly as M1.
10. **Start** (`#start-btn`, host only) → `requestStart()`: if
    `!canStartRace(room, selfId)`, announce `startHint(room, selfId)` (or
    `errorMessage('NOT_ENOUGH_PLAYERS')` if the hint is empty) and return
    (the button is `aria-disabled`); if `mp.startRequested`, return. Set it,
    `renderLobby()` (text `'Starting…'`, `aria-disabled`), then
    `socket.timeout(ackTimeoutMs).emit('room:start', {}, …)` into
    `onStartAck` (same `isCurrentSocket` / `state.mp === mp` guards as
    `requestRematch`). Failure or timeout: `startRequested = false`,
    `mp.startStatus = errorMessage(code)` (generic for a timeout or bad ack)
    shown in `#race-status` until the next render that changes it, and
    announced (clear, then next frame, as `onRematchAck`). Success: nothing
    (the `race:countdown` that follows replaces `state`).
11. **Race again** (`requestRematch`, results card): as M1, except the
    immediate status is `STATUS_BACK_TO_ROOM = 'Going back to the room…'`
    (never announced). On a successful ack: `mp.session.room = ack.room`,
    then `enterWaiting(rematchBackText())`, which moves this player to the
    room lobby view whatever the room phase (`finished` or `waiting`).
    `enterWaiting` moves focus to `#race-title` because the focused Race
    again button is hidden with the results card. `rematchBackText()`:
    - self is host and `canStartRace`: `'Back in the room. You can start the race.'`;
    - self is host otherwise: `'Back in the room. ' + startHint(room, selfId)`;
    - not host: `'Back in the room. Waiting for the host to start.'`.
    Failure: as M1 (`onRematchAck` error path; warning rescheduled). A
    `NOT_FINISHED` failure that arrives after this player was moved to the
    lobby by the host's start is dropped by the `state.mp === mp` guard.
12. **Lobby warning**: `scheduleLobbyWarning()` mirrors
    `scheduleRematchWarning()`: it fires at `lobbyDeadline - lobbyWarningMs -
    lobbyWarningMarginMs`. If still `waiting` with the same `mp`:
    `lobbyWarned = true`, `#extend-btn` shown, the status line gets
    `LOBBY_WARNING = 'No race has started, so this room closes in about 1 minute. Press Stay in room to keep it open.'`,
    announced once. **Stay in room** → `requestExtend()`: `room:extend` with
    `ackTimeoutMs`; `extendRequested` guards double presses. Success
    (`validateRoomAck`): the ack's room goes through `setLobbyDeadline`;
    announce `` `The room stays open for ${Math.round(expiresInMs / 60000)} more minutes.` ``.
    Failure: the status line shows the error text and is announced; the
    button stays.
13. **Countdown, race, results**: as M1, with "Player N" labels
    (`opponentSubject` is removed; "Player 2 left the race." reads fine).
    `rematchStatus(room)` (results card, self not ready) becomes N-player:
    - no other player left in the room:
      `'Everyone else left. Press Race again to go back to the room.'`
    - `n` = other players with `ready === true` (pressed Race again, joined,
      or sat out), `n > 0`:
      `` `${n} ${n === 1 ? 'player is' : 'players are'} back in the room.` ``
    - otherwise `''`.
    (The M1 "self ready" texts are gone: a ready player is no longer on the
    results card. `STATUS_WAITING_NEW_OPPONENT` is replaced by
    `STATUS_BACK_TO_ROOM`.)
14. **Leaving**: `leaveMultiplayer(code)` unchanged (solo), plus
    `replaceHash(null)`. Solo button, Back to solo, `IDLE_TIMEOUT`,
    `ROOM_EXPIRED` (remembered by `onGameError` like `IDLE_TIMEOUT`),
    `DISCONNECTED`, `UNREACHABLE` and `BAD_RESPONSE` all go there.
15. **Hash helpers**: `replaceHash(code)`: `try { history.replaceState(null,
    '', code ? buildShareLink(location.href, code) : location.pathname +
    location.search); } catch {}`. `handleHashChange()`: `code =
    parseRoomHash(location.hash)`; if `null`, return; if `state.mode ===
    'solo'`: `inviteCode = code`, `renderInvite()`; if phase `'menu'`:
    `mp.codeDraft = code`, `renderMenuInput()`; otherwise ignore (already in a
    room). `replaceState` does not fire `hashchange`, so our own updates never
    trigger it.
16. **Copy invite link** (`#copy-link-btn`, next to the code) →
    `copyInviteLink()`: `link = buildShareLink(location.href, room.code)`. If
    `navigator.clipboard && window.isSecureContext`:
    `navigator.clipboard.writeText(link).then(ok, fallback)`; else
    `fallback()`. `ok`: `mp.copyStatus = 'Invite link copied.'`,
    `renderLobby()`, announce it. `fallback`: focus and `select()`
    `#room-link`, `mp.copyStatus = "The link is selected. Copy it with your
    device's copy command."`, render, announce. Both callbacks check
    `state.mp === mp`. The status stays until the next copy or a new state.
17. **Invite dismiss** (`#invite-dismiss-btn`) → `handleInviteDismiss`:
    `inviteCode = null`, `replaceHash(null)`, `renderInvite()`,
    `focusInput()` (the banner that had focus is hidden).

#### Keyboard capture fix (required)

`handleKeydown` gets a new first line:
`if (isTextEntryTarget(event.target)) return;` with
`function isTextEntryTarget(target) { return target === dom.roomCodeInput || target === dom.roomLink; }`
(explicit element comparison, testable in the fake DOM). Without it, typing
a code would be swallowed and start a solo test, and Space or Enter in the
field would be blocked.

#### Rendering

- `renderPhase()`: in multi, `#race-panel` is visible in every phase except
  `finished`. The typing area as M1 (hidden in the lobby view, including
  while sitting out).
- New `renderLobby()` (from `renderAll`, `onRoomState` and the ack handlers;
  writes only what changed):
  - `#race-title` text: `'multiplayer'` in `menu`/`connecting`, `'race room'`
    otherwise (lowercase, like the existing `'race'`).
  - `#mp-menu` visible only in `menu`. `#room-info` and `#room-actions`
    visible only in client phase `waiting` (the lobby view, including
    sitting out; hidden during this player's own countdown and race to keep
    that screen calm).
  - `#room-code` text = code; `#room-code-spelled` = `'Room code ' +
    spellRoomCode(code)`; `#room-link` `.value` = the share link.
  - `#solo-tip`: text `SOLO_TIP` (set once), `hidden` unless
    `isAloneInLobby(room)`. Shown only while you are the only player in a
    `waiting` room: that is the only time the second-tab trick helps, and
    once someone joins the line is noise. It is plain text, not a live
    region, and only its `hidden` attribute is toggled when the value
    changes, so it is never announced by a render; screen-reader users find
    it right after the Copy button when reading the lobby.
  - `#start-btn` hidden unless self is host. `aria-disabled="true"` unless
    `canStartRace(room, selfId)` and not `startRequested`; text `'Starting…'`
    when `startRequested`, else `'Start race'`. `aria-describedby="start-hint"`
    (static, in the HTML).
  - `#start-hint` text = `startHint(room, selfId)`; hidden when empty (or
    self is not host). Not live; it is read when focus reaches Start race,
    and announced only when an aria-disabled Start is pressed.
  - `#extend-btn` hidden unless `lobbyWarned`; `aria-disabled` while
    `extendRequested`.
  - `#copy-status` text = `mp.copyStatus`.
- New `renderMenu()`: `#room-code-error` text from `menuError` with field
  `'join'` (`menuError.text` for `'INPUT'`, else `errorMessage(code)`),
  hidden when empty; `#room-code-input` gets `aria-invalid="true"` only with
  a join error (removed otherwise); `#menu-error` from field `'create'`
  (unhide before writing; clear and hide otherwise, as `renderMpError`).
- New `renderMenuInput()`: writes `mp.codeDraft` into `#room-code-input`
  `.value`. Called only when the menu is entered or the hash changes in the
  menu, never during typing.
- New `renderInvite()`: `#invite` visible only when `inviteCode !== null &&
  state.mode === 'solo'`; `#invite-code` text, `#invite-code-spelled` text
  (`spellRoomCode`). Called from `renderAll`.
- `raceStatusText()` adds (`mp.startStatus`, when set, replaces the text
  below):
  - `menu`: `''` (the menu speaks for itself; `#race-status` is empty).
  - `waiting` (lobby view), first match:
    - sitting out (`isSittingOut`): `SIT_OUT_MESSAGE`;
    - host, room `waiting`, alone: `'Share the code or link so others can join.'`;
    - host, room `waiting`, 2 or more:
      `` `${n} of ${max} players here. Press Start race when everyone is ready.` ``;
    - host, room `finished`:
      `` `${r} of ${n} players are back in the room. Players still on their results will join the next race.` ``
      (`r` = `readyCount`, `n` = players);
    - not host, room `finished`: `'Waiting for the host to start the next race…'`;
    - not host, room `waiting`: `'Waiting for the host to start the race…'`.
    When `lobbyWarned`, `LOBBY_WARNING` is appended after a space.
- `buildRaceTracks()`: name = `labelFor(...)` + (`player.id === room.hostId
  ? ' (host)' : ''`). In client phases `countdown`/`running` only racers
  (`inRace`) get a track; in the lobby view every player is listed.
  `trackKey` includes `hostId` and the listed ids, so a host change or a
  seating change rebuilds the names. `trackMetaText` in the lobby view:
  room `waiting` → `'in the room'`; room `finished` → `'in the room'` if
  `ready`, else `'on the results'`; room `countdown`/`racing` → `'racing'`
  if `inRace`, else `'sitting out'`.
- `renderRaceResults()`: the name of the row whose `id === room.hostId` gets
  `' (host)'` appended (built with `textContent`, as now).
- `renderTimer()`: `'menu'` also shows `'--'`.

#### Fixes folded in

- **(b)** `onRaceCountdown`: `announceSoon(text, () => {
  session.instructionsSpoken = true; })` instead of setting the flag first.
  The rule ("Fix every mistake to finish.") is said at the first countdown of
  the session, and again later only if that announcement was cancelled.
- **(c)** The comment at `script.js:436-439` becomes: "The race rule is
  spoken once per session, at the first countdown (onRaceCountdown), instead
  of living in this description, which focus would read at every countdown."

### 5.5 Accessibility

- **Keyboard flow:** Tab order: invite banner (if shown) → mode group →
  (multi) race panel. Menu: Create a room → Room code input → Join room.
  Room lobby: Copy invite link (next to the code) → Invite link field → Start
  race (host) → Stay in room (when shown) → Leave room. Results card as M1.
  Enter in the code input submits (it is a `<form>`). Escape does nothing in
  multi. Tab is never trapped.
- **Focus at each transition:** Multiplayer press: stays on the button.
  Create/Join → connecting: `#race-title`. Create success: `#copy-link-btn`.
  Join success: `#race-title`. Join failure (including `ROOM_FULL`): the code
  input. Create failure: Create button. Leave room: Create button.
  Countdown: the typing input (M1). Race end: results heading (M1). Race
  again → room lobby: `#race-title` (the results card that had focus is
  hidden; M1 `enterWaiting`). Host started without you (sitting out):
  `#race-title` if focus was in the results card. Host change: focus never
  moves. New deadline while focus is on the hidden Stay button:
  `#race-title`. Invite Join: `#race-title`. Invite dismiss: the typing
  input.
- **Announcements (polite `#announcer`, each once, one call per
  `room:state`):** menu opened; connecting and waking (D); room created or
  joined (code spelled out); player joined or left (lobby view only); host
  change ("You are now the host." with a short next step to the new host;
  "Player N is now the host." to others, only outside countdown and race);
  "You can start the race now." when Start becomes enabled for the host;
  sitting out (`SIT_OUT_MESSAGE`); back in the room after Race again; lobby
  warning; room kept open; copy result; start or extend failure; client-side
  code error; all M1 race announcements with "Player N". Not announced: the
  solo tip, the start hint (except when a disabled Start is pressed), track
  meta changes, ready counts. Errors that end multiplayer use `#mp-error`
  (alert); create errors use `#menu-error` (alert). The code error under the
  input is not live: it is read through `aria-describedby` when focus moves to
  the input, or announced once for a client-side error, where focus does not
  move.
- **Code input:** `<label for="room-code-input">Room code</label>`, hint
  `#room-code-hint` "6 letters and numbers, from your invite.",
  `autocomplete="off"`, `autocapitalize="characters"`, `autocorrect="off"`,
  `spellcheck="false"`, `inputmode="text"`, `enterkeyhint="go"`,
  `maxlength="16"`, CSS `text-transform: uppercase` and monospace.
  `novalidate` on the form (custom messages, no browser bubbles).
- **The code on screen** is `aria-hidden` (both the visible "Room code" word
  and the code) and paired with a visually hidden spelled-out version, so
  screen readers read "Room code K 7 Q M 2 X" once, not a word and not the
  label twice.
- **Buttons that look disabled** use `aria-disabled` and stay focusable;
  Start race is described by `#start-hint` ("Waiting for at least one more
  player." etc.), and a press announces that reason.
- **Contrast:** new text uses `--text`, `--text-dim`, `--error`. The code
  input and link field borders use `--text-dim` (at least 3:1 against
  `--surface` and `--bg` in both themes; `--border` is too faint for a form
  field boundary). Focus ring as the existing `:focus-visible`. The start
  hint and solo tip use `.hint` (`--text-dim`, already 4.5:1).
- **360px:** the menu stacks (Create full width; label, hint, then input and
  Join in a wrapping flex row, each at least 44px tall); room info: the code
  and Copy invite link share a wrapping flex row (at 360px Copy wraps to its
  own full-width line right under the code), then the link field full width,
  then the solo tip; Start / hint / Stay / Leave full width. Four track
  rows. No fixed widths; the link field uses `width: 100%; min-width: 0`.
- **Timing (WCAG 2.2.1):** the lobby expiry has a 60 s warning and a
  one-press extension, like the rematch timeout.

## 6. File-by-file changes

### Server changes (backend-builder: `server/`, not `server/test/`)

- **S1 `server/src/constants.js`:** as 5.2.
- **S2 `server/src/roomCode.js` (new):** as 5.2; `node:crypto` `randomInt` by
  default.
- **S3 `server/src/rateLimit.js`:** export `refill(bucket, now)` (the refill
  step), used by `takeToken` and `ipLimiter.has`. `takeToken` behaviour
  unchanged.
- **S4 `server/src/ipLimiter.js` (new):** as 5.2.
- **S5 `server/src/validate.js`:** `validateCreate`, `validateStart`,
  `validateExtend`, the new `validateJoin`.
- **S6 `server/src/roomStore.js`:** `size()`.
- **S7 `server/src/race.js`:** as 5.2: `createRoom(code, …)` with `hostId`,
  `lobbyDeadline`, `nextJoinSeq`; `joinSeq` and `inRace` on players;
  `reassignHost` by smallest connected `joinSeq`; `removePlayer` racing
  branch only for racers; `racers`, `hasConnectedRacer`; seating in
  `beginCountdown`; `inRace = false` in `cancelCountdown`/`markWaiting`;
  `abandonRace`; `applyKeys`, `isRaceOver`, `buildResults`, progress entries
  over racers only; `endRace` resets `ready` for racers only;
  `shouldReturnToWaiting` replacing `shouldStartCountdown`; `canStart` (new
  order, `finished` allowed); `isHost`; `toSnapshot(room, now)` with
  `inRace`. Export the new functions.
- **S8 `server/src/game.js`:** as 5.2. Remove every `ROOM_ID` use.
  `onStart` from `waiting` and `finished`; `startCountdown` clears the
  rematch and lobby timers; the countdown-cancel check counts racers; the
  racing disconnect path with `abandonRace`. Keep the emit orders in
  PROTOCOL.md exactly.
- **S9 `server/src/app.js`:** pass `ipOf` and the new options.
- **S10** `server/.env.example`, `config.js`, `index.js`, `package.json`: no
  change. No new dependencies.

### Server tests (server-tester: `server/test/`)

- **T1 `helpers.js`:** `client.create()` → `emitAck('room:create', {})`;
  `client.join(code)` → `emitAck('room:join', { code })`; `client.start()` →
  `emitAck('room:start', {})`; `client.extend()` → `emitAck('room:extend',
  {})`. `ctx.joined()`: the first call in a test creates a room and stores
  `ctx.code`; later calls join `ctx.code`. `ctx.racing()`: two joined
  clients, the host (the first) sends `start()`, then both wait for
  `race:start`. `FAST_OPTIONS` adds `lobbyTimeoutMs: 2000`. This keeps most
  M1 tests unchanged.
- **T2** Update the M1 tests that assumed the automatic start (send `start()`
  from the host), `ROOM_ID`/`'main'` (use `ctx.code` or a fixed valid code
  such as `'K7QM2X'`), `shouldStartCountdown` (now
  `shouldReturnToWaiting`; "finished, all ready, 2 players" now means
  "→ waiting", never "→ countdown"), unit tests that build rooms by hand and
  call `isRaceOver`/`buildResults`/`endRace` without `beginCountdown` (set
  `inRace: true` on the racers), and the M1 "both rematch → race starts"
  flow (now: both rematch → `waiting`, host `start()` → countdown).
- **T3** New files: `roomCode.test.js`, `ipLimiter.test.js`,
  `lobby.flow.test.js`, `lobby.host.test.js` (succession and rematch with
  sitting out), `lobby.limits.test.js` (section 9).

### Client changes (frontend-builder)

- **C1 `multiplayer.js`:** as 5.4 (including `SOLO_TIP`, `SIT_OUT_MESSAGE`,
  `findSelf`, `isSittingOut`, `readyCount`, `canStartRace`, `startHint`,
  `isAloneInLobby`, `hostChangeText`, `inRace` in `validateRoomState`, the
  new `ROOM_FULL` and `PLAYERS_NOT_READY` texts). Update the header comments
  of sections 2 and 4.
- **C2 `index.html`:**
  - At the top of `<main>`, before the toolbar:
    ```html
    <section id="invite" class="invite card" aria-labelledby="invite-title" hidden>
      <h2 id="invite-title" class="card-title">You're invited to a race</h2>
      <p id="invite-text">Room <span id="invite-code" class="room-code" aria-hidden="true"></span><span id="invite-code-spelled" class="visually-hidden"></span>. Joining connects to the game server, which can take up to a minute to wake up.</p>
      <button id="invite-join-btn" class="primary-btn" type="button" aria-describedby="invite-text">Join room</button>
      <button id="invite-dismiss-btn" class="secondary-btn" type="button">Not now</button>
    </section>
    ```
  - Inside `#race-panel`, right after `#race-title` (whose initial text
    becomes `multiplayer`):
    ```html
    <div id="mp-menu" class="mp-menu" hidden>
      <button id="create-room-btn" class="primary-btn" type="button">Create a room</button>
      <p class="mp-menu-or muted">or join a friend's room</p>
      <form id="join-form" class="join-form" novalidate>
        <label for="room-code-input" class="field-label">Room code</label>
        <p id="room-code-hint" class="hint">6 letters and numbers, from your invite.</p>
        <div class="join-row">
          <input id="room-code-input" class="code-input" type="text" maxlength="16"
                 autocomplete="off" autocapitalize="characters" autocorrect="off"
                 spellcheck="false" inputmode="text" enterkeyhint="go"
                 aria-describedby="room-code-hint room-code-error">
          <button id="join-room-btn" class="secondary-btn" type="submit">Join room</button>
        </div>
        <p id="room-code-error" class="field-error" hidden></p>
      </form>
      <p id="menu-error" class="load-error" role="alert" hidden></p>
    </div>
    <div id="room-info" class="room-info" hidden>
      <div class="room-code-row">
        <p class="room-code-line"><span aria-hidden="true">Room code</span>
          <span id="room-code" class="room-code" aria-hidden="true"></span>
          <span id="room-code-spelled" class="visually-hidden"></span></p>
        <button id="copy-link-btn" class="secondary-btn copy-btn" type="button">Copy invite link</button>
      </div>
      <p id="copy-status" class="hint"></p>
      <label for="room-link" class="field-label">Invite link</label>
      <input id="room-link" class="link-input" type="text" readonly>
      <p id="solo-tip" class="hint" hidden>Racing alone? Open the invite link in a second tab to try it out.</p>
    </div>
    ```
    The visible "Room code" word is wrapped in `<span aria-hidden="true">`
    (as above; do not drop it), so a screen reader reads only the
    visually hidden `#room-code-spelled` text, "Room code K 7 Q M 2 X", once.
    The Copy button sits in the same row as the code.
  - After `#race-tracks`:
    ```html
    <div id="room-actions" class="room-actions" hidden>
      <button id="start-btn" class="primary-btn" type="button" aria-describedby="start-hint" hidden>Start race</button>
      <p id="start-hint" class="hint" hidden></p>
      <button id="extend-btn" class="secondary-btn" type="button" hidden>Stay in room</button>
      <button id="leave-room-btn" class="secondary-btn" type="button">Leave room</button>
    </div>
    ```
- **C3 `script.js`:**
  - **S1** `MP_AVAILABLE` guard adds `typeof parseRoomHash === 'function'`,
    `typeof validateStartAck === 'function'` and
    `typeof hostChangeText === 'function'`.
  - **S2** `dom`: `invite`, `inviteCode`, `inviteCodeSpelled`,
    `inviteJoinBtn`, `inviteDismissBtn`, `mpMenu`, `createRoomBtn`,
    `joinForm`, `roomCodeInput`, `roomCodeError`, `menuError`, `roomInfo`,
    `roomCode`, `roomCodeSpelled`, `roomLink`, `copyLinkBtn`, `copyStatus`,
    `soloTip`, `roomActions`, `startBtn`, `startHint`, `extendBtn`,
    `leaveRoomBtn`.
  - **S3** `createRaceState`: new fields and the `'menu'` default (5.4);
    `newSession()`; `let inviteCode = null`.
  - **S4** `isTextEntryTarget` and the first line of `handleKeydown`.
  - **S5** `renderPhase`, `renderMode` (with comment fix (c)), `renderTimer`,
    `renderAll` (calls `renderLobby`, `renderMenu`, `renderInvite`).
  - **S6** New `renderLobby` (with `#solo-tip`, `#start-hint`),
    `renderMenu`, `renderMenuInput`, `renderInvite`; changes to
    `raceStatusText` (lobby texts in 5.4, `startStatus`), `buildRaceTracks`
    (racers only during the race, "(host)"), `renderRaceTracks` (`trackKey`
    with `hostId` and listed ids), `trackMetaText` (lobby meta texts),
    `renderRaceResults` ("(host)" on the results list), `rematchStatus`
    (5.4 flow 13); remove `opponentSubject`; replace
    `STATUS_WAITING_NEW_OPPONENT` with `STATUS_BACK_TO_ROOM`; add
    `LOBBY_WARNING`.
  - **S7** `startMultiplayer` (menu and prefetch), new `connectToRoom`,
    `prefetchSocketIo`, `onSocketIoLoadFailed` (replaces
    `handleSocketIoLoadFailure`), `onConnect` (create or join),
    `onEntryAck` (replaces `onJoinAck`), `returnToMenu`, `leaveRoom`.
  - **S8** `onRoomState` additions (sitting-out transition, one combined
    announcement with `hostChangeText` and "You can start the race now.",
    results re-render on a host change), `enterWaiting` (sets the lobby
    deadline), new `enterSittingOut`, `setLobbyDeadline`,
    `scheduleLobbyWarning`, `clearLobbyWarnTimer` (added to
    `stopRaceTimers`), `requestStart`, `onStartAck`, `requestExtend`,
    `onExtendAck`.
  - **S9** `onGameError`: remember `ROOM_EXPIRED` like `IDLE_TIMEOUT`.
  - **S10** `copyInviteLink`, `replaceHash`, `handleHashChange`,
    `handleJoinSubmit`, `handleInviteJoin`, `handleInviteDismiss`.
  - **S11** `init`: when `MP_ENABLED`, wire `#create-room-btn`, `#join-form`
    (`submit`), `#copy-link-btn`, `#start-btn`, `#extend-btn`,
    `#leave-room-btn`, `#invite-join-btn`, `#invite-dismiss-btn` and
    `hashchange`; read the hash; the focus rule in 5.4 flow 1.
  - **S12** Fix (b) in `onRaceCountdown`; the new join texts; the
    sitting-out guard at the top of `onRaceCountdown`, `onRaceStart`,
    `onRaceUpdate`, `onPlayerFinish`, `onRaceEnd` (5.4 flow 9).
  - **S13** `leaveMultiplayer` calls `replaceHash(null)`. The invite banner
    stays in solo (also while a solo test runs) until it is used or
    dismissed.
  - **S14** `requestRematch` / `onRematchAck`: `STATUS_BACK_TO_ROOM`
    immediately; on success `enterWaiting(rematchBackText())` (5.4 flow 11);
    new `rematchBackText`.
  - No `innerHTML`. No per-keystroke work added (the keydown guard is two
    comparisons).
- **C4 `style.css`:**
  - `.invite` (card spacing; its two buttons stack like the results card's),
    `.mp-menu`, `.mp-menu-or` (centred, `--text-dim`), `.join-form`,
    `.field-label` (`--text`, 0.875rem, `display: block`), `.join-row`
    (`display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: stretch`),
    `.join-row .code-input { flex: 1 1 10rem; min-width: 0 }`,
    `#join-room-btn { flex: 0 0 auto; width: auto; margin-top: 0 }`.
  - `.room-code-row { display: flex; flex-wrap: wrap; align-items: center;
    gap: 0.5rem 1rem }`, `.room-code-line { margin: 0 }`, `.copy-btn { flex:
    0 0 auto; width: auto; margin-top: 0; min-height: 44px }`. Below about
    400px the button wraps under the code; add `@media (max-width: 400px) {
    .copy-btn { width: 100% } }` (the only new breakpoint).
  - `.code-input, .link-input`: `background: var(--bg); color: var(--text);
    border: 1px solid var(--text-dim); border-radius: var(--radius);
    padding: 0.625rem 0.75rem; font-family: var(--font-mono); font-size: 1rem;
    min-height: 44px` (1rem stops the iOS zoom). `.code-input {
    text-transform: uppercase; letter-spacing: 0.15em }`. `.link-input {
    width: 100%; min-width: 0 }`.
  - `.code-input[aria-invalid="true"] { border-color: var(--error) }`;
    `.field-error { color: var(--error); margin: 0.5rem 0 0 }`.
  - `.room-code`: `font-family: var(--font-mono); font-size: 1.5rem;
    letter-spacing: 0.2em; color: var(--text)`; in `#invite-text`, 1rem.
  - `.room-info`, `.room-actions`: stacked with `gap: 0.5rem`; the buttons
    are full width as `.primary-btn` / `.secondary-btn` already are.
    `#start-hint { margin: 0 }`. `#start-btn[aria-disabled="true"]` uses the
    existing aria-disabled button style from M1's Race again.
  - Check 360px in both themes.

### Client tests (qa-tester: `tests/`)

- **Q1 `tests/helpers/load-script.js`:** add a `hash` option (default `''`)
  to `window.location` (and to `href`); a `history` stub recording
  `replaceState` calls; `navigator` (default without `clipboard`) and
  `isSecureContext` options. `window.addEventListener` already records
  `hashchange`.
- **Q2 `tests/multiplayer.test.js`:** the new pure functions and changed
  validators (section 9).
- **Q3 `tests/script-load.test.js`:** invite banner, no request before
  intent, the keydown guard, the menu, the room-info markup (section 9).

### Infra (devops-deployer)

- No `render.yaml` change, no new env vars. In `docs/DEPLOY.md`, update the
  verification "two-window race" step: window 1 presses Multiplayer, then
  Create a room; window 2 (or a second tab) opens the invite link and presses
  Join room; the host presses Start race.

### Docs (docs-writer)

- `README.md`: multiplayer section (create, Copy invite link, share link
  `#room=CODE`, join, host starts once 2 players are in, 2–4 players, after a
  race the host can start again with whoever pressed Race again and the rest
  join the next race, the host passes to the next player who joined, rooms
  close when empty or after 10 idle minutes); **a line telling visitors they
  can open the invite link in a second tab to race on their own** (for
  example: "On your own? Create a room, then open the invite link in a
  second tab to race yourself."); roadmap marks M2 ✓; list `roomCode.js` and
  `ipLimiter.js` under `server/src/`.

## 7. Build order

1. backend-builder: S1–S9. Run `npm test --prefix server`; the M1 tests that
   assume `ROOM_ID` or the automatic start are expected to fail until T1–T2.
   Report which ones.
2. server-tester: T1–T3, until `npm test --prefix server` fully passes.
3. frontend-builder: C1–C4; `node --check multiplayer.js script.js`.
   Existing `labelFor` tests will fail until Q2 (expected).
4. Reviews in parallel: backend-reviewer (code guessing, per-IP limits, host
   handover by join order, sitting-out players unable to affect a race,
   timers, kick rules, `toSnapshot` leaking no socket ids, IPs or `joinSeq`),
   code-reviewer (client), accessibility-auditor (menu, room lobby, Copy
   next to the code, solo tip, start hint, host-change and sit-out
   announcements, invite banner, focus moves, 360px). Fix loop, at most three
   rounds.
5. qa-tester: Q1–Q3, until `node --test tests/` fully passes.
6. devops-deployer: the DEPLOY.md step.
7. docs-writer: README.
8. No commit unless the user asks.

## 8. Edge cases

Server:

- **Create and join race each other:** Node handles one event at a time. A
  join that arrives after the last player left gets `ROOM_NOT_FOUND`.
- **Host leaves in the lobby:** the earliest-joined remaining player becomes
  host (not the lowest slot); `room:state` carries the new `hostId`; the
  lobby timer keeps running.
- **Host leaves mid-countdown:** with 2 or more racers left, host passes to
  the earliest-joined connected player (racing or sitting out) and the
  countdown continues. With fewer than 2 racers left: back to `waiting`,
  every `inRace = false`, lobby timer starts, and the earliest-joined
  remaining player is host. A sitting-out player leaving never cancels a
  countdown.
- **Host leaves mid-race:** marked disconnected (still in the results as
  "left"), host passes at once to the earliest-joined connected player, who
  may be sitting out; after `endRace` the new host can start the next race.
- **Host leaves during results:** host passes to the earliest-joined
  remaining player. If that player already pressed Race again, they are in
  the lobby view and get Start race at once (enabled if 2 or more are
  ready); if not, they hear "You are now the host. Press Race again, then
  Start race." The rematch timer is unchanged; if the new host never presses
  Race again, they are removed at 60 s like anyone else and the host passes
  again.
- **Host removed by the rematch timeout:** the removal passes the host by
  join order.
- **Only the host pressed Race again:** Start race stays aria-disabled with
  "Waiting for at least one more player to press Race again."; a forced
  `room:start` gets `PLAYERS_NOT_READY`. At 60 s the others are removed
  (`IDLE_TIMEOUT`), the return check moves the room to `waiting` with the
  host alone, the hint becomes "Waiting for at least one more player." and
  the solo tip shows.
- **Host has not pressed Race again but sends `room:start`** (scripted
  client) with one other player ready: accepted; the host counts as ready
  and races.
- **Every non-host is sitting out:** cannot be created by a start (a start
  needs at least 2 racers, so at least one non-host races). It can arise
  later: the only other racer leaves mid-countdown (fewer than 2 racers →
  `waiting`, everyone a lobby player) or mid-race (the host races on alone
  until finish or the time limit, as M1; sat-out players wait). If every
  racer disconnects mid-race while sat-out players remain: `abandonRace` →
  `waiting`, no `race:end`, the earliest-joined remaining player is host.
- **A player joins the lobby while the others are still on results:** added
  as ready, `inRace = false`, `expiresInMs: null`; their client is in the
  lobby view ("Waiting for the host to start the next race…"). They count as
  ready, so host + joiner can start; players still on results sit out.
- **Race again and Start at the same moment:** processed in order. If the
  rematch is first, that player races; if the start is first, they sit out
  and their rematch gets `NOT_FINISHED` (the client drops it; it has already
  moved to the lobby view).
- **Sitting-out player sends `race:progress`:** silently ignored; no
  `race:update` change. A sitting-out player disconnecting mid-race is
  removed and never appears in results.
- **Simultaneous finishes:** unchanged from M1 (one event at a time, places
  by processing order).
- **Fifth player:** `ROOM_FULL` in every phase, before `RACE_IN_PROGRESS`, so
  a full room that is racing still says "full".
- **Double Start:** the second `room:start` gets `RACE_IN_PROGRESS`.
- **Start while a player is leaving:** processed in order; if the leave comes
  first and too few remain, `NOT_ENOUGH_PLAYERS` (or `PLAYERS_NOT_READY` in
  `finished`).
- **Code collision:** retried; after 10 taken codes `TOO_MANY_ROOMS`.
- **Full store:** `TOO_MANY_ROOMS`; existing rooms are unaffected.
- **Guessing:** `BAD_CODE`/`ROOM_NOT_FOUND` cost per-IP tokens; at 0 tokens
  `RATE_LIMITED` comes before any lookup, and the socket is kicked, so every
  guess also costs a new connection (per-IP cap 10).
- **Second tabs from one browser:** up to four tabs fit the per-IP caps (4 of
  10 connections, 1 create token, no join-failure tokens).
- **Limiter memory:** idle buckets swept lazily; at 10,000 IPs the limiter
  fails open and warns.
- **Same socket creates twice, or creates then joins:** `ALREADY_JOINED`, no
  kick, the socket keeps its room.
- **Lobby expiry and a join at the same moment:** whichever is processed
  first wins; a join restarts the timer.
- **Late events:** `room:extend` outside `waiting` → `NOT_WAITING`;
  `race:progress` outside `racing` or from a sitting-out player ignored;
  `room:start` from a non-host → `NOT_HOST`; `race:rematch` in `countdown`/
  `racing` → `NOT_FINISHED`.
- **Cheating attempts in scope:** a client cannot choose its code (the server
  generates it), cannot start without being host, cannot make itself host
  (`joinSeq` is server-only and not sent), cannot race while sitting out,
  cannot claim scores; a `code` with odd characters, lowercase or extra
  length is `BAD_CODE` or `BAD_PAYLOAD`. Speed plausibility is M3.
- **Server restart:** all rooms and codes are gone; clients get
  `DISCONNECTED` (solo); a stale link gives `ROOM_NOT_FOUND`. A freed code may
  be issued again later, so a very old link could land in an unrelated room
  (probability about live rooms / 729 million): accepted.

Client:

- **Two tabs in the same browser:** two sockets, two players; allowed and now
  suggested by the solo tip. Each tab has its own state and hash.
- **Host change while focus is on a control:** focus stays; the new host's
  Start race appears in place.
- **Host change during the race:** the "(host)" label moves on the tracks;
  only the new host hears "You are now the host."
- **Sit-out while focus is on Race again or Back to solo:** the results card
  is hidden, focus goes to `#race-title`, `SIT_OUT_MESSAGE` is announced
  once; a late rematch ack is dropped.
- **Race events reaching a sitting-out client:** ignored; the typing area
  stays hidden.
- **Invite link with a malformed code:** no banner, solo as normal.
- **Invite link on `file://` or with no server URL:** `MP_ENABLED` is false,
  no banner.
- **Invite to a room that is gone or full:** Join → connecting → menu with
  the code kept and the inline error ("That room is full (4 players). Ask the
  host for a new room or try another code."); the user can create a room
  instead.
- **Typing in the code input:** never reaches the test (keydown guard);
  pasting a code is allowed (the paste block is only on `#hidden-input`).
- **Lowercase, spaces or a hyphen in the code:** normalised before sending.
- **Solo pressed while connecting** (create or join): the D cancel path.
- **Multiplayer, then Solo before choosing:** the prefetch is cancelled by
  `leaveMultiplayer` → `cancelSocketIoLoad()`.
- **Prefetch fails while the user is in the menu:** silent; Create/Join loads
  again within its own budget (`onSocketIoLoadFailed`).
- **Join error after a cold start:** the script is cached and the server is
  awake, so the next attempt is fast.
- **Clipboard denied or insecure context:** the link is selected in the
  read-only field, with instructions.
- **`hashchange` while in a room:** ignored.
- **Tab hidden in the lobby:** the deadline is a timestamp, so the warning
  fires late at worst; the 3 s margin covers normal throttling.
- **Corrupt `localStorage`, IME, mobile keyboards, fast typing:** unchanged.

## 9. Testing notes

### `server/test/` (server-tester)

Pure units:

- `roomCode.test.js`:
  - the alphabet has 30 unique characters, none of `0 1 I L O U`, and every
    character matches `/^[A-HJKMNP-TV-Z2-9]$/`;
  - `generateRoomCode(() => 0)` → `'AAAAAA'`; `generateRoomCode(() => 29)` →
    `'999999'`; 1000 codes from `crypto.randomInt` are all valid;
  - `isValidRoomCode`: `'K7QM2X'` true; `'k7qm2x'`, `'K7QM2'`, `'K7QM2XX'`,
    `'K7QM0X'`, `'K7QMOX'`, `'K7Q-M2'`, `''`, `null`, `123456` false;
  - `createUniqueCode`: a `randomInt` sequence that gives a taken code and
    then a free one returns the free one; `isTaken = () => true` returns
    `null` after exactly 10 codes (count the `isTaken` calls).
- `ipLimiter.test.js` (fake `now`): capacity 3, refill 0.05: three `consume`
  true, the fourth false, one more true after 20000 ms; `has` never takes a
  token; IPs are independent; `sweep` removes refilled buckets (`size()`
  drops); `maxEntries: 2` with a third IP and nothing sweepable → allowed
  (true) and `size()` stays 2.
- `rateLimit.test.js`: `refill` alone never exceeds capacity.
- `validate.test.js`: `validateJoin` accepts `{ code: 'K7QM2X' }`, `{ code:
  'x' }` (shape only), `{ code: 'a'.repeat(16) }`; rejects `{}`, `{ code: ''
  }`, `{ code: 'a'.repeat(17) }`, `{ code: 123 }`, `null`, `[]`,
  `undefined`, `'K7QM2X'`. `validateCreate`/`validateStart`/`validateExtend`
  accept `{}` and `undefined`; reject `null`, `[]`, `'x'`, `1`.
- `race.test.js`:
  - the first player is host; `joinSeq` is 1, 2, 3 for three adds and is not
    reused after a remove (remove 2, add → 4);
  - `reassignHost` **by join order, not slot**: A (slot 1, seq 1), B (slot
    2, seq 2), C (slot 3, seq 3); remove B; add D (slot 2, seq 4); remove A
    → host is C, not D. Also skips disconnected players (racing), gives
    `null` for none, returns `false` when the host is still present;
  - `canStart` order: non-host in `racing` → `NOT_HOST`; host in
    `countdown` → `RACE_IN_PROGRESS`; host alone in `waiting` →
    `NOT_ENOUGH_PLAYERS`; host alone in `finished` → `NOT_ENOUGH_PLAYERS`;
    `finished` with 3 players, only the host ready → `PLAYERS_NOT_READY`;
    `finished`, host not ready, B ready → ok (host counts); `finished`, host
    and B ready, C not → ok; `waiting` with 2 → ok;
  - `beginCountdown` from `finished` (host ready, B ready, C not ready): A
    and B `inRace: true`, C `inRace: false`, all three `ready: true`; only A
    and B have reset race fields; from `waiting`: everyone `inRace: true`;
  - `cancelCountdown`, `markWaiting`, `abandonRace`: every `inRace` false,
    every `ready` true; `abandonRace` removes disconnected players and
    reassigns the host;
  - `removePlayer` in `racing`: a racer → `removed: false`,
    `connected: false`; a sitting-out player → `removed: true`;
  - `applyKeys` for a sitting-out player → no change;
  - `isRaceOver`: racers A finished, B finished, sitting-out C connected and
    not finished → true; racer B not finished → false; no connected racer
    → false;
  - `buildResults` excludes sitting-out players;
  - `endRace`: racers `ready: false`, sitting-out players `ready: true`;
  - `shouldReturnToWaiting` (finished + all ready, even with 1 player →
    true; one not ready → false; phase `waiting` → false);
  - `toSnapshot(room, now)` has `code`, `hostId`, `minPlayers`,
    `expiresInMs` (waiting with deadline 5000 at now 2000 → 3000; countdown
    → `null`), per player `inRace` (all `false` in `waiting`), and no
    `socketId` or `joinSeq`.
- `roomStore.test.js`: `size()`.
- `constants.test.js`: `MAX_PLAYERS 4`, `MIN_PLAYERS 2`, `MAX_ROOMS 200`,
  `LOBBY_TIMEOUT_MS 600000`, no `ROOM_ID`, every new error code present.

Socket integration (`lobby.flow.test.js`, `lobby.host.test.js`,
`lobby.limits.test.js`, with `FAST_OPTIONS`):

- **Create:** ack `ok`, `room.code` valid, `room.hostId === playerId`, phase
  `'waiting'`, `expiresInMs > 0`, then exactly one `room:state`.
- **Join by code:** B joins A's code → ack `ok`; both get `room:state` with 2
  players; no `race:countdown` within 200 ms (no automatic start).
- **Host start:** B's `room:start` → `NOT_HOST`; A's → ack `{ ok: true }`,
  then both get `room:state` (countdown, both `inRace: true`),
  `race:countdown`, then `race:start`. A second `room:start` →
  `RACE_IN_PROGRESS`.
- **Start alone:** `NOT_ENOUGH_PLAYERS`.
- **Four players and a fifth:** four join; the fifth gets `ROOM_FULL` and is
  disconnected; a race of four ends with places 1–4. A fifth join while the
  four are **racing** also gets `ROOM_FULL` (not `RACE_IN_PROGRESS`).
- **Join during countdown or racing** (room not full): `RACE_IN_PROGRESS`,
  then disconnected.
- **Wrong code:** `'AAAAAA'` (not created) → `ROOM_NOT_FOUND` + disconnect;
  `'k7qm2x'` → `BAD_CODE`; `{ code: 5 }` → `BAD_PAYLOAD`.
- **Join-failure limit:** `joinFailLimit: { capacity: 2, refillPerSec: 0 }`:
  two `ROOM_NOT_FOUND`, the third → `RATE_LIMITED` even with a **valid,
  existing** code. Successful joins cost nothing: with capacity 1, join a real
  room from one socket, then a wrong code from another socket still gets
  `ROOM_NOT_FOUND`, not `RATE_LIMITED`.
- **Create limit:** `createLimit: { capacity: 1, refillPerSec: 0 }`: a second
  create from a new socket → `RATE_LIMITED` and disconnect.
- **Second tabs:** with the default per-IP limits (`createLimit`,
  `joinFailLimit`, `maxConnectionsPerIp` not overridden), one IP creates a
  room and three more sockets from the same IP join it; all four race.
- **Per-IP keys behind a proxy:** `trustProxyHops: 1`, create capacity 1:
  clients with `x-forwarded-for` `203.0.113.1` and `203.0.113.2` both create;
  a second `203.0.113.1` is limited.
- **Store cap:** `maxRooms: 1`: a second create → `TOO_MANY_ROOMS`; after the
  first room's only player disconnects, a create succeeds.
- **Collision:** `randomInt` injected so the first two codes are equal and the
  third differs: two creates get different codes.
- **ALREADY_JOINED:** create then create (or join) on the same socket →
  `ALREADY_JOINED`; the socket stays connected and in its room.

Host succession and rematch (`lobby.host.test.js`):

- **Succession by join order:** A creates; B, C join; B leaves; D joins (gets
  slot 2); A leaves → `room:state` has `hostId === C` (not D, despite D's
  lower slot); C's `room:start` (with D) is accepted.
- **Host leaves in `waiting`:** B gets `room:state` with `hostId === B`; B can
  start once C joins.
- **Host leaves mid-countdown:** with 3 racers the countdown continues to
  `race:start` and `hostId` is the earliest-joined remaining player; with 2
  the room goes back to `waiting` with `expiresInMs` not `null` and every
  `inRace` false.
- **Host leaves mid-race:** the `room:state` during racing has the new host
  (earliest joined); after `race:end` the new host rematches, B rematches,
  and the new host's start is accepted.
- **Rematch → waiting:** all rematch → second `room:state` with phase
  `waiting`; no countdown until the host starts.
- **Start with whoever pressed Race again:** A (host), B, C race; after
  `race:end` A and B rematch, C does not; A's `room:start` → ack ok;
  `room:state` (countdown) has A, B `inRace: true` and C `inRace: false,
  ready: true`; C still receives `race:countdown`; `race:update` entries and
  `race:end.results` contain only A and B; C's `race:progress` (even the full
  passage) changes nothing and never produces `player:finish`; C is **not**
  sent `IDLE_TIMEOUT` (use `rematchTimeoutMs` short enough to have fired
  during the new race); after that race ends, A and B are `ready: false`, C
  is `ready: true`.
- **Only the host pressed Race again:** A rematches, B and C do not; A's
  `room:start` → `PLAYERS_NOT_READY`; after `rematchTimeoutMs` B and C get
  `IDLE_TIMEOUT`, the room is `waiting` with A alone; A's `room:start` →
  `NOT_ENOUGH_PLAYERS`.
- **Host start counts as ready:** after `race:end`, B rematches, A (host) has
  not; A's `room:start` → ok, A and B race.
- **Host leaves during results:** B and C rematch; A leaves → `hostId === B`;
  B's `room:start` → ok with B and C racing.
- **Join while the others are on results:** A, B race; after `race:end`, D
  joins (ack room phase `finished`, D `ready: true, inRace: false`); A
  rematches; A's start → ok; A and D race, B sits out.
- **Race again after the start:** C's `race:rematch` sent after A's
  `room:start` → `NOT_FINISHED`.
- **Every racer leaves mid-race with a sat-out player connected:** A, B race,
  C sits out; A and B disconnect → C gets `room:state` with phase `waiting`,
  `hostId === C`, `expiresInMs` not `null`; no `race:end`.
- **Sitting-out player leaves mid-race:** removed from `room:state`; the race
  continues and ends normally; not in `race:end.results`.
- **Rematch timeout removes the host:** host not ready, B ready → the host
  gets `IDLE_TIMEOUT`, B becomes host, the room is `waiting` with B alone.

Lobby timer:

- **Lobby expiry:** `lobbyTimeoutMs: 200`: both players get `game:error
  ROOM_EXPIRED`, then disconnect; the code then answers `ROOM_NOT_FOUND`.
- **Extend:** `lobbyTimeoutMs: 300`; at 150 ms `room:extend` → ack with a
  fresh `expiresInMs` and `room:state` to both; no expiry at 350 ms; expiry
  by 550 ms. `room:extend` during racing → `NOT_WAITING`.
- **Join restarts the lobby timer;** a join to a `finished` room gives
  `expiresInMs: null`.
- **Two rooms are isolated:** progress in room 1 never reaches room 2's
  clients; `room:start` in room 1 affects only room 1.
- **Join timeout still applies:** a socket that never creates or joins is
  disconnected after `joinTimeoutMs`.
- **Timers cleared:** after `close()` with rooms in every phase, no timer
  fires (the existing pattern).

### `tests/` (qa-tester)

`multiplayer.test.js`:

- `normalizeRoomCode`: `' k7q-m2x '` → `'K7QM2X'`; `'K7 QM 2X'` →
  `'K7QM2X'`; `null`, `5` → `''`.
- `isValidRoomCode`: the server cases.
- `roomCodeInputError`: `''` and `'  '` → `'Enter a room code.'`; `'k7qm2'`
  and `'K7QM0X'` → `ROOM_CODE_FORMAT_MESSAGE`; `'k7q-m2x'` → `''`.
- `parseRoomHash`: the cases in 5.4.
- `buildShareLink`:
  `('https://prathambasu03-git.github.io/typing-speed-tester/', 'K7QM2X')` →
  `'https://prathambasu03-git.github.io/typing-speed-tester/#room=K7QM2X'`;
  an href with an old `#room=AAAAAA` → replaced;
  `'http://localhost:8080/index.html?x=1'` keeps path and query;
  `'file:///C:/index.html'` and `'not a url'` → `null`; an invalid code →
  `null`.
- `spellRoomCode('K7QM2X')` → `'K 7 Q M 2 X'`.
- `canStartRace`: host + 2 players + `waiting` → true; a non-host, 1 player,
  or phase `countdown`/`racing` → false; `finished`, 3 players, host and B
  ready → true; `finished`, host not ready, B ready → true; `finished`, only
  the host ready → false.
- `startHint`: host alone in `waiting` → `'Waiting for at least one more player.'`;
  `finished`, only the host ready → `'Waiting for at least one more player to press Race again.'`;
  `racing` → `'A race is on. You can start the next one when it ends.'`;
  `canStartRace` true → `''`; non-host → `''`.
- `readyCount`, `findSelf`, `isSittingOut` (`countdown` with self
  `inRace: false` → true; `inRace: true` → false; `finished` → false).
- `isAloneInLobby`: `waiting` with 1 player → true; 2 players → false;
  `finished` with 1 player → false.
- `hostChangeText`: `prev` null → `''`; same host → `''`; self becomes host
  in client `waiting` with 2 players in `waiting` → `'You are now the host. You can start the race.'`;
  alone → `'You are now the host. Waiting for at least one more player.'`;
  in client `finished` → `'You are now the host. Press Race again, then Start race.'`;
  in client `running` → `'You are now the host.'`; sitting out →
  `'You are now the host. You can start the next race when this one ends.'`;
  another player (slot 3) becomes host in client `waiting` or `finished` →
  `'Player 3 is now the host.'`; the same in `running` or `countdown` → `''`.
- `labelFor`: self → `'You'`; slot 3 → `'Player 3'`; unknown id →
  `'Player'`.
- `validateRoomState`: accepts a full M2 snapshot; rejects a missing or
  lowercase `code`, a `hostId` not among the players, `hostId: null` with
  players, `minPlayers` above `maxPlayers`, `expiresInMs` of `-1`, `3600001`,
  or non-null in `racing`, a player without boolean `inRace`, and a player
  with `inRace: true` in `waiting`.
- `validateJoinAck` (create and join shapes), `validateRoomAck`,
  `validateRematchAck` (alias), `validateStartAck`: well-formed, error form,
  bad shapes.
- `errorMessage` for every new code; `ROOM_FULL` is exactly
  `'That room is full (4 players). Ask the host for a new room or try another code.'`;
  `ROOM_EXPIRED` matches `/solo/i`.
- `SOLO_TIP` is exactly
  `'Racing alone? Open the invite link in a second tab to try it out.'`;
  `SIT_OUT_MESSAGE` is exactly `"The host started a new race. You'll join the next one."`.
- `MP_CONSTANTS`: `roomCodeLength 6`, the alphabet, `lobbyWarningMs 60000`,
  `lobbyWarningMarginMs 3000`; still frozen.

`script-load.test.js` (fake DOM; elements come from `index.html`):

- Page `https:` with meta `https://x.onrender.com` and hash `'#room=k7qm2x'`:
  `#invite` visible, `#invite-code` text `'K7QM2X'`, focus on
  `#invite-join-btn`, and **no `<script>` appended to `document.head`**.
- The same with hash `'#room=bad'`: `#invite` hidden, focus on
  `#hidden-input`.
- A `file:` page with a valid hash: `#invite` hidden.
- Pressing Multiplayer (call the `#mode` click listener with the multi
  button): `#mp-menu` and `#race-panel` visible, `#room-code-input` value is
  the invite code when there is one, and exactly one script whose `src` ends
  with `/socket.io/socket.io.js` is appended (the prefetch).
- Join submit with `'k7q'`: `#room-code-error` visible with
  `ROOM_CODE_FORMAT_MESSAGE`, `aria-invalid="true"` on the input, phase still
  `'menu'`, no socket attempted.
- The document `keydown` listener with `target` = `#room-code-input` and key
  `'a'`: `preventDefault` not called and the test state unchanged.
- Solo from the menu: back to solo; `history.replaceState` was called with a
  URL that has no hash.
- Markup: `#copy-link-btn` is inside the same `.room-code-row` as
  `#room-code`; the "Room code" text before `#room-code` is inside an
  element with `aria-hidden="true"`; `#solo-tip` text equals `SOLO_TIP` and
  is `hidden` and has no `aria-live`; `#start-btn` has
  `aria-describedby="start-hint"`.

## 10. Acceptance criteria

1. `npm test --prefix server` and `node --test tests/` both fully pass.
2. On `http://localhost:<port>` with the local server: Multiplayer → menu →
   Create a room shows a 6-character code with **Copy invite link** right
   next to it, the invite link `…#room=CODE` in a read-only field, and the
   line "Racing alone? Open the invite link in a second tab to try it out."
   Copy works, or selects the link with instructions when the clipboard is
   unavailable.
3. Only the host sees Start race, which is `aria-disabled` (still focusable)
   with "Waiting for at least one more player." while alone. A second tab
   opening the link sees the banner, presses Join room; both see two players
   with "(host)" on the creator; the solo tip disappears; the host hears
   "Player 2 joined the room. You can start the race now." and Start race is
   enabled.
4. The host starts; both race; results show; pressing Race again takes each
   player to the room lobby. With three players, the host and one other
   press Race again and the host starts: the third player leaves the results
   for the lobby with "The host started a new race. You'll join the next
   one.", has no track in that race, is not removed at 60 s, and races in the
   following one.
5. The host leaving (in the lobby, mid-countdown, mid-race and during
   results) passes the host to the next player who joined (not the lowest
   slot): everyone sees "(host)" move, the new host hears "You are now the
   host." and gets Start race, others in the lobby or on results hear
   "Player N is now the host.", and focus does not move.
6. Four players work; a fifth gets "That room is full (4 players). Ask the
   host for a new room or try another code." under the code input in the
   menu, with the code kept.
7. A wrong code shows the inline error and keeps the user in the menu with the
   code; a malformed code never contacts the server.
8. Opening a `#room=` link sends no request to the game server until Join
   room or Multiplayer is pressed (checked in the browser's network panel).
9. A lone player left in the lobby gets the warning after about 9 minutes
   with Stay in room; ignoring it ends in solo with the `ROOM_EXPIRED` text.
10. `docs/PROTOCOL.md` (M2) matches the server and client exactly; every event
    has its direction, payload, ack, errors and lifecycle effects, including
    `inRace`, join-order host succession and the `finished → countdown`
    start.
11. `README.md` tells visitors they can open the invite link in a second tab
    to race on their own.
12. No `innerHTML`, no new npm dependencies, no new env vars, no new
    `localStorage` keys; solo works from `file://`; no horizontal scroll at
    360px in both themes; every agent edited only its own files.

## 11. Out of scope

- Public lobby list, quick match, spectators (sitting-out players do not see
  live progress).
- Nicknames, avatars, chat.
- Kicking players, choosing or handing over the host, room settings (passage
  length, time limit).
- Reconnecting to a room after a dropped connection; rooms surviving a
  restart.
- Anti-cheat beyond validation and rate limits (M3).
- Redis, PostgreSQL, saved results, leaderboard, accounts (M4).
- Docker, CI (later). Web Share API.

## 12. Changes after review

Decided by the lead from the backend review. `docs/PROTOCOL.md` is now
version **M2 r2**. No event, payload or client change.

1. **Per-IP keys group IPv6 by /64** (PROTOCOL.md section 1, "Limiter key").
   - Server: the key for `MAX_CONNECTIONS_PER_IP`, the create bucket and the
     join-failure bucket is `limiterKey(getClientIp(...))`. IPv4 unchanged;
     IPv6 reduced to its /64 prefix (first four hextets of the fully
     expanded address, written like `2001:db8:1:2::/64`); anything else
     unchanged. `limiterKey` is a pure function next to `getClientIp` in
     `server/src/clientIp.js`.
   - Why: one IPv6 host normally controls a whole /64, so a full-address key
     would let it bypass every per-IP limit. People behind one IPv6 /64 share
     the limits, like people behind one IPv4 NAT.
   - Guessing cost (5.1 decision 4, PROTOCOL.md section 2) and the
     room-holding estimate (section 4, item (a)) are now stated per limiter
     key (one IPv4 address or one IPv6 /64); the numbers are unchanged.
   - Tests (server-tester): `limiterKey('203.0.113.7')` → `'203.0.113.7'`;
     `limiterKey('2001:db8:1:2::1')` and
     `limiterKey('2001:0db8:0001:0002:ffff:ffff:ffff:ffff')` give the same
     key (`'2001:db8:1:2::/64'`); `'2001:db8:1:3::1'` gives a different key;
     `'::1'` gives a /64 key; a non-IP string is returned unchanged.
     Integration, with `trustProxyHops: 1` and create capacity 1:
     `x-forwarded-for` `2001:db8:1:2::1` creates, `2001:db8:1:2::2` is
     `RATE_LIMITED`, `2001:db8:1:3::1` creates.
2. **Lobby expiry closes the room silently** (PROTOCOL.md section 3, "Lobby
   expiry closes the room silently", the `waiting | lobby timer fires` row,
   section 4 "Leaving", and `room:state` in section 5).
   - Server: when the lobby timer fires, set `room.closing = true`, emit
     `game:error ROOM_EXPIRED` to every player, then disconnect them all.
     While closing, the disconnect path only removes the player: no host
     handover, no checks, no `room:state`. The room is deleted (timers
     cleared) once empty.
   - Why: otherwise remaining players got misleading "Player 1 left / You are
     now the host" updates moments before their own expiry.
   - Unchanged: the rematch timeout (`IDLE_TIMEOUT`) still removes players
     one by one through the normal leave path, with `room:state` updates.
   - Tests (server-tester): `lobbyTimeoutMs: 200` with three players: each
     gets `game:error ROOM_EXPIRED` and then `disconnect`, and **no**
     `room:state` arrives at any of them after the timer fires; the code then
     answers `ROOM_NOT_FOUND`. The rematch-timeout tests that expect
     `room:state` after an `IDLE_TIMEOUT` removal stay as they are.
   - Client: no change. It already remembers `ROOM_EXPIRED` from
     `game:error` and falls back to solo with that message on the disconnect.
