# Typing Speed Tester

A keyboard-first typing speed test built with vanilla HTML, CSS and JavaScript, plus a real-time race mode (beta) for 2 to 4 players in private rooms, backed by a small Node.js and Socket.io server. The browser app has no frameworks, no build step and no dependencies. It comes with 972 client tests and 411 server tests, all run with Node's built-in test runner.

**Racing alone?** Press **Multiplayer**, create a room, copy the invite link and open it in a second tab to race yourself.

**Live demo:** [https://prathambasu03-git.github.io/typing-speed-tester/](https://prathambasu03-git.github.io/typing-speed-tester/) (solo and multiplayer. The first multiplayer connection after the server has been idle can take about a minute while the free Render instance wakes up.)

![Typing test in solo mode, dark theme, showing the word area, live WPM, accuracy and the countdown timer](docs/screenshot.png)

## Features

### Solo

- 15, 30 or 60 second tests
- Live WPM, accuracy and countdown while you type
- Results: WPM, raw WPM, accuracy, correct and incorrect characters
- Personal best for each duration, plus your last 10 results, saved in the browser
- Dark and light themes. Your choice is remembered, and the default follows your system setting
- A smooth caret that scrolls the text line by line. New words are added as you go, so you never run out
- Restart at any time with <kbd>Esc</kbd>, or <kbd>Tab</kbd> to the restart button and press <kbd>Enter</kbd>
- Works with on-screen keyboards on mobile, and down to 360px wide
- Pasting or dropping text is blocked, so the score reflects real typing

### Multiplayer (beta)

- **Private rooms by code.** Press **Multiplayer**, then **Create a room**, or type a 6-character code and press **Join room**. Codes use letters and digits without look-alikes (no 0, 1, I, L, O or U). They are case-insensitive, and spaces and hyphens are ignored, so `k7q-m2x` works
- **Invite links.** After you create a room, its code shows with a **Copy invite link** button, for example `https://prathambasu03-git.github.io/typing-speed-tester/#room=K7QM2X`. Opening the link shows an invite banner with a **Join room** button. Nothing contacts the server until you press it
- **Racing alone?** Create a room, copy the invite link and open it in a second tab to race yourself. The lobby shows the same tip while you are the only player
- **2 to 4 players with a host.** The room's creator is the host and presses **Start race**, which stays disabled until at least 2 players are in. If the host leaves, in the lobby or mid-race, the player who joined next becomes host and everyone is told. A fifth player gets a clear "room is full" message
- Everyone races the same 30-word passage after a 3-second countdown and sees each other's live progress
- You finish only when every character is correct, so mashing keys cannot win
- Results show each player's place, WPM, accuracy and time, all computed by the server
- **Rematches.** After a race, players press **Race again** to go back to the room. The host can start the next race with whoever has pressed it. Anyone still on their results sits that race out and joins the next one
- **Lobby timeout.** An idle lobby closes after 10 minutes so the free server can sleep. A warning comes 1 minute before, with a **Stay in room** button
- After a race, a player who does not press **Race again** within 60 seconds leaves the room. The page shows a notice and a spoken warning first
- A sleeping free-tier server can take about a minute to wake. Pressing **Multiplayer** starts loading the connection script in the background while you choose. After 3 seconds of waiting the page says it is waking the server (with a small spinner, and **Solo** cancels), waits up to 90 seconds, then falls back to solo with a clear message
- If the server cannot be reached, the page says so and falls back to solo

Multiplayer results are not saved to your solo history or personal bests.

## Tech and skills shown

### Client

- **State management without a framework.** One `state` object is the single source of truth, in solo and in multiplayer. Handlers update it, and render functions only write to the DOM.
- **Separation of logic and UI.** Calculations and validation live in `stats.js` and `multiplayer.js`, which never touch the DOM. The same files run in the browser and in Node.
- **Accurate timing.** Elapsed time comes from `performance.now()` timestamps, which are monotonic. Timer ticks only refresh the display, so drift and background-tab throttling do not affect the score.
- **Safe DOM rendering.** All text, including stored data and server messages, is written with `textContent`. The code never uses `innerHTML`.
- **Validated input from every source.** `localStorage` data is read with guarded JSON parsing and checked on load. Every server event is validated in `multiplayer.js` before it can reach `state`; malformed payloads are ignored.
- **Careful input handling.** Keys pressed after time runs out are not counted. Browser shortcuts (Ctrl, Cmd, Alt) are ignored, but AltGr characters such as `@` or `€` still type. Mobile and IME input go through a separate `input` event path.
- **Graceful degradation.** Solo works by opening `index.html` directly, with no server. If `multiplayer.js` fails to load, the Multiplayer button is hidden and solo is unaffected.

### Real-time multiplayer

- **Private rooms with secure codes.** Room codes are 6 characters from a 30-character alphabet (729 million combinations), generated with `crypto.randomInt` and retried on a collision. The server holds up to 200 rooms in memory.
- **Brute-force protection.** Per-IP token-bucket limits on creating rooms and on failed joins make guessing codes impractical. IPv6 addresses are grouped by /64, so one host cannot dodge the limits by rotating addresses. The limiters use no timers; they sweep idle entries lazily and cap how many IPs they track.
- **Host succession by join order.** When the host leaves, in any phase, the host role passes to the connected player who has been in the room longest. A freed slot cannot let a later joiner jump the queue.
- **Room lifecycle as a state machine.** Rooms move through `waiting`, `countdown`, `racing` and `finished`, with a lobby timer, a rematch timer and sit-out rules for players who are still on their results. Every timer is cleared on every transition out of its phase.
- **Privacy-minded invite links.** The code goes in the URL hash (`#room=K7QM2X`), which browsers never send to the web server, so codes do not end up in GitHub's logs or in `Referer` headers. The page never connects because of a link alone.
- **Real-time networking with Socket.io.** The client loads the Socket.io script from the game server only when Multiplayer is pressed. Keystrokes are batched (at most one progress event every 150 ms), and the server broadcasts progress every 200 ms.
- **Server-authoritative design.** The client sends only keystrokes. The server replays them against its own copy of the passage and decides what is correct, when a player finishes, and the WPM, accuracy, time and finish order. Scores or times sent by a client are ignored.
- **Shared logic.** The server reuses the browser's `stats.js` and `words.js`, so WPM and accuracy come from the same code on both sides.
- **Protocol design.** Every Socket.io event (name, direction, payload shape, limits and error codes) is specified in [`docs/PROTOCOL.md`](docs/PROTOCOL.md), and both sides implement it.
- **Defensive server.** Payload validation, a per-socket rate limit (token bucket), a per-IP connection cap that reads the real client IP behind a reverse proxy (`TRUST_PROXY_HOPS`, so players are not all counted as the proxy's address), a 4 KB message size limit, CORS restricted to the GitHub Pages origin and localhost, a 10-second join timeout, a 10-minute lobby timeout and a 60-second idle removal after a race.
- **Deployed on Render.** A Render Blueprint ([`render.yaml`](render.yaml)) describes the WebSocket server on Render's free tier, with a health check, a pinned Node version and build filters so client-only pushes do not restart it. The client handles the free tier's cold start. It runs at https://typing-speed-tester-server.onrender.com; see [Deploy the game server](#deploy-the-game-server).

### Quality

- **Accessibility to WCAG 2.2 AA**, including live updates that do not flood a screen reader. See [Accessibility](#accessibility).
- **Responsive design** down to 360px wide, with no horizontal scrolling.
- **Automated tests.** The client suite uses only Node built-ins (`node:test`, `node:assert/strict`, `node:vm`). The server suite uses `node:test` and `socket.io-client`, including simulated races and lobbies with up to five real clients.

## How it works

### Client architecture

The page loads four classic `<script defer>` files in order:

1. `words.js` defines the global word list, `WORDS`.
2. `stats.js` defines the pure functions: `calculateWpm`, `calculateAccuracy`, `computeStats`, `isValidRecord`, `isValidDuration`, `randomWords`, `generateChars` and `DURATIONS`.
3. `multiplayer.js` defines the pure multiplayer helpers: server URL checks, keystroke batching, validators for every server event, labels and error messages.
4. `script.js` runs the app. It starts with a dependency guard: if `stats.js` failed to load, it shows an error message (announced with `role="alert"`) and stops. A missing `multiplayer.js` only turns multiplayer off.

The first three files also export their functions for Node through a `typeof module` check, which is how the tests and the server use them.

Data flows one way: **event → update `state` → render**. A keystroke updates one character `<span>` instead of re-rendering the text. The spans are built in a `DocumentFragment` and inserted in one operation.

### Phases

Solo:

```
idle ──first valid key──▶ running ──timer hits 0──▶ finished
  ▲                                                    │
  └────────────── restart (Esc / restart button) ──────┘
```

Multiplayer reuses the same `state` object with `mode: 'multi'`:

```
menu ──Create / Join──▶ connecting ──▶ waiting ──host: Start race──▶ countdown ──▶ running ──▶ finished
                                          ▲                                                       │
                                          └──── Race again (or the host starts without you) ──────┘
```

On the server, a room moves through `waiting → countdown → racing → finished`. From `finished` the host can go straight to a new `countdown` with the players who pressed **Race again**, or the room returns to `waiting` once everyone has pressed it.

### Multiplayer flow

1. **Menu.** Pressing **Multiplayer** shows the menu and starts loading `<server-url>/socket.io/socket.io.js` in the background, which also wakes a sleeping server. Pages on `localhost` always use `http://localhost:3000`. Elsewhere the server URL comes from `<meta name="typing-server-url">` in `index.html`; on the live site that is the Render server (in a fork, the placeholder `REPLACE_WITH_RENDER_URL` keeps the page solo-only). Pages opened from `file://` are always solo-only.
2. **Create or join.** The socket connects only when the player presses **Create a room** or **Join room** (from the menu or from an invite banner). If the server is asleep, the client waits up to 90 seconds for it to wake. The server answers with a new room code, or adds the player to the room with that code.
3. **Lobby.** The room shows its code, the invite link and the players. The invite link is also put in the address bar. The server sends a room snapshot after every change: joins, leaves, host changes and the lobby time left.
4. **Host start.** The host presses **Start race** once at least 2 players are in. The server picks the passage and sends a 3-second countdown, then the start signal.
5. **Race.** While typing, the client sends batches of keystrokes (Backspace included). The server replays them, keeps each player's position and keystroke counts, and broadcasts everyone's progress.
6. **Results.** The race ends when every racer finishes or after 2 minutes. The server sends the results and finish order.
7. **Race again.** Players press **Race again** to return to the room. The host can start the next race as soon as at least 2 players (counting the host) are ready; the others sit that race out and join the next one.

### Formulas

A "word" is 5 characters, and minutes are measured from the start timestamp.

- **WPM** = (correct characters ÷ 5) ÷ minutes, rounded
- **Raw WPM** = (all typed characters ÷ 5) ÷ minutes, rounded
- **Accuracy** = correct keystrokes ÷ total keystrokes × 100, rounded down

Accuracy is rounded down so that any mistake keeps it below 100%. Backspace does not undo a mistake in the accuracy count. Every formula guards against division by zero and non-finite values, so `NaN` and `Infinity` never reach the screen. In multiplayer the server applies the same formulas with a minimum elapsed time of one second, so a very short time cannot produce a huge WPM.

### Stored data

All `localStorage` keys use the `typing:` prefix:

| Key | Contents |
|---|---|
| `typing:history` | Last 10 solo results |
| `typing:best` | Best solo result for each duration |
| `typing:theme` | `light` or `dark` |
| `typing:duration` | Last chosen duration |

A record is only accepted if its WPM is 0 to 1000, its accuracy is 0 to 100, its duration is 15, 30 or 60, and its date is a finite number. Multiplayer adds no stored data; room codes live only in the URL hash and in server memory.

## Accessibility

- **Keyboard:** Tab is never captured, so focus can always move. <kbd>Esc</kbd> restarts a solo test from the typing area; it never leaves a race. The Solo/Multiplayer and duration buttons expose their state with `aria-pressed`.
- **Focus:** The typing area shows a visible focus ring. The caret hides when the area is not focused. Focus is managed at every multiplayer step: an invite link focuses **Join room** on the banner, creating a room focuses **Copy invite link**, joining focuses the room heading, and a failed join returns focus to the code input with the error shown under it. When a race countdown starts, focus moves to the typing input so you can type at "Go". When a test or race ends, focus moves to the Results heading. Joins, leaves and host changes never move focus.
- **Screen readers:** The input is described by a text version of the upcoming words (`aria-describedby`). A single polite live region announces key moments: results and restarts in solo; the room created or joined, countdown, "Go!", each finish and race over in multiplayer. Lobby changes (a player joining or leaving, a new host) get exactly one announcement each, and repeated snapshots say nothing. There is no per-second or per-update speech. Load and connection errors use `role="alert"`.
- **Room codes:** The visible code is hidden from screen readers and paired with a spelled-out copy ("K 7 Q M 2 X"), so it is read once, one character at a time.
- **Start race:** While fewer than 2 players are in, the button uses `aria-disabled` instead of `disabled`, so it stays focusable. A hint linked with `aria-describedby` explains why, and pressing it announces the reason.
- **Time limits (WCAG 2.2.1):** The lobby warns 1 minute before it closes and offers **Stay in room**. After a race, a spoken warning comes before the 60-second rematch timeout.
- **Live progress:** Race progress bars are `aria-hidden` decoration. The same information is in the text beside each bar, for example a percentage and WPM.
- **Contrast:** Text contrast is at least 4.5:1 in both themes.
- **Motion:** Caret, scroll, progress bar and connecting-spinner animations are turned off when `prefers-reduced-motion` is set.
- **Small screens:** No horizontal scroll at 360px wide.

## Run locally

### Solo

Open `index.html` in a browser. Or serve the folder with any static server, for example:

```bash
python -m http.server 8000
```

Then visit `http://localhost:8000`.

### Multiplayer

Requires Node 20.12 or later.

```bash
npm install --prefix server
npm start --prefix server            # game server on http://localhost:3000
npx serve -l 5000 .                  # in a second terminal, from the repo root
```

Then:

1. Open http://localhost:5000 and press **Multiplayer**, then **Create a room**.
2. Press **Copy invite link** and open the link in a second window (or another browser).
3. Press **Join room** in the second window, then **Start race** in the first, and race.

Open the link in up to four windows to try a full room, or close the host's window to see the host pass to the next player.

- Opening `index.html` from the file system (`file://`) is always solo-only, because such pages send `Origin: null`. Serve the folder instead.
- Pages on `localhost` or `127.0.0.1` always use `http://localhost:3000`, whatever the meta tag says, so local development needs no edits.
- A `.env` file is optional. To change settings such as the port or allowed origins, copy `server/.env.example` to `server/.env` and edit it.

## Run the tests

Client tests need Node 18 or later (`describe` and `it` from `node:test` need 18.7+). There is nothing to install.

```bash
node --test tests/
```

Server tests need Node 20.12 or later and the server dependencies:

```bash
npm install --prefix server
npm test --prefix server
```

The 972 client tests cover:

- boundary validation of stored records (for example WPM 1000 is accepted, 1000.1 is not)
- the accuracy floor, so one mistake in 250 keystrokes gives 99%
- WPM and accuracy with zero, negative, `NaN` and infinite inputs
- deterministic word generation through an injected random function
- the multiplayer helpers: server URL checks, keystroke batching, and validators that reject malformed server events
- choosing the game server URL and the cold-start connecting flow (fake timers)
- room codes: normalising typed input, rejecting look-alike characters, parsing `#room=` links and building invite links
- the lobby UI flow against a fake Socket.io server: create and join, the invite banner, copying the link, the disabled Start and its hint, one announcement per change, focus at each step, host changes, sitting out a rematch, and the lobby warning with **Stay in room**
- loading the scripts in a `node:vm` context with no `document` or `window`, which proves they are DOM-free

The 411 server tests cover payload validation, origin rules, settings parsing, client IP detection behind a proxy, the rate limiters, the room state machine and scoring, and timeouts. They also run full lobbies and races between real Socket.io clients. M2 adds tests for:

- room codes: alphabet, randomness source and collision retries
- limits: the 200-room cap, per-IP create and failed-join limits, IPv6 grouped by /64, and a fifth player turned away
- host succession by join order, in the lobby and mid-race
- sit-out rematches: the host starting with only the players who pressed **Race again**
- the lobby timer: expiry, **Stay in room**, and restarting on a join or after a race

Earlier tests still cover finishing order, time limits, disconnects mid-race and client-sent scores being ignored.

## Project structure

```
index.html                 page structure: header, mode and duration settings, race panel, typing area, results, history
style.css                  theme variables, layout, caret and race styles, responsive and reduced-motion rules
words.js                   the word list (global WORDS, also exported for Node)
stats.js                   pure logic: stats, validation, word generation (no DOM)
multiplayer.js             pure multiplayer logic: URL checks, room codes, invite links, key batching, event validators (no DOM)
script.js                  state, rendering, timer, input handling, persistence, multiplayer client and lobby
tests/
  stats.test.js            unit tests for stats.js
  words.test.js            tests for the words.js Node export
  multiplayer.test.js      unit tests for multiplayer.js
  script-load.test.js      checks that solo starts with and without multiplayer.js, and the invite banner
  lobby-flow.test.js       the lobby UI flow: create, join, start, host changes, sit-outs, lobby timer
  m2-round3.test.js        edge cases from the final review round (late rematch acks, lobby deadline shifts, dead invite links)
  helpers/
    load-script.js         shared fake-DOM loader for script.js tests
    mp-harness.js          fake Socket.io server and helpers for the multiplayer UI tests
docs/
  PROTOCOL.md              every Socket.io event: payloads, limits, error codes
  DEPLOY.md                step-by-step guide to deploying the game server on Render
  screenshot.png           README screenshot
server/
  package.json             scripts (start, test), Express and Socket.io dependencies
  .env.example             every server setting, with safe defaults
  src/
    index.js               entry point: load config, start listening
    app.js                 Express app, HTTP server and Socket.io setup
    game.js                Socket.io event handlers, timers and broadcasts
    race.js                room state machine and scoring (pure)
    roomStore.js           in-memory room store, capped at 200 rooms
    roomCode.js            random room codes with crypto.randomInt and collision retries (pure)
    ipLimiter.js           per-IP token buckets for creates and failed joins, with lazy sweeping (pure)
    validate.js            payload validation (pure)
    origin.js              CORS origin rules (pure)
    clientIp.js            real client IP behind a reverse proxy, and the per-IP limiter key (IPv6 /64)
    rateLimit.js           per-socket token bucket (pure)
    config.js              reads and checks environment settings
    constants.js           protocol constants
    shared.js              reuses the root stats.js and words.js
  test/                    node:test suites, including multi-client race and lobby simulations
    roomCode.test.js       code alphabet, randomness and collision retries
    ipLimiter.test.js      per-IP buckets, refill, lazy sweeping and the entry cap
    lobby.flow.test.js     create, join, host start, full rooms, the lobby timer and Stay in room
    lobby.host.test.js     host succession by join order in every phase, and sit-out rematches
    lobby.limits.test.js   room cap, create and failed-join limits, IPv6 grouping, code collisions
render.yaml                Render Blueprint for the game server (free tier, no secrets)
.nojekyll                  tells GitHub Pages to serve the files as they are
```

## Deploy to GitHub Pages

1. Create an empty repository on GitHub, named `typing-speed-tester`.
2. Push this project:
   ```bash
   git remote add origin https://github.com/prathambasu03-git/typing-speed-tester.git
   git push -u origin main
   ```
3. On GitHub, open **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**, then pick branch `main` and folder `/ (root)`. Click **Save**.
4. After about a minute the site is live at https://prathambasu03-git.github.io/typing-speed-tester/.

GitHub Pages serves only the static client. `<meta name="typing-server-url">` in `index.html` holds the game server URL, https://typing-speed-tester-server.onrender.com, so the live site offers Multiplayer. In a fork, deploy your own server (see the next section) and put its URL in that tag; the placeholder `REPLACE_WITH_RENDER_URL` keeps the site solo-only. The first connection after the server has been idle can take about a minute, while the free instance wakes up. Pages opened from `file://` are always solo-only, and pages on `localhost` always use `http://localhost:3000`.

## Deploy the game server

The multiplayer server is set up for Render's free tier with a Blueprint, [`render.yaml`](render.yaml): one Node web service, rooms kept in memory, no Docker and no database. Deploying takes about 15 minutes:

1. Apply the Blueprint on Render and wait for the service to go live.
2. Put the service URL in the `typing-server-url` meta tag in `index.html`, then push.

The step-by-step guide, including region choice, environment variables, a cold-start check, a proxy hop check for `TRUST_PROXY_HOPS`, free-tier limits and troubleshooting, is in [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Roadmap

Multiplayer is being built in milestones:

- **M1:** one room races end to end ✓
- **Deploy:** the game server on Render's free tier ([`render.yaml`](render.yaml), [`docs/DEPLOY.md`](docs/DEPLOY.md)) ✓
- **M2:** lobby and room codes ✓
- **M3:** server-side anti-cheat
- **M4:** saved results and a leaderboard
- **Later:** Docker Compose and GitHub Actions CI

Other ideas:

- Browser tests for `script.js` (keyboard handling, phases and focus), for example with Playwright
- More solo test modes: a fixed word count, punctuation and numbers
- A per-second WPM chart on the results screen
