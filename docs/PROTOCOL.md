# Multiplayer protocol (Socket.io)

This file is the single source of truth for every Socket.io event between the
client (project root) and the game server (`server/`). Both builders implement
it exactly. If code and this file disagree, the code is wrong.

Version: **M1 + D** (one room, two players, in-memory state, no persistence).
D (Deploy to Render) changes no events or payloads. It adds the client's
cold-start connection timings (sections 1 and 2) and proxy-aware per-IP
counting (section 1).

---

## 1. Transport

- Socket.io v4, default path `/socket.io`. The client script is served by the
  game server at `<server-url>/socket.io/socket.io.js`.
- **Connecting.** The client connects with `io(serverUrl, { transports: ['websocket'],
  reconnection: false, forceNew: true, timeout })`, where `timeout` is the time
  left in the initial-connection budget (at least 1000 ms). There is no
  Socket.io reconnection. Once a session has connected, a lost connection ends
  it and the client falls back to solo.
- **Initial connection and cold start.** A free Render instance sleeps when
  idle and can take about a minute to answer its first request.
  - The initial connection has one budget, counted from the moment the user
    presses Multiplayer. It covers loading `socket.io.js`, then the socket
    connect.
  - The budget is `WAKE_TIMEOUT_MS` for a remote server and
    `LOCAL_CONNECT_TIMEOUT_MS` for a loopback one.
  - Within the budget, the client retries a failed script load (an `error`
    event, a load that does not define `io`, or the attempt timing out) or a
    `connect_error`. It waits `WAKE_RETRY_DELAY_MS` before each retry, as
    long as the retry can start before the budget ends.
  - When the budget runs out, the client falls back to solo with
    `UNREACHABLE`.
  - The client sends no request to the server before the user presses
    Multiplayer. There is no warm-up on page load.
- **Ack timeouts.** After connecting, the `room:join` ack must arrive within
  `JOIN_ACK_TIMEOUT_MS`; otherwise the client treats it as `UNREACHABLE`. The
  `race:rematch` ack must arrive within `ACK_TIMEOUT_MS`; otherwise the
  rematch has failed, the client shows its generic message, and the button
  can be used again.
- `maxHttpBufferSize` on the server is **4096 bytes**. Larger packets are
  dropped by Socket.io and the connection is closed.
- **Origin check.** Both the Socket.io `cors` option and `allowRequest` use one
  function, `isAllowedOrigin(origin, config)`:
  - allowed: every origin listed in `CORS_ORIGINS`, by exact string match
    (default `https://prathambasu03-git.github.io`);
  - allowed when `ALLOW_LOCALHOST=true`: `http://localhost[:port]` and
    `http://127.0.0.1[:port]`;
  - allowed when `ALLOW_NULL_ORIGIN=true` (local dev only): the literal origin
    `null`, which a page opened from `file://` sends. The browser client no
    longer offers Multiplayer from `file://` (D), so only non-browser tools
    use this;
  - allowed: a missing `Origin` header (non-browser clients such as the tests).
    CORS protects browsers; it cannot stop a script that fakes headers;
  - anything else is refused. The client gets `connect_error`.
- **Concurrent connections per IP:** at most `MAX_CONNECTIONS_PER_IP` (default
  10), counted at the engine level. Extra connections are refused in
  `allowRequest`.
  - The client address is
    `getClientIp(req.socket.remoteAddress, req.headers['x-forwarded-for'], TRUST_PROXY_HOPS)`
    (`server/src/clientIp.js`).
  - With `TRUST_PROXY_HOPS=0` (the default), it is the socket's peer address
    and `X-Forwarded-For` is ignored.
  - With N > 0, it is the Nth entry from the right of `X-Forwarded-For`: the
    address that the outermost trusted proxy saw. If the header has fewer than
    N entries, the leftmost entry is used.
  - If the header is absent or the chosen entry is not a valid IP address, the
    peer address is used.
  - IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) are reduced to IPv4, and
    addresses are lowercased.
  - On Render, `TRUST_PROXY_HOPS=1`.
  - The same handshake request keys both the check and the count, so they
    always match.
- **Join timeout:** a connected socket that has not joined successfully within
  `JOIN_TIMEOUT_MS` is disconnected by the server, with no event first. The
  timer starts on connection and is cleared on a successful `room:join` and on
  disconnect. This timeout is also what closes sockets whose `room:join`
  failed without a next-tick disconnect (see `room:join` in section 4).

All timing is measured on the server with a monotonic clock
(`performance.now()`). The client never sends a time, WPM, accuracy,
position or "finished" flag.

---

## 2. Shared constants

| Name | Value | Owner | Meaning |
|------|-------|-------|---------|
| `ROOM_ID` | `'main'` | server | The single M1 room. Not sent to clients. |
| `MAX_PLAYERS` | `2` | server, sent in `room:state` | Room capacity. |
| `MIN_PLAYERS` | `2` | server | Players needed to start a countdown. |
| `COUNTDOWN_MS` | `3000` | server, sent as `startsInMs` | Countdown before a race. |
| `RACE_TIME_LIMIT_MS` | `120000` | server, sent as `raceTimeLimitMs` | A race ends at this time even if players have not finished. |
| `REMATCH_TIMEOUT_MS` | `60000` | server | Time a room may stay in `finished` before players who have not pressed "Race again" are disconnected (`IDLE_TIMEOUT`). |
| `JOIN_TIMEOUT_MS` | `10000` | server | Time a connected socket has to join successfully before it is disconnected. |
| `PASSAGE_WORD_COUNT` | `30` | server | Words in a passage, picked from `WORDS` (words.js). |
| `PASSAGE_MAX_LENGTH` | `1000` | both | Max passage length in UTF-16 units. Client rejects longer. |
| `PROGRESS_INTERVAL_MS` | `150` | client | Minimum gap between two `race:progress` events in normal typing. |
| `MAX_KEYS_PER_EVENT` | `64` | both | Max UTF-16 units in `race:progress.keys`. |
| `BROADCAST_INTERVAL_MS` | `200` | server | `race:update` cadence per room, only when something changed. |
| `RATE_LIMIT_CAPACITY` | `20` | server | Token-bucket size per socket (all events). |
| `RATE_LIMIT_REFILL_PER_SEC` | `10` | server | Tokens added per second. |
| `RATE_LIMIT_ERROR_INTERVAL_MS` | `1000` | server | At most one `game:error` RATE_LIMITED per socket per interval. |
| `SEQ_MAX` | `2147483647` | both | Largest allowed `seq`. |
| `WAKE_TIMEOUT_MS` | `90000` | client | Initial-connection budget (script load plus socket connect, with retries) for a remote server. Covers a cold start. |
| `LOCAL_CONNECT_TIMEOUT_MS` | `5000` | client | The same budget for a loopback server (`localhost`, `127.0.0.1`). |
| `WAKE_RETRY_DELAY_MS` | `3000` | client | Pause before retrying a failed script load or `connect_error` within the budget. |
| `WAKE_NOTICE_DELAY_MS` | `3000` | client | Pending time before the "Waking up the game server" message (remote servers only). Display only. |
| `JOIN_ACK_TIMEOUT_MS` | `10000` | client | Time the client waits for the `room:join` ack. |
| `ACK_TIMEOUT_MS` | `5000` | client | Time the client waits for the `race:rematch` ack. |
| `BACKSPACE` | `'\b'` (U+0008) | both | Encodes one Backspace inside `keys`. |

The server reads the timing constants from `server/src/constants.js`;
`createServer(options)` may override them (tests use short timers), including
`rematchTimeoutMs` and `joinTimeoutMs`. The client keeps its own copy of the
client-owned values in `multiplayer.js` (`MP_CONSTANTS`, in camelCase:
`wakeTimeoutMs`, `localConnectTimeoutMs`, `wakeRetryDelayMs`,
`wakeNoticeDelayMs`, `joinAckTimeoutMs`, `ackTimeoutMs`, …) and takes
everything else from server payloads.

---

## 3. Room lifecycle

States: `waiting → countdown → racing → finished`, and `finished → countdown`
(rematch) or `finished → waiting`.

Each player has `ready: boolean`. Joining sets `ready = true`. Entering
`finished` sets every player's `ready = false`. `race:rematch` sets it back to
`true`.

The **start check** (`shouldStartCountdown`) runs after every join, leave and
rematch (including an idempotent rematch while `waiting`) while the phase is
`waiting` or `finished`:

1. If every player in the room is ready and `players.length >= MIN_PLAYERS`:
   go to `countdown`.
2. Else, if the phase is `finished` and every player is ready (fewer than
   `MIN_PLAYERS`): go to `waiting`.
3. Else: stay.

**Picking the passage:** when entering `countdown` (`startCountdown`), if a
custom `pickPassage` throws or returns an invalid passage (not a non-empty
string within `PASSAGE_MAX_LENGTH`), the server logs it and uses the default
picker instead. Clients always receive a valid passage.

| From | Trigger | To | Server actions |
|------|---------|----|----------------|
| (none) | first `room:join` on an empty room | `waiting` | Create room, add player. |
| `waiting` | join, start check passes | `countdown` | Pick passage (with the fallback above), reset every player's race fields (`index`, `results`, counters, `lastSeq = 0`, `finishedAt = null`, `leftAt = null`, `place = null`), set a provisional `startAt = now + COUNTDOWN_MS`, start countdown timer, emit `room:state` then `race:countdown`. |
| `waiting` | the only player leaves | (deleted) | Remove the room from the store. |
| `countdown` | a player leaves (count < `MIN_PLAYERS`) | `waiting` | Clear the countdown timer, drop the passage, emit `room:state`. Remaining players stay `ready`. |
| `countdown` | countdown timer fires | `racing` | `beginRace(room, now)`: **reset `startAt = now`** (the moment the timer actually fired, so a late timer never shortens the race; all elapsed times are measured from here). Start race-limit timer (`RACE_TIME_LIMIT_MS`) and broadcast interval (`BROADCAST_INTERVAL_MS`), emit `room:state` then `race:start`. |
| `racing` | a player's typed text matches the whole passage | `racing` | Set `finishedAt`, `place = (finishers so far) + 1`, emit `player:finish`, mark room dirty, then run the end check. |
| `racing` | a player disconnects | `racing` | Set `connected = false`, `leftAt = now`. Their numbers freeze. Emit `room:state`. Then run the end check. |
| `racing` | end check: at least one connected player and every connected player has finished | `finished` | See "Ending a race". `reason: 'all_finished'`. |
| `racing` | race-limit timer fires | `finished` | See "Ending a race". `reason: 'time_limit'`. |
| `racing` | the last connected player disconnects | (deleted) | Clear every timer, delete the room. No `race:end` (nobody to receive it). |
| `finished` | `race:rematch` | `countdown` or `waiting` or stay | Set `ready = true`, ack, emit `room:state` (phase `finished`, this player `ready: true`), run the start check. If it moves the room to `waiting`, emit a second `room:state` (phase `waiting`); if it moves to `countdown`, emit `room:state` (phase `countdown`) then `race:countdown`. |
| `waiting` | `race:rematch` from a player who is already ready | `waiting` or `countdown` | Ack `ok: true`, then run the start check. No `room:state` unless the check changes the phase (then the normal `countdown` emits). |
| `finished` | rematch timer fires (`REMATCH_TIMEOUT_MS` after entering `finished`) | `finished`, `waiting`, `countdown` or (deleted) | For every player with `ready === false`: emit `game:error { code: 'IDLE_TIMEOUT', message }` to that socket, then `socket.disconnect(true)`. Each disconnect runs the normal `finished` leave path below (remove, `room:state`, start check). |
| `finished` | a player leaves | `finished` or `waiting` or (deleted) | Remove the player, emit `room:state`, run the start check. Delete the room if it is empty. |
| `finished` | `room:join` with space in the room | `finished` | Add the player as `ready`, emit `room:state`, run the start check (it starts only when the players still in the room also press rematch). |

**Ending a race:** clear the race-limit timer and the broadcast interval,
send one final `race:update`, compute results (section 6), set phase
`finished`, remove players with `connected = false`, reset `ready = false`
for everyone left, start the rematch timer (`REMATCH_TIMEOUT_MS`), then emit
`race:end` followed by `room:state`.

**Who can join:** only when the phase is `waiting` or `finished` and
`players.length < MAX_PLAYERS`.

**Timers:** per room, at most one countdown timer, one race-limit timer, one
broadcast interval and one rematch timer, all held in `server/src/game.js`.
Each is cleared on every transition out of its phase (the rematch timer on
every exit from `finished`, to `countdown` or `waiting`) and when the room is
deleted. Per socket, one join timer (section 1).

**Server restarts:** rooms live in memory. A restart, redeploy or Render
spin-down drops every room. Connected clients get `disconnect` and fall back
to solo with `DISCONNECTED`.

---

## 4. Client → server events

General rules for every client event:

- If the server's rate limit is exhausted, the event is dropped. If the last
  argument is a function (an ack), it is called with
  `{ ok: false, error: { code: 'RATE_LIMITED', message } }`; otherwise the
  server emits `game:error` `RATE_LIMITED` (at most once per
  `RATE_LIMIT_ERROR_INTERVAL_MS`).
- Unknown event names are ignored (they still cost a rate-limit token).
- Extra fields in a payload object are ignored.

### `room:join`

| | |
|---|---|
| Direction | client → server |
| When | Right after the socket connects, once per connection, within `JOIN_TIMEOUT_MS`. The client waits up to `JOIN_ACK_TIMEOUT_MS` for the ack. |
| Payload | `{}` (an empty object). `undefined` is also accepted. Any other type (string, number, array, `null`) is `BAD_PAYLOAD`. |
| Ack | **Required.** If no ack function is passed, the server emits `game:error` `BAD_PAYLOAD` and ignores the event. |
| Success ack | `{ ok: true, playerId: string, room: RoomSnapshot }` |
| Failure ack | `{ ok: false, error: { code, message } }` |
| Order | The server calls the ack first, then emits `room:state` to the room, then (if the start check passes) `room:state` (phase `countdown`) and `race:countdown`. |

Error codes, checked in this order:

| Order | Code | When |
|------:|------|------|
| 1 | `BAD_PAYLOAD` | Payload is not an object or `undefined`. |
| 2 | `ALREADY_JOINED` | This socket is already in the room. |
| 3 | `ROOM_FULL` | `players.length >= MAX_PLAYERS`. |
| 4 | `RACE_IN_PROGRESS` | The phase is `countdown` or `racing` (reachable only when `MAX_PLAYERS > MIN_PLAYERS`). |
| – | `RATE_LIMITED` | See general rules. |

`playerId` is a random opaque id from `crypto.randomUUID()`, never the
socket id.

What happens to the socket after a failed join:

| Failure | Answered by | Socket afterwards |
|---------|-------------|-------------------|
| `BAD_PAYLOAD` (ack passed) | join ack | Server disconnects it on the next tick, after the ack has been delivered. |
| `ROOM_FULL` | join ack | Server disconnects it on the next tick, after the ack has been delivered. |
| `RACE_IN_PROGRESS` | join ack | Server disconnects it on the next tick, after the ack has been delivered. |
| `ALREADY_JOINED` | join ack | **Stays connected.** The socket has already joined; disconnecting it would cost the player their seat. |
| `BAD_PAYLOAD` (no ack) | `game:error` | Stays connected; the join timeout (`JOIN_TIMEOUT_MS`) closes it. |
| `RATE_LIMITED` | join ack, or `game:error` if no ack | Stays connected; the join timeout closes it. |
| `INTERNAL` | join ack, or `game:error` if no ack | Stays connected; the join timeout closes it. |

The client disconnects after any failed join ack; the server enforces it for
`BAD_PAYLOAD`, `ROOM_FULL` and `RACE_IN_PROGRESS`.

### `race:progress`

| | |
|---|---|
| Direction | client → server |
| When | While the client phase is `running`, whenever it has buffered keys: at most one event per `PROGRESS_INTERVAL_MS`, except (a) immediately when adding a key would push the buffer past `MAX_KEYS_PER_EVENT`, (b) immediately when the local text matches the whole passage, and (c) immediately when the tab becomes hidden. |
| Payload | `{ seq: integer, keys: string }` |
| Ack | None. Errors come back as `game:error`. |

Fields:

| Field | Type | Rules |
|-------|------|-------|
| `seq` | integer | `1 <= seq <= SEQ_MAX`. Starts at 1 for every race and goes up by 1 per event. |
| `keys` | string | `1 <= keys.length <= MAX_KEYS_PER_EVENT` (UTF-16 units). Must be well-formed (`keys.isWellFormed()`, no lone surrogates). Must not contain U+0000–U+0007, U+0009–U+001F or U+007F–U+009F. U+0008 means Backspace. |

Each code point of `keys` is one keystroke, in order. The client only sends
keys it actually applied locally (a Backspace at position 0 is not sent).

How the server applies `keys` (`applyKeys` in `server/src/race.js`; this
mirrors `handleCharacter` and `handleBackspace` in `script.js`):

- **Backspace:** if `index > 0`: `index -= 1`, undo the counter for
  `results[index]` (`correctCount` or `incorrectCount`), set
  `results[index] = null`. `totalKeystrokes` and `correctKeystrokes` are
  **not** decreased. At `index === 0` it is ignored.
- **Any other code point:** if `index >= passage.length`, ignore it (not
  counted). Otherwise compare with `passage[index]`, set `results[index]` to
  `'correct'` or `'incorrect'`, update `correctCount`/`incorrectCount`,
  `totalKeystrokes += 1`, `correctKeystrokes += 1` if correct, `index += 1`.
- **Finish:** after each keystroke, if `index === passage.length` and
  `incorrectCount === 0`, the player has finished at the server's current
  time. Remaining keys in the same event are ignored.

Validation order: payload shape (`BAD_PAYLOAD`), then membership
(`NOT_IN_ROOM`), then the silent ignores below, then `applyKeys`. `lastSeq`
is updated only for events that pass validation.

Silently ignored (no error, expected during normal play):

- the phase is not `racing` (early keys during the countdown, late keys after
  the race ended);
- the player has already finished;
- `seq <= lastSeq` (duplicate or out-of-order).

Error codes (`game:error`):

| Code | When |
|------|------|
| `BAD_PAYLOAD` | Not a plain object, `seq` or `keys` missing or invalid. |
| `NOT_IN_ROOM` | This socket has not joined. |
| `RATE_LIMITED` | See general rules. |

### `race:rematch`

| | |
|---|---|
| Direction | client → server |
| When | The player presses "Race again" on the results card, within `REMATCH_TIMEOUT_MS` of `race:end` (otherwise the server disconnects the player with `IDLE_TIMEOUT`). The client waits up to `ACK_TIMEOUT_MS` for the ack. |
| Payload | `{}` or `undefined`. |
| Ack | **Required** (same rule as `room:join`). |
| Success ack | `{ ok: true, room: RoomSnapshot }`. Idempotent: a second call while already ready also returns `ok: true`. |
| Order | From `finished`: ack, then `room:state` (phase `finished`, this player `ready: true`), then one of: (a) if the start check moves the room to `countdown`: `room:state` (phase `countdown`) and `race:countdown`; (b) if it moves the room to `waiting`: `room:state` (phase `waiting`); (c) otherwise nothing more. From `waiting` with this player already ready: the ack, then the start check runs again; if it moves the room to `countdown`, `room:state` (phase `countdown`) and `race:countdown` follow, otherwise nothing more (no `room:state`). |

Error codes, checked in this order:

| Order | Code | When |
|------:|------|------|
| 1 | `BAD_PAYLOAD` | Payload is not an object or `undefined`. |
| 2 | `NOT_IN_ROOM` | This socket has not joined. |
| 3 | `NOT_FINISHED` | The phase is not `finished`. Exception: if the phase is `waiting` and this player is already ready (the room moved to `waiting` after this player's own rematch), the server returns `ok: true`. |
| – | `RATE_LIMITED` | See general rules. |

### Leaving

There is no leave event in M1. A client leaves by calling
`socket.disconnect()`. The server treats `disconnect` the same way for every
reason (closed tab, network loss, "Back to solo", a server-initiated
disconnect for `IDLE_TIMEOUT`, the join timeout or a failed join).

---

## 5. Server → client events

The client validates every payload with the `validate*` functions in
`multiplayer.js` and ignores any message that fails. The client never renders
a string it receives from the server (error `message` included); it builds
every visible label itself.

### Shared shapes

```
RoomSnapshot = {
  phase: 'waiting' | 'countdown' | 'racing' | 'finished',
  maxPlayers: integer (1..8),
  players: PlayerSummary[]          // 0..maxPlayers, sorted by slot
}

PlayerSummary = {
  id: string (1..64 chars),
  slot: integer (1..maxPlayers),    // lowest free slot at join; reused after a leave
  connected: boolean,               // false only during 'racing' after a disconnect
  ready: boolean,
  finished: boolean                 // finished the current/last race
}
```

### `room:state`

| | |
|---|---|
| Direction | server → every socket in the room |
| When | After every join, leave, rematch and phase change, except an idempotent rematch while `waiting` that does not change the phase (see `race:rematch`). |
| Payload | `RoomSnapshot` |

### `race:countdown`

| | |
|---|---|
| Direction | server → every socket in the room |
| When | On entering `countdown`, right after `room:state`. |
| Payload | `{ passage: string, startsInMs: integer, raceTimeLimitMs: integer }` |

| Field | Rules |
|-------|-------|
| `passage` | 1..`PASSAGE_MAX_LENGTH` UTF-16 units, words from `WORDS` joined by single spaces, no leading/trailing space. Client rejects control characters. |
| `startsInMs` | 0..10000. The client shows a countdown from its own clock: `countdownEndsAt = performance.now() + startsInMs`. Display only. |
| `raceTimeLimitMs` | 1000..600000. |

Typing is **not** unlocked by the local countdown; only `race:start` unlocks
it.

### `race:start`

| | |
|---|---|
| Direction | server → every socket in the room |
| When | When the countdown timer fires, right after `room:state` (phase `racing`). |
| Payload | `{ raceTimeLimitMs: integer }` (1000..600000) |

The server's `startAt` is the moment this event is sent (`beginRace(room, now)`),
not the time predicted at the countdown. The client sets its local
`startTime = performance.now()` and unlocks typing. Network latency means a
player starts slightly after the server clock; this is accepted in M1 (it is
the same order of delay for both players).

### `race:update`

| | |
|---|---|
| Direction | server → every socket in the room |
| When | During `racing`, every `BROADCAST_INTERVAL_MS`, only if any player's numbers changed since the last broadcast; plus one final update when the race ends. |
| Payload | `{ elapsedMs: integer, players: ProgressEntry[] }` |

```
ProgressEntry = {
  id: string,
  correctChars: integer (>= 0),           // results[] entries that are 'correct'
  progress: integer (0..100),             // Math.floor(correctChars * 100 / passage.length)
  wpm: integer (0..1000),                 // computeStats over max(elapsed, 1000) ms, clamped
  accuracy: integer (0..100),
  finished: boolean,
  place: integer (>= 1) | null
}
```

For a finished player, `wpm` and `accuracy` are their final values. For a
disconnected player, they are frozen at `leftAt`. See section 6 for how
elapsed time, the 1000 ms floor and clamping apply.

### `player:finish`

| | |
|---|---|
| Direction | server → every socket in the room |
| When | Immediately when a player finishes (not throttled). |
| Payload | `{ id: string, place: integer (>= 1), timeMs: integer (>= 0), wpm: integer (0..1000), accuracy: integer (0..100) }` |

`wpm` uses the 1000 ms floor and clamping from section 6; `timeMs` is the real
elapsed time.

### `race:end`

| | |
|---|---|
| Direction | server → every socket in the room |
| When | When the race ends, before the `room:state` with phase `finished`. |
| Payload | `{ reason: 'all_finished' \| 'time_limit', results: ResultEntry[] }` |

```
ResultEntry = {
  id: string,
  slot: integer,
  place: integer (1..n, unique, results sorted by place),
  status: 'finished' | 'unfinished' | 'left',
  wpm: integer (0..1000),
  rawWpm: integer (0..5000),
  accuracy: integer (0..100),
  correctChars: integer (>= 0),
  incorrectChars: integer (>= 0),
  timeMs: integer (>= 0)
}
```

`results` includes players who left during the race (`status: 'left'`), even
though they are removed from the room right after.

### `game:error`

| | |
|---|---|
| Direction | server → one socket |
| When | An event without an ack failed validation or was rate-limited; or, server-initiated, just before the server disconnects an idle player (`IDLE_TIMEOUT`). |
| Payload | `{ code: string, message: string }` |

`message` is English for logs and tests only. The client maps `code` to its
own text. After `IDLE_TIMEOUT` the socket is disconnected by the server; the
client shows its own message for `IDLE_TIMEOUT` and falls back to solo.

---

## 6. Results and finish order

Computed by `buildResults(room, now)` in `server/src/race.js`, using
`computeStats` from the shared `stats.js`. The same elapsed-time, floor and
clamping rules apply to `race:update`, `player:finish` and `race:end`.

- **Start of the clock:** `startAt` is the moment the countdown timer actually
  fired (`beginRace(room, now)`), not the time predicted at the countdown.
- **Elapsed time per player** (`elapsedMs`):
  - finished: `finishedAt - startAt`;
  - left: `leftAt - startAt`;
  - otherwise: `now - startAt` (at the moment of the broadcast, or when the
    race ends; that equals `RACE_TIME_LIMIT_MS` on a time-limit end).
- **Stats:** `wpm`, `rawWpm`, `accuracy`, `correctChars`, `incorrectChars`
  come from `computeStats({ results, totalKeystrokes, correctKeystrokes,
  duration: null }, Math.max(elapsedMs, 1000))`. The 1000 ms floor stops a
  very short time from producing a huge WPM.
- **Clamping:** after `computeStats`, `wpm` is clamped to 0..1000, `rawWpm` to
  0..5000 and `accuracy` to 0..100, matching the ranges in section 5.
- **`timeMs`** is the real `elapsedMs` (no floor), rounded to an integer.
- **Order:**
  1. finished players, by `place` (the order the server processed their
     finishing keystroke). Two finishes in the same millisecond still get
     different places, in processing order;
  2. unfinished connected players, by `correctChars` desc, then `accuracy`
     desc, then `slot` asc;
  3. players who left, same tie-breaks as 2.
- `place` in `race:end` is the 1-based position in this order.

---

## 7. Error codes (all)

| Code | Events | Meaning |
|------|--------|---------|
| `BAD_PAYLOAD` | all | Wrong type, missing field, out of range, too long, bad characters, missing ack. |
| `RATE_LIMITED` | all | Per-socket token bucket is empty. |
| `ROOM_FULL` | `room:join` | Room has `MAX_PLAYERS` players. |
| `RACE_IN_PROGRESS` | `room:join` | Phase is `countdown` or `racing`. |
| `ALREADY_JOINED` | `room:join` | This socket already joined. |
| `NOT_IN_ROOM` | `race:progress`, `race:rematch` | Socket has not joined. |
| `NOT_FINISHED` | `race:rematch` | Phase is not `finished`. |
| `IDLE_TIMEOUT` | server-initiated (`game:error`) | The player did not press "Race again" within `REMATCH_TIMEOUT_MS` of the race ending. Sent just before the server disconnects the socket. |
| `INTERNAL` | all | Unexpected server error (handler threw). Logged on the server. |

The client also uses two codes of its own, which the server never sends. They
only select a message in `errorMessage(code)`:

- `UNREACHABLE`: the script load and socket connect did not succeed within
  the initial-connection budget, including retries (section 1), or the
  `room:join` ack timed out.
- `DISCONNECTED`: the connection was lost after joining.

A connection refused for its origin or by the per-IP cap also ends as
`UNREACHABLE` once the budget runs out. The client cannot tell these refusals
apart from a sleeping server.

---

## 8. Validation rules (summary)

- Every handler validates before touching room state, with pure functions in
  `server/src/validate.js` that return `{ ok: true, value }` or
  `{ ok: false, code: 'BAD_PAYLOAD', message }`.
- "Plain object" means `typeof v === 'object' && v !== null &&
  !Array.isArray(v)`.
- Integers are checked with `Number.isInteger`; strings with
  `typeof === 'string'` (no coercion).
- Every handler is wrapped in `try/catch`; a throw answers `INTERNAL` (ack or
  `game:error`) and never crashes the process.
- Client-side, `multiplayer.js` validates every server payload against the
  shapes in section 5 and drops messages that fail.
