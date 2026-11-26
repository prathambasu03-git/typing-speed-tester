# Multiplayer protocol (Socket.io)

This file is the single source of truth for every Socket.io event between the
client (project root) and the game server (`server/`). Both builders implement
it exactly. If code and this file disagree, the code is wrong.

Version: **M2 r2** (private rooms by code, 2–4 players, host starts the race,
in-memory state, no persistence). Replaces M1 + D. The client and server ship
together, so M2 is a clean break: an M1 client cannot talk to an M2 server.
r2 (after the backend review): per-IP keys group IPv6 addresses by /64
(section 1), and lobby expiry closes the room silently (section 3). Neither
changes an event or payload.

What changed from M1 + D, in short:

- New events `room:create`, `room:start`, `room:extend`. `room:join` now takes
  `{ code }`.
- `RoomSnapshot` gains `code`, `hostId`, `minPlayers` and `expiresInMs`;
  `PlayerSummary` gains `inRace`.
- The race no longer starts by itself: the host sends `room:start`.
- After a race, the host can start the next race as soon as at least
  `MIN_PLAYERS` players (the host included) have pressed "Race again". Players
  who have not pressed it stay in the room and **sit out** that race; they race
  in the next one. When every remaining player has pressed "Race again", the
  room goes back to `waiting` (the room lobby). It never goes straight to
  `countdown`.
- The host passes to the **earliest-joined** remaining player (join order, not
  slot).
- New lobby idle timeout (`LOBBY_TIMEOUT_MS`) with `ROOM_EXPIRED`.
- Per-IP limits on room creation and on failed join attempts.
- New error codes: `BAD_CODE`, `ROOM_NOT_FOUND`, `TOO_MANY_ROOMS`, `NOT_HOST`,
  `NOT_ENOUGH_PLAYERS`, `PLAYERS_NOT_READY`, `NOT_WAITING`, `ROOM_EXPIRED`.

---

## 1. Transport

- Socket.io v4, default path `/socket.io`. The client script is served by the
  game server at `<server-url>/socket.io/socket.io.js`.
- **Connecting.** The client connects with `io(serverUrl, { transports: ['websocket'],
  reconnection: false, forceNew: true, timeout })`, where `timeout` is the time
  left in the initial-connection budget (at least 1000 ms). There is no
  Socket.io reconnection. Once a session has joined a room, a lost connection
  ends it and the client falls back to solo.
- **One socket, at most one room.** A socket enters a room only through a
  successful `room:create` or `room:join`, and stays in that room until it
  disconnects. To change rooms, the client disconnects and connects again.
- **No request before intent.** The client sends nothing to the server before
  the user presses **Multiplayer** (the mode button) or **Join room** on an
  invite banner. Pressing Multiplayer starts loading `socket.io.js` in the
  background (this wakes a sleeping server while the user chooses); the socket
  itself connects only when the user presses **Create a room** or **Join
  room**. A `#room=` link alone never contacts the server.
- **Initial connection and cold start.** A free Render instance sleeps when
  idle and can take about a minute to answer its first request.
  - The initial connection has one budget, counted from the moment the user
    presses Create or Join. It covers loading `socket.io.js` (if the
    background load has not finished) and the socket connect.
  - The budget is `WAKE_TIMEOUT_MS` for a remote server and
    `LOCAL_CONNECT_TIMEOUT_MS` for a loopback one.
  - Within the budget, the client retries a failed script load (an `error`
    event, a load that does not define `io`, or the attempt timing out) or a
    `connect_error`. It waits `WAKE_RETRY_DELAY_MS` before each retry, as
    long as the retry can start before the budget ends.
  - When the budget runs out, the client falls back to solo with
    `UNREACHABLE`.
- **Ack timeouts.** After connecting, the `room:create` or `room:join` ack must
  arrive within `JOIN_ACK_TIMEOUT_MS`; otherwise the client treats it as
  `UNREACHABLE`. The `race:rematch`, `room:start` and `room:extend` acks must
  arrive within `ACK_TIMEOUT_MS`; otherwise the action has failed, the client
  shows its generic message, and the button can be used again.
- `maxHttpBufferSize` on the server is **4096 bytes**. Larger packets are
  dropped by Socket.io and the connection is closed.
- **Origin check.** Both the Socket.io `cors` option and `allowRequest` use one
  function, `isAllowedOrigin(origin, config)`:
  - allowed: every origin listed in `CORS_ORIGINS`, by exact string match
    (default `https://prathambasu03-git.github.io`);
  - allowed when `ALLOW_LOCALHOST=true`: `http://localhost[:port]` and
    `http://127.0.0.1[:port]`;
  - allowed when `ALLOW_NULL_ORIGIN=true` (local dev only): the literal origin
    `null`. The browser client never offers Multiplayer from `file://`, so
    only non-browser tools use this;
  - allowed: a missing `Origin` header (non-browser clients such as the tests).
    CORS protects browsers; it cannot stop a script that fakes headers;
  - anything else is refused. The client gets `connect_error`.
- **Client IP.** Every per-IP rule (the connection cap below and the limits in
  section 4) starts from one client address:
  `getClientIp(req.socket.remoteAddress, req.headers['x-forwarded-for'], TRUST_PROXY_HOPS)`
  (`server/src/clientIp.js`), computed from the handshake request.
  - With `TRUST_PROXY_HOPS=0` (the default), it is the socket's peer address
    and `X-Forwarded-For` is ignored.
  - With N > 0, it is the Nth entry from the right of `X-Forwarded-For`. If the
    header has fewer than N entries, the leftmost entry is used.
  - If the header is absent or the chosen entry is not a valid IP address, the
    peer address is used.
  - IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) are reduced to IPv4, and
    addresses are lowercased.
  - On Render, `TRUST_PROXY_HOPS=1`. If it were 0 there, every client would
    share the proxy's address, and one client's failed joins would lock
    everyone out of joining.
- **Limiter key: IPv6 grouped by /64.** The key used for
  `MAX_CONNECTIONS_PER_IP`, the create bucket (`CREATE_LIMIT_*`) and the
  join-failure bucket (`JOIN_FAIL_LIMIT_*`) is the address from `getClientIp`
  passed through `limiterKey(ip)` (next to `getClientIp` in
  `server/src/clientIp.js`):
  - IPv4: unchanged (`203.0.113.7` → `203.0.113.7`). An IPv4-mapped address
    `::ffff:a.b.c.d` maps to the IPv4 key `a.b.c.d`.
  - IPv6: a `%zone` suffix is stripped first. Then the address is reduced to
    its /64 prefix: the first four hextets of the fully expanded address, each
    in lowercase hex without leading zeros, joined by `:` and followed by
    `::/64`. The prefix is never compressed further, so zero hextets stay
    `0`. Examples: `2001:db8:1:2::1` and
    `2001:0db8:0001:0002:ffff:ffff:ffff:ffff` both give `2001:db8:1:2::/64`;
    `2001:db8:1:3::1` gives `2001:db8:1:3::/64`; `::1` gives `0:0:0:0::/64`;
    `fe80::1%eth0` gives `fe80:0:0:0::/64`. The key never leaves the server.
  - Anything else (not a valid IP, for example `'unknown'`) is used unchanged.
  - Why: one IPv6 host normally controls a whole /64 (2^64 addresses), so a
    full-address key would let it bypass every per-IP limit by changing its
    source address.
  - Cost: people behind one IPv6 /64 share these limits, just like people
    behind one IPv4 NAT share them.
  - In this file, "per IP" always means "per limiter key".
- **Concurrent connections per IP:** at most `MAX_CONNECTIONS_PER_IP` (default
  10), counted at the engine level. Extra connections are refused in
  `allowRequest`. The same handshake request keys both the check and the
  count.
- **Several tabs in one browser** are several sockets from one IP. A full room
  of four tabs uses 4 of the 10 connections, one create token and no
  join-failure tokens, so "open the invite link in a second tab" (the solo
  try-out the UI suggests) always fits within the limits.
- **Join timeout:** a connected socket that has not entered a room (a
  successful `room:create` or `room:join`) within `JOIN_TIMEOUT_MS` is
  disconnected by the server, with no event first. The timer starts on
  connection and is cleared on success and on disconnect.

All timing is measured on the server with a monotonic clock
(`performance.now()`). The client never sends a time, WPM, accuracy,
position or "finished" flag.

---

## 2. Shared constants

| Name | Value | Owner | Meaning |
|------|-------|-------|---------|
| `MAX_PLAYERS` | `4` | server, sent as `maxPlayers` | Room capacity. |
| `MIN_PLAYERS` | `2` | server, sent as `minPlayers` | Players (and, after a race, ready players) needed before the host can start. |
| `MAX_ROOMS` | `200` | server | Rooms the in-memory store may hold at once. |
| `ROOM_CODE_LENGTH` | `6` | both | Characters in a room code. |
| `ROOM_CODE_ALPHABET` | `'ABCDEFGHJKMNPQRSTVWXYZ23456789'` | both | 30 characters: A–Z without I, L, O, U, and 2–9. No 0 or 1. |
| `ROOM_CODE_PATTERN` | `/^[A-HJKMNP-TV-Z2-9]{6}$/` | both | A canonical room code. |
| `ROOM_CODE_INPUT_MAX` | `16` | server | Longest `code` string accepted in a `room:join` payload before the format check. |
| `ROOM_CODE_MAX_ATTEMPTS` | `10` | server | Random codes tried before `room:create` gives up with `TOO_MANY_ROOMS`. |
| `COUNTDOWN_MS` | `3000` | server, sent as `startsInMs` | Countdown before a race. |
| `RACE_TIME_LIMIT_MS` | `120000` | server, sent as `raceTimeLimitMs` | A race ends at this time even if players have not finished. |
| `REMATCH_TIMEOUT_MS` | `60000` | both | Time a room may stay in `finished` before players who raced and have not pressed "Race again" are disconnected (`IDLE_TIMEOUT`). Cleared when the host starts the next race. |
| `LOBBY_TIMEOUT_MS` | `600000` | server, sent as `expiresInMs` | Time a room may stay in `waiting` without a race starting (or a join, or `room:extend`) before every player is disconnected (`ROOM_EXPIRED`). |
| `JOIN_TIMEOUT_MS` | `10000` | server | Time a connected socket has to create or join a room before it is disconnected. |
| `CREATE_LIMIT_CAPACITY` | `3` | server | Per-IP bucket for `room:create` attempts. |
| `CREATE_LIMIT_REFILL_PER_SEC` | `0.05` | server | One create token every 20 s per IP. |
| `JOIN_FAIL_LIMIT_CAPACITY` | `10` | server | Per-IP bucket for **failed** `room:join` attempts (`BAD_CODE`, `ROOM_NOT_FOUND`). |
| `JOIN_FAIL_LIMIT_REFILL_PER_SEC` | `1 / 6` | server | One join-failure token every 6 s per IP (10 per minute). |
| `IP_LIMIT_MAX_ENTRIES` | `10000` | server | Most IPs tracked by each per-IP limiter. |
| `IP_LIMIT_SWEEP_MS` | `60000` | server | Least time between two sweeps of full (idle) per-IP buckets. |
| `PASSAGE_WORD_COUNT` | `30` | server | Words in a passage, picked from `WORDS` (words.js). |
| `PASSAGE_MAX_LENGTH` | `1000` | both | Max passage length in UTF-16 units. Client rejects longer. |
| `PROGRESS_INTERVAL_MS` | `150` | client | Minimum gap between two `race:progress` events in normal typing. |
| `MAX_KEYS_PER_EVENT` | `64` | both | Max UTF-16 units in `race:progress.keys`. |
| `BROADCAST_INTERVAL_MS` | `200` | server | `race:update` cadence per room, only when something changed. |
| `RATE_LIMIT_CAPACITY` | `20` | server | Token-bucket size per socket (all events). |
| `RATE_LIMIT_REFILL_PER_SEC` | `10` | server | Tokens added per second. |
| `RATE_LIMIT_ERROR_INTERVAL_MS` | `1000` | server | At most one `game:error` RATE_LIMITED per socket per interval. |
| `SEQ_MAX` | `2147483647` | both | Largest allowed `seq`. |
| `WAKE_TIMEOUT_MS` | `90000` | client | Initial-connection budget for a remote server. |
| `LOCAL_CONNECT_TIMEOUT_MS` | `5000` | client | The same budget for a loopback server. |
| `WAKE_RETRY_DELAY_MS` | `3000` | client | Pause before retrying a failed script load or `connect_error` within the budget. |
| `WAKE_NOTICE_DELAY_MS` | `3000` | client | Pending time before the "Waking up the game server" message (remote servers only). |
| `JOIN_ACK_TIMEOUT_MS` | `10000` | client | Time the client waits for the `room:create` / `room:join` ack. |
| `ACK_TIMEOUT_MS` | `5000` | client | Time the client waits for the `race:rematch`, `room:start` and `room:extend` acks. |
| `LOBBY_WARNING_MS` | `60000` | client | How long before `expiresInMs` runs out the client warns and offers "Stay in room". |
| `BACKSPACE` | `'\b'` (U+0008) | both | Encodes one Backspace inside `keys`. |

The server reads these from `server/src/constants.js`; `createServer(options)`
may override the timing values, the room limits and the per-IP limits (tests
use short timers and small caps). The client keeps its own copy of the
client-owned values in `multiplayer.js` (`MP_CONSTANTS`, camelCase) and takes
everything else from server payloads.

Brute-force note: 30^6 = 729,000,000 codes. With at most 200 live rooms, one
guess hits a room with probability below 3 × 10⁻⁷. At 10 failed guesses per
minute per limiter key (one IPv4 address or one IPv6 /64), one key expects
under 0.005 hits per day against a full server. This bound holds only because
IPv6 is keyed by /64: with full-address keys, one IPv6 host could rotate
source addresses and guess without limit.

---

## 3. Room lifecycle

Phases: `waiting → countdown → racing → finished`, then either
`finished → countdown` (the host starts with the players who pressed "Race
again") or `finished → waiting` (everyone pressed "Race again").
`countdown → waiting` when too few racers remain; `racing → waiting` when
every racer has left but players who sat out remain. A room is **deleted**
when its last player leaves, or when every player is disconnected by
`ROOM_EXPIRED` or `IDLE_TIMEOUT`.

**Per-player flags** (server state; `ready` and `inRace` are in
`PlayerSummary`, `joinSeq` is not):

- `joinSeq: integer`: from a per-room counter `room.nextJoinSeq` (starts at 1,
  +1 for every player added, never reused). The creator has 1. A player who
  leaves and joins again gets a new, larger number.
- `ready: boolean`: "in the room lobby, available for the next race".
  - Creating or joining sets `ready = true` (also when joining a `finished`
    room).
  - In `waiting`, every player is always ready.
  - When the room enters `countdown`, every player is set to `ready = true`
    (racers and players who sit out alike).
  - When a race ends, every player **who raced** (`inRace`) gets
    `ready = false`. Players who sat out keep `ready = true`: they are already
    in the lobby for the next race.
  - `race:rematch` in `finished` sets it back to `true`.
- `inRace: boolean`: "takes part in the current race (`countdown`, `racing`)
  or took part in the last one (`finished`)".
  - `false` on create and join.
  - On entering `countdown`: `inRace = ready || id === hostId` (in `waiting`
    that is everyone; from `finished` it is the players who pressed "Race
    again" plus the host).
  - Set to `false` for everyone on entering `waiting`. Always `false` in
    `waiting`.

A player with `inRace === false` during `countdown` or `racing` is **sitting
out**: they stay in the room and the Socket.io room, they are not in
`race:update`, `player:finish` or `race:end` results, their `race:progress` is
ignored, and they never count for the countdown's player check or the race's
end check.

**Host.** The room has one host (`hostId`). The creator is the first host.
Whenever the host leaves the room or disconnects (in any phase: `waiting`,
`countdown`, `racing`, `finished`), the host passes at once to the
**connected player with the smallest `joinSeq`** (the player who has been in
the room longest), whether they are racing, sitting out or on their results.
Slots are not used for this: a slot freed by a leave can be reused by a later
joiner, who must not jump the queue. If no connected player is left, `hostId`
is `null` and the room is deleted (or, during `racing`, handled as below).
Only the host may send `room:start`. A host change is always followed by a
`room:state`. The one exception is a room that is closing after lobby expiry
(below): there the host is not passed on and no `room:state` is sent.

**Return check** (`shouldReturnToWaiting`), run after every leave, rematch and
join while the phase is `finished`: if the room has at least one player and
every player is ready, the room goes to `waiting`. (M1's automatic countdown
is gone: only `room:start` starts a countdown.)

**Start check** (`canStart(room, playerId)`), run on `room:start`, errors in
this order:

1. `NOT_HOST`: `playerId !== room.hostId`.
2. `RACE_IN_PROGRESS`: the phase is `countdown` or `racing`.
3. `NOT_ENOUGH_PLAYERS`: `players.length < MIN_PLAYERS`.
4. `PLAYERS_NOT_READY` (phase `finished` only): fewer than `MIN_PLAYERS`
   players would race, counting every player with `ready === true` plus the
   host. A `room:start` from the host counts as the host's "Race again", so
   the host never has to be `ready` already.

In `waiting` every player is ready, so step 4 never fails there.

**Picking the passage:** when entering `countdown` (`startCountdown`), if a
custom `pickPassage` throws or returns an invalid passage (not a non-empty
string within `PASSAGE_MAX_LENGTH`, or with control characters), the server
logs it and uses the default picker. Clients always receive a valid passage.

**Lobby timer.** While the phase is `waiting`, the room has a lobby timer of
`LOBBY_TIMEOUT_MS`. It is (re)started when the room is created, on every
successful join, on every `room:extend`, and every time the room enters
`waiting`. It is cleared when the room enters `countdown` and when the room is
deleted. `room.lobbyDeadline` (server clock) is the moment it fires;
`RoomSnapshot.expiresInMs` is the time left when the snapshot is sent.

**Lobby expiry closes the room silently.** When the lobby timer fires (phase
`waiting`), the server:

1. marks the room closing (`room.closing = true`);
2. emits `game:error { code: 'ROOM_EXPIRED' }` to every player's socket;
3. then disconnects every one of those sockets (`socket.disconnect(true)`).

While the room is closing, the disconnect path only removes the player: it
does not pass the host, does not run any check and sends **no** `room:state`
(no "player left" and no host-change update). The room is deleted (every
timer cleared) once it is empty. Why: otherwise the players still connected
received misleading "Player 1 left" / "You are now the host" updates moments
before their own expiry. The rematch timeout (`IDLE_TIMEOUT`, below) is
different and unchanged: it removes players one by one through the normal
leave path.

**Rematch timer.** Started when a race ends (`REMATCH_TIMEOUT_MS`). When it
fires, every player with `ready === false` (only players who raced and have
not pressed "Race again") is disconnected with `IDLE_TIMEOUT`. It is cleared
when the room leaves `finished`: to `waiting` (return check) or to
`countdown` (`room:start`). So a player who was moved into the next race's
lobby by a `room:start` (sitting out, `ready = true`) can no longer be removed
by the old timer.

| From | Trigger | To | Server actions |
|------|---------|----|----------------|
| (none) | `room:create` succeeds | `waiting` | Create the room with a new code, add the creator as host (slot 1, `joinSeq` 1, ready), start the lobby timer. Ack, then `room:state`. |
| `waiting` | `room:join` succeeds | `waiting` | Add the player (lowest free slot, next `joinSeq`, ready), restart the lobby timer. Ack, then `room:state`. |
| `waiting` | `room:extend` | `waiting` | Restart the lobby timer. Ack, then `room:state`. |
| `waiting` | `room:start` passes the start check | `countdown` | Clear the lobby timer. Seat the racers (`inRace` as above; everyone `ready`). Pick passage (with the fallback above), reset every racer's race fields (`index`, `results`, counters, `lastSeq = 0`, `finishedAt = null`, `leftAt = null`, `place = null`), set a provisional `startAt = now + COUNTDOWN_MS`, start the countdown timer. Ack, then `room:state` (phase `countdown`), then `race:countdown`. |
| `waiting` | a player leaves, others remain | `waiting` | Remove the player, pass the host if needed, emit `room:state`. The lobby timer keeps running. |
| `waiting` | the last player leaves | (deleted) | Clear every timer, delete the room. |
| `waiting` | lobby timer fires | (deleted) | Mark the room closing. Emit `game:error { code: 'ROOM_EXPIRED' }` to every player's socket, then `socket.disconnect(true)` each of them. Each disconnect only removes the player: no host change, no `room:state`. The room is deleted once empty. |
| `countdown` | a player leaves, at least `MIN_PLAYERS` racers (`inRace`) remain | `countdown` | Remove the player, pass the host if needed, emit `room:state`. The countdown continues. (A sitting-out player leaving never cancels the countdown.) |
| `countdown` | a racer leaves, fewer than `MIN_PLAYERS` racers remain, other players remain | `waiting` | Clear the countdown timer, drop the passage, set every `inRace = false` (everyone stays ready), pass the host if needed, start the lobby timer, emit `room:state`. |
| `countdown` | the last player leaves | (deleted) | Clear every timer, delete the room. |
| `countdown` | countdown timer fires | `racing` | `beginRace(room, now)`: reset `startAt = now` (the moment the timer actually fired). Start the race-limit timer (`RACE_TIME_LIMIT_MS`) and the broadcast interval (`BROADCAST_INTERVAL_MS`), emit `room:state` then `race:start`. |
| `racing` | a racer's typed text matches the whole passage | `racing` | Set `finishedAt`, `place = (finishers so far) + 1`, emit `player:finish`, mark room dirty, then run the end check. |
| `racing` | a racer disconnects, another racer is still connected | `racing` | Set `connected = false`, `leftAt = now`. Their numbers freeze. Pass the host if needed. Emit `room:state`. Then run the end check. |
| `racing` | a sitting-out player disconnects | `racing` | Remove the player (they are not in the results), pass the host if needed, emit `room:state`. |
| `racing` | end check: at least one connected racer and every connected racer has finished | `finished` | See "Ending a race". `reason: 'all_finished'`. |
| `racing` | race-limit timer fires | `finished` | See "Ending a race". `reason: 'time_limit'`. |
| `racing` | the last connected racer disconnects, sitting-out players remain | `waiting` | `abandonRace`: clear the race-limit timer and the broadcast interval, drop the passage, remove every player with `connected = false`, set every `inRace = false` (everyone ready), pass the host if needed, start the lobby timer, emit `room:state` (phase `waiting`). No `race:end`. |
| `racing` | the last connected player disconnects | (deleted) | Clear every timer, delete the room. No `race:end`. |
| `finished` | `race:rematch` | `finished` or `waiting` | Set `ready = true`. Ack, then `room:state` (phase `finished`, this player `ready: true`), then run the return check. If it moves the room to `waiting`: clear the rematch timer, start the lobby timer, emit a second `room:state` (phase `waiting`). |
| `finished` | `room:start` passes the start check | `countdown` | Clear the rematch timer. Seat the racers: `inRace = ready \|\| id === hostId`; then every player `ready = true` (players who had not pressed "Race again" now sit out and are lobby players for the next race). Then exactly as `waiting → countdown` (passage, race fields of the racers, `startAt`, countdown timer). Ack, then `room:state` (phase `countdown`), then `race:countdown`. |
| `finished` | `room:join` with space in the room | `finished` or `waiting` | Add the player as ready, `inRace = false`. Ack, then `room:state`, then run the return check (it passes only if every other player is also ready). The joiner races in the next race the host starts. |
| `finished` | a player leaves | `finished`, `waiting` or (deleted) | Remove the player, pass the host if needed, emit `room:state`, run the return check. Delete the room if it is empty. |
| `finished` | rematch timer fires (`REMATCH_TIMEOUT_MS` after entering `finished`) | `finished`, `waiting` or (deleted) | For every player with `ready === false`: emit `game:error { code: 'IDLE_TIMEOUT' }` to that socket, then `socket.disconnect(true)`. Each disconnect runs the `finished` leave path above. |
| `waiting` | `race:rematch` from a player (always ready in `waiting`) | `waiting` | Ack `{ ok: true, room }` only. No `room:state`. |

**Ending a race:** clear the race-limit timer and the broadcast interval,
send one final `race:update`, compute results (section 6) for the racers, set
phase `finished`, remove players with `connected = false`, pass the host if
the host was removed, set `ready = false` for every remaining racer (players
who sat out keep `ready = true`), start the rematch timer
(`REMATCH_TIMEOUT_MS`), then emit `race:end` followed by `room:state`.

**Who can join:** a room in phase `waiting` or `finished` with
`players.length < maxPlayers`. A full room answers `ROOM_FULL` in every phase,
before the phase check (`RACE_IN_PROGRESS`).

**Timers:** per room, at most one lobby timer, one countdown timer, one
race-limit timer, one broadcast interval and one rematch timer, all held in
`server/src/game.js`. Each is cleared on every transition out of its phase and
when the room is deleted. Per socket, one join timer (section 1). The per-IP
limiters use no timers (they sweep lazily, section 4).

**Server restarts:** rooms live in memory. A restart, redeploy or Render
spin-down drops every room and frees every code. Connected clients get
`disconnect` and fall back to solo with `DISCONNECTED`. A share link to a
dropped room then answers `ROOM_NOT_FOUND`.

**Reconnecting is not supported.** A player who loses the connection leaves
the room. They can join again with the same code as a new player (new
`playerId`, lowest free slot, new `joinSeq`) while the room is `waiting` or
`finished` and has space.

---

## 4. Client → server events

General rules for every client event:

- If the socket's rate limit is exhausted, the event is dropped. If the last
  argument is a function (an ack), it is called with
  `{ ok: false, error: { code: 'RATE_LIMITED', message } }`; otherwise the
  server emits `game:error` `RATE_LIMITED` (at most once per
  `RATE_LIMIT_ERROR_INTERVAL_MS`).
- Unknown event names are ignored (they still cost a rate-limit token).
- Extra fields in a payload object are ignored.
- Events that require an ack: if no ack function is passed, the server emits
  `game:error` `BAD_PAYLOAD` and ignores the event.
- "Kicked" below means: the server calls the ack, then disconnects the socket
  on the next tick (`setImmediate`), after the ack has been written. A socket
  that is already in a room is never kicked by a failed `room:create` or
  `room:join`.

### `room:create`

| | |
|---|---|
| Direction | client → server |
| When | Right after the socket connects, when the user pressed **Create a room**. Once per connection, within `JOIN_TIMEOUT_MS`. The client waits up to `JOIN_ACK_TIMEOUT_MS` for the ack. |
| Payload | `{}` or `undefined`. Any other type (string, number, array, `null`) is `BAD_PAYLOAD`. |
| Ack | **Required.** |
| Success ack | `{ ok: true, playerId: string, room: RoomSnapshot }`. `room.code` is the new code, `room.hostId === playerId`, `room.phase === 'waiting'`. |
| Failure ack | `{ ok: false, error: { code, message } }` |
| Order | Ack, then `room:state` to the room (only this socket is in it). |

Error codes, checked in this order:

| Order | Code | When | Socket afterwards |
|------:|------|------|-------------------|
| 1 | `BAD_PAYLOAD` | Payload is not an object or `undefined`. | Kicked. |
| 2 | `ALREADY_JOINED` | This socket is already in a room. | Stays (keeps its seat). |
| 3 | `RATE_LIMITED` | The per-IP create bucket (`CREATE_LIMIT_*`) has no token. Every attempt that reaches this step takes one token. | Kicked. |
| 4 | `TOO_MANY_ROOMS` | The store already holds `MAX_ROOMS` rooms, or `ROOM_CODE_MAX_ATTEMPTS` random codes were all taken. | Kicked. |
| – | `RATE_LIMITED` (socket bucket) | See general rules. | Stays; the join timeout closes it. |
| – | `INTERNAL` | Handler threw. | Stays; the join timeout closes it. |

Code generation: each of the 6 characters is
`ROOM_CODE_ALPHABET[crypto.randomInt(0, 30)]` (uniform, cryptographically
random). If the code is already in the store, try again, up to
`ROOM_CODE_MAX_ATTEMPTS` codes in total. A code freed by a deleted room may be
issued again later.

### `room:join`

| | |
|---|---|
| Direction | client → server |
| When | Right after the socket connects, when the user submitted a room code (typed, or from an invite link). Once per connection, within `JOIN_TIMEOUT_MS`. The client waits up to `JOIN_ACK_TIMEOUT_MS` for the ack. |
| Payload | `{ code: string }` |
| Ack | **Required.** |
| Success ack | `{ ok: true, playerId: string, room: RoomSnapshot }` |
| Failure ack | `{ ok: false, error: { code, message } }` |
| Order | Ack, then `room:state` to the room, then (phase `finished` only) the return check, which may emit a second `room:state` (phase `waiting`). |

Fields:

| Field | Type | Rules |
|-------|------|-------|
| `code` | string | `1 <= code.length <= ROOM_CODE_INPUT_MAX` for the payload check. Then it must match `ROOM_CODE_PATTERN` exactly: the client sends the canonical form (uppercase, no spaces or hyphens). The server does not normalise. |

Error codes, checked in this order:

| Order | Code | When | Costs a join-failure token | Socket afterwards |
|------:|------|------|:--:|-------------------|
| 1 | `BAD_PAYLOAD` | Payload is not a plain object, or `code` is missing, not a string, empty or longer than `ROOM_CODE_INPUT_MAX`. | no | Kicked. |
| 2 | `ALREADY_JOINED` | This socket is already in a room. | no | Stays. |
| 3 | `RATE_LIMITED` | The per-IP join-failure bucket (`JOIN_FAIL_LIMIT_*`) has less than one token. Checked without taking a token. | no | Kicked. |
| 4 | `BAD_CODE` | `code` does not match `ROOM_CODE_PATTERN`. | **yes** | Kicked. |
| 5 | `ROOM_NOT_FOUND` | No room has this code. | **yes** | Kicked. |
| 6 | `ROOM_FULL` | `players.length >= maxPlayers`, in any phase (checked before the phase). | no | Kicked. |
| 7 | `RACE_IN_PROGRESS` | The phase is `countdown` or `racing`. | no | Kicked. |
| – | `RATE_LIMITED` (socket bucket) | See general rules. | no | Stays; the join timeout closes it. |
| – | `INTERNAL` | Handler threw. | no | Stays; the join timeout closes it. |

Only `BAD_CODE` and `ROOM_NOT_FOUND` take a token, so many players behind one
NAT (or several tabs in one browser) can still join real rooms, while guessing
codes is limited to 10 per minute per IP. `ROOM_FULL` and `RACE_IN_PROGRESS`
reveal that a code exists; that is accepted because guessing is rate-limited,
and the messages help real players.

`playerId` is a random opaque id from `crypto.randomUUID()`, never the socket
id.

### `room:start`

| | |
|---|---|
| Direction | client → server |
| When | The host presses **Start race** in the room lobby: in `waiting` (at least `MIN_PLAYERS` players), or in `finished` after the host pressed "Race again" (at least `MIN_PLAYERS` players, the host included, have pressed it). The client waits up to `ACK_TIMEOUT_MS` for the ack. |
| Payload | `{}` or `undefined`. |
| Ack | **Required.** |
| Success ack | `{ ok: true }` |
| Failure ack | `{ ok: false, error: { code, message } }` |
| Order | Ack, then `room:state` (phase `countdown`, with each player's `inRace`), then `race:countdown`. |
| Effect on others | From `finished`: players with `ready === false` (still on their results) sit out this race (`inRace: false`), are set `ready: true`, and are no longer subject to the rematch timer. Their clients learn it from the `room:state`. |

Error codes, checked in this order (no failure kicks the socket):

| Order | Code | When |
|------:|------|------|
| 1 | `BAD_PAYLOAD` | Payload is not an object or `undefined`. |
| 2 | `NOT_IN_ROOM` | This socket is not in a room. |
| 3 | `NOT_HOST` | This player is not the host. |
| 4 | `RACE_IN_PROGRESS` | The phase is `countdown` or `racing` (for example a double press). |
| 5 | `NOT_ENOUGH_PLAYERS` | `players.length < MIN_PLAYERS`. |
| 6 | `PLAYERS_NOT_READY` | Phase `finished` and fewer than `MIN_PLAYERS` players would race (ready players plus the host). |
| – | `RATE_LIMITED` | See general rules. |

### `room:extend`

| | |
|---|---|
| Direction | client → server |
| When | A player presses **Stay in room** after the client's lobby warning. Any player in the room may send it. The client waits up to `ACK_TIMEOUT_MS` for the ack. |
| Payload | `{}` or `undefined`. |
| Ack | **Required.** |
| Success ack | `{ ok: true, room: RoomSnapshot }` (with the new `expiresInMs`). |
| Order | Restart the lobby timer, ack, then `room:state` to the room (every client resets its deadline and warning). |

Error codes, checked in this order (no failure kicks the socket):

| Order | Code | When |
|------:|------|------|
| 1 | `BAD_PAYLOAD` | Payload is not an object or `undefined`. |
| 2 | `NOT_IN_ROOM` | This socket is not in a room. |
| 3 | `NOT_WAITING` | The phase is not `waiting`. |
| – | `RATE_LIMITED` | See general rules. |

### `race:progress`

Unchanged from M1, except that players sitting out are ignored.

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
| `keys` | string | `1 <= keys.length <= MAX_KEYS_PER_EVENT` (UTF-16 units). Must be well-formed (`keys.isWellFormed()`). Must not contain U+0000–U+0007, U+0009–U+001F or U+007F–U+009F. U+0008 means Backspace. |

Each code point of `keys` is one keystroke, in order. The client only sends
keys it actually applied locally (a Backspace at position 0 is not sent).

How the server applies `keys` (`applyKeys` in `server/src/race.js`; mirrors
`handleCharacter` and `handleBackspace` in `script.js`):

- **Backspace:** if `index > 0`: `index -= 1`, undo the counter for
  `results[index]`, set `results[index] = null`. `totalKeystrokes` and
  `correctKeystrokes` are **not** decreased. At `index === 0` it is ignored.
- **Any other code point:** if `index >= passage.length`, ignore it (not
  counted). Otherwise compare with `passage[index]`, set `results[index]` to
  `'correct'` or `'incorrect'`, update the counters, `totalKeystrokes += 1`,
  `correctKeystrokes += 1` if correct, `index += 1`.
- **Finish:** after each keystroke, if `index === passage.length` and
  `incorrectCount === 0`, the player has finished at the server's current
  time. Remaining keys in the same event are ignored.

Validation order: payload shape (`BAD_PAYLOAD`), then membership
(`NOT_IN_ROOM`), then the silent ignores below, then `applyKeys`. `lastSeq`
is updated only for events that pass validation.

Silently ignored: the phase is not `racing`; the player is sitting out
(`inRace === false`); the player has already finished; `seq <= lastSeq`.

Error codes (`game:error`): `BAD_PAYLOAD`, `NOT_IN_ROOM`, `RATE_LIMITED`.

### `race:rematch`

| | |
|---|---|
| Direction | client → server |
| When | The player presses "Race again" on the results card, within `REMATCH_TIMEOUT_MS` of `race:end` (otherwise the server disconnects the player with `IDLE_TIMEOUT`, unless the host has started a new race first). On success the client shows the room lobby. The client waits up to `ACK_TIMEOUT_MS` for the ack. |
| Payload | `{}` or `undefined`. |
| Ack | **Required.** |
| Success ack | `{ ok: true, room: RoomSnapshot }`. Idempotent. |
| Order | From `finished`: ack, then `room:state` (phase `finished`, this player `ready: true`), then, if the return check passes, `room:state` (phase `waiting`). From `waiting`: the ack only. |

Error codes, checked in this order:

| Order | Code | When |
|------:|------|------|
| 1 | `BAD_PAYLOAD` | Payload is not an object or `undefined`. |
| 2 | `NOT_IN_ROOM` | This socket is not in a room. |
| 3 | `NOT_FINISHED` | The phase is `countdown` or `racing` (for example "Race again" pressed just after the host started without this player). (In `waiting` the answer is `ok: true`.) |
| – | `RATE_LIMITED` | See general rules. |

### Leaving

There is no leave event. A client leaves its room by calling
`socket.disconnect()` ("Leave room", "Back to solo", Solo, closing the tab).
The server treats `disconnect` the same way for every reason, including its
own disconnects for `IDLE_TIMEOUT`, the join timeout and a kicked failure.
The one exception is `ROOM_EXPIRED`: those disconnects belong to a closing
room and only remove the player, with no host change and no `room:state`
(section 3, "Lobby expiry closes the room silently").

---

## 5. Server → client events

The client validates every payload with the `validate*` functions in
`multiplayer.js` and ignores any message that fails. The client never renders
a string it receives from the server except the room `code`, which it renders
only after it matches `ROOM_CODE_PATTERN`, and only with `textContent` or an
input's `value`. Error `message` strings are never shown; the client maps
`code` to its own text.

The race events (`race:countdown`, `race:start`, `race:update`,
`player:finish`, `race:end`) go to every socket in the room, including
players who sit out. A client whose own `PlayerSummary.inRace` is `false` in
the latest `room:state` ignores all of them. `race:update`, `player:finish`
and `race:end` only ever contain racers.

### Shared shapes

```
RoomSnapshot = {
  code: string,                     // matches ROOM_CODE_PATTERN
  phase: 'waiting' | 'countdown' | 'racing' | 'finished',
  maxPlayers: integer (1..8),
  minPlayers: integer (1..maxPlayers),
  hostId: string | null,            // a players[].id; null only if players is empty
  expiresInMs: integer (0..3600000) | null,  // lobby time left; null unless phase is 'waiting'
  players: PlayerSummary[]          // 0..maxPlayers, sorted by slot
}

PlayerSummary = {
  id: string (1..64 chars),
  slot: integer (1..maxPlayers),    // lowest free slot at join; reused after a leave
  connected: boolean,               // false only during 'racing' after a racer disconnects
  ready: boolean,                   // in the lobby for the next race (section 3)
  inRace: boolean,                  // in the current/last race; always false in 'waiting'
  finished: boolean                 // finished the current/last race
}
```

The client rejects a snapshot whose `hostId` is not `null` and not the `id` of
one of `players`, or that is `null` while `players` is not empty, or that has
a player with `inRace: true` while `phase` is `'waiting'`. Join order
(`joinSeq`) is not sent; the client never needs to predict the next host.

### `room:state`

| | |
|---|---|
| Direction | server → every socket in the room |
| When | After every create, join, leave, host change, `room:extend`, rematch from `finished`, and phase change. Not after a `race:rematch` in `waiting`. Never while a room is closing after `ROOM_EXPIRED` (section 3). |
| Payload | `RoomSnapshot` |

### `race:countdown`

| | |
|---|---|
| Direction | server → every socket in the room |
| When | On entering `countdown` (after a successful `room:start`), right after `room:state`. Clients sitting out ignore it. |
| Payload | `{ passage: string, startsInMs: integer, raceTimeLimitMs: integer }` |

| Field | Rules |
|-------|-------|
| `passage` | 1..`PASSAGE_MAX_LENGTH` UTF-16 units, words from `WORDS` joined by single spaces. Client rejects control characters. |
| `startsInMs` | 0..10000. Display only: `countdownEndsAt = performance.now() + startsInMs`. |
| `raceTimeLimitMs` | 1000..600000. |

Typing is unlocked only by `race:start`.

### `race:start`

| | |
|---|---|
| Direction | server → every socket in the room |
| When | When the countdown timer fires, right after `room:state` (phase `racing`). Clients sitting out ignore it. |
| Payload | `{ raceTimeLimitMs: integer }` (1000..600000) |

The server's `startAt` is the moment this event is sent. The client sets its
local `startTime = performance.now()` and unlocks typing.

### `race:update`

| | |
|---|---|
| Direction | server → every socket in the room |
| When | During `racing`, every `BROADCAST_INTERVAL_MS`, only if any racer's numbers changed; plus one final update when the race ends. |
| Payload | `{ elapsedMs: integer, players: ProgressEntry[] }` (racers only) |

```
ProgressEntry = {
  id: string,
  correctChars: integer (>= 0),
  progress: integer (0..100),             // Math.floor(correctChars * 100 / passage.length)
  wpm: integer (0..1000),
  accuracy: integer (0..100),
  finished: boolean,
  place: integer (>= 1) | null
}
```

### `player:finish`

| | |
|---|---|
| Direction | server → every socket in the room |
| When | Immediately when a racer finishes. |
| Payload | `{ id: string, place: integer (>= 1), timeMs: integer (>= 0), wpm: integer (0..1000), accuracy: integer (0..100) }` |

### `race:end`

| | |
|---|---|
| Direction | server → every socket in the room |
| When | When the race ends, before the `room:state` with phase `finished`. Not sent when a race is abandoned (`racing → waiting`). |
| Payload | `{ reason: 'all_finished' \| 'time_limit', results: ResultEntry[] }` (racers only) |

```
ResultEntry = {
  id: string,
  slot: integer (1..8),
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

`results` includes racers who left during the race (`status: 'left'`), and
never players who sat out.

### `game:error`

| | |
|---|---|
| Direction | server → one socket |
| When | An event without an ack failed validation or was rate-limited; or, server-initiated, just before the server disconnects the socket (`IDLE_TIMEOUT`, `ROOM_EXPIRED`). |
| Payload | `{ code: string, message: string }` |

After `IDLE_TIMEOUT` or `ROOM_EXPIRED` the server disconnects the socket. The
client remembers the code, and the disconnect that follows falls back to solo
with that code's message instead of `DISCONNECTED`.

---

## 6. Results and finish order

Unchanged from M1, computed over racers (`inRace`) only. Computed by
`buildResults(room, now)` in `server/src/race.js`, using `computeStats` from
the shared `stats.js`.

- **Start of the clock:** `startAt` is the moment the countdown timer actually
  fired.
- **Elapsed time per player:** finished: `finishedAt - startAt`; left:
  `leftAt - startAt`; otherwise `now - startAt`.
- **Stats:** `computeStats({ results, totalKeystrokes, correctKeystrokes,
  duration: null }, Math.max(elapsedMs, 1000))`.
- **Clamping:** `wpm` 0..1000, `rawWpm` 0..5000, `accuracy` 0..100.
- **`timeMs`** is the real `elapsedMs` (no floor), rounded.
- **Order:** finished players by `place`; then unfinished connected players by
  `correctChars` desc, `accuracy` desc, `slot` asc; then players who left,
  same tie-breaks.
- `place` in `race:end` is the 1-based position in this order.

---

## 7. Error codes (all)

| Code | Events | Meaning |
|------|--------|---------|
| `BAD_PAYLOAD` | all | Wrong type, missing field, out of range, too long, bad characters, missing ack. |
| `RATE_LIMITED` | all; also `room:create` (per-IP create limit) and `room:join` (per-IP join-failure limit) | Too many events or attempts. |
| `ALREADY_JOINED` | `room:create`, `room:join` | This socket is already in a room. |
| `BAD_CODE` | `room:join` | `code` is not a valid room code. |
| `ROOM_NOT_FOUND` | `room:join` | No room has this code. |
| `ROOM_FULL` | `room:join` | The room has `maxPlayers` players (any phase; checked before `RACE_IN_PROGRESS`). |
| `RACE_IN_PROGRESS` | `room:join`, `room:start` | The phase is `countdown` or `racing`. |
| `TOO_MANY_ROOMS` | `room:create` | The store is full, or no free code was found. |
| `NOT_IN_ROOM` | `race:progress`, `race:rematch`, `room:start`, `room:extend` | This socket is not in a room. |
| `NOT_HOST` | `room:start` | Only the host can start. |
| `NOT_ENOUGH_PLAYERS` | `room:start` | Fewer than `MIN_PLAYERS` players in the room. |
| `PLAYERS_NOT_READY` | `room:start` | Phase `finished` and fewer than `MIN_PLAYERS` players (ready players plus the host) would race. |
| `NOT_WAITING` | `room:extend` | The phase is not `waiting`. |
| `NOT_FINISHED` | `race:rematch` | The phase is `countdown` or `racing`. |
| `IDLE_TIMEOUT` | server-initiated (`game:error`) | The player raced and did not press "Race again" within `REMATCH_TIMEOUT_MS`, and no new race started. Sent just before the disconnect. |
| `ROOM_EXPIRED` | server-initiated (`game:error`) | No race started within `LOBBY_TIMEOUT_MS` (counting from the last join, extend or entry into `waiting`). Sent to every player just before the disconnect. |
| `INTERNAL` | all | Unexpected server error (handler threw). Logged on the server. |

Client-only codes, never sent by the server (they only select a message):

- `UNREACHABLE`: the script load and socket connect did not succeed within
  the budget, or the `room:create` / `room:join` ack timed out.
- `DISCONNECTED`: the connection was lost after entering a room.
- `BAD_RESPONSE`: an ack failed validation.

A connection refused for its origin or by the per-IP connection cap also ends
as `UNREACHABLE` once the budget runs out.

---

## 8. Validation rules (summary)

- Every handler validates before touching room state, with pure functions in
  `server/src/validate.js` that return `{ ok: true, value }` or
  `{ ok: false, code: 'BAD_PAYLOAD', message }`. The room-code format check
  (`isValidRoomCode` in `server/src/roomCode.js`) is separate, because it
  answers `BAD_CODE` and runs after the rate-limit check.
- "Plain object" means `typeof v === 'object' && v !== null &&
  !Array.isArray(v)`.
- Integers are checked with `Number.isInteger`; strings with
  `typeof === 'string'` (no coercion).
- Every handler is wrapped in `try/catch`; a throw answers `INTERNAL` (ack or
  `game:error`) and never crashes the process.
- Client-side, `multiplayer.js` validates every server payload against the
  shapes in section 5 and drops messages that fail. It also normalises and
  validates the room code the user types before any connection is made.
