# Typing Speed Tester

A keyboard-first typing speed test built with vanilla HTML, CSS and JavaScript, plus a real-time two-player race mode (beta) backed by a small Node.js and Socket.io server. The browser app has no frameworks, no build step and no dependencies. It comes with 529 client tests and 233 server tests, all run with Node's built-in test runner.

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

- Two players in one room race the same 30-word passage and see each other's live progress
- The race starts automatically once two players are in, after a 3-second countdown
- You finish only when every character is correct, so mashing keys cannot win
- Results show each player's place, WPM, accuracy and time, all computed by the server
- **Race again** starts a rematch, with a new passage and a new countdown
- A sleeping free-tier server can take about a minute to wake. After 3 seconds the page says it is waking the server (with a small spinner, and **Solo** cancels), waits up to 90 seconds, then falls back to solo with a clear message
- If the server cannot be reached, the page says so and falls back to solo
- After a race, a player who does not press **Race again** within 60 seconds leaves the room. The page shows a notice and a spoken warning first

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

- **Real-time networking with Socket.io.** The client loads the Socket.io script from the game server only when Multiplayer is pressed. Keystrokes are batched (at most one progress event every 150 ms), and the server broadcasts progress every 200 ms.
- **Server-authoritative design.** The client sends only keystrokes. The server replays them against its own copy of the passage and decides what is correct, when a player finishes, and the WPM, accuracy, time and finish order. Scores or times sent by a client are ignored.
- **Shared logic.** The server reuses the browser's `stats.js` and `words.js`, so WPM and accuracy come from the same code on both sides.
- **Protocol design.** Every Socket.io event (name, direction, payload shape, limits and error codes) is specified in [`docs/PROTOCOL.md`](docs/PROTOCOL.md), and both sides implement it.
- **Defensive server.** Payload validation, a per-socket rate limit (token bucket), a per-IP connection cap that reads the real client IP behind a reverse proxy (`TRUST_PROXY_HOPS`, so players are not all counted as the proxy's address), a 4 KB message size limit, CORS restricted to the GitHub Pages origin and localhost, a 10-second join timeout and a 60-second idle removal after a race.
- **Deployed on Render.** A Render Blueprint ([`render.yaml`](render.yaml)) describes the WebSocket server on Render's free tier, with a health check, a pinned Node version and build filters so client-only pushes do not restart it. The client handles the free tier's cold start. It runs at https://typing-speed-tester-server.onrender.com; see [Deploy the game server](#deploy-the-game-server).

### Quality

- **Accessibility to WCAG 2.2 AA**, including live updates that do not flood a screen reader. See [Accessibility](#accessibility).
- **Responsive design** down to 360px wide, with no horizontal scrolling.
- **Automated tests.** The client suite uses only Node built-ins (`node:test`, `node:assert/strict`, `node:vm`). The server suite uses `node:test` and `socket.io-client`, including simulated two-client races.

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
connecting ──▶ waiting ──▶ countdown ──▶ running ──▶ finished
                  ▲            ▲                        │
                  │            └──── Race again ────────┤
                  └────────── opponent left ────────────┘
```

### Multiplayer flow

1. Pressing **Multiplayer** loads `<server-url>/socket.io/socket.io.js` and opens a WebSocket connection. Pages on `localhost` always use `http://localhost:3000`. Elsewhere the server URL comes from `<meta name="typing-server-url">` in `index.html`; on the live site that is the Render server (in a fork, the placeholder `REPLACE_WITH_RENDER_URL` keeps the page solo-only). Pages opened from `file://` are always solo-only. If the server is asleep, the client waits up to 90 seconds for it to wake.
2. The player joins the single room. When two players are in, the server sends a 3-second countdown with the passage, then the start signal.
3. While typing, the client sends batches of keystrokes (Backspace included). The server replays them, keeps each player's position and keystroke counts, and broadcasts everyone's progress.
4. The race ends when both players finish or after 2 minutes. The server sends the results and finish order.

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

A record is only accepted if its WPM is 0 to 1000, its accuracy is 0 to 100, its duration is 15, 30 or 60, and its date is a finite number. Multiplayer adds no stored data.

## Accessibility

- **Keyboard:** Tab is never captured, so focus can always move. <kbd>Esc</kbd> restarts a solo test from the typing area; it never leaves a race. The Solo/Multiplayer and duration buttons expose their state with `aria-pressed`.
- **Focus:** The typing area shows a visible focus ring. The caret hides when the area is not focused. When a race countdown starts, focus moves to the typing input so you can type at "Go". When a test or race ends, focus moves to the Results heading.
- **Screen readers:** The input is described by a text version of the upcoming words (`aria-describedby`). A single polite live region announces key moments: results and restarts in solo; connected and waiting, countdown, "Go!", opponent halfway, each finish and race over in multiplayer. There is no per-second or per-update speech. Load and connection errors use `role="alert"`.
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

Then open http://localhost:5000 in two browser windows (or two browsers), press **Multiplayer** in both, and race.

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

The 529 client tests cover:

- boundary validation of stored records (for example WPM 1000 is accepted, 1000.1 is not)
- the accuracy floor, so one mistake in 250 keystrokes gives 99%
- WPM and accuracy with zero, negative, `NaN` and infinite inputs
- deterministic word generation through an injected random function
- the multiplayer helpers: server URL checks, keystroke batching, and validators that reject malformed server events
- choosing the game server URL and the cold-start connecting flow (fake timers)
- loading the scripts in a `node:vm` context with no `document` or `window`, which proves they are DOM-free

The 233 server tests cover payload validation, origin rules, settings parsing, client IP detection behind a proxy, the rate limiter, the race state machine and scoring, timeouts, and full races between two real Socket.io clients: finishing order, time limits, a third player being turned away, disconnects mid-race and client-sent scores being ignored.

## Project structure

```
index.html                 page structure: header, mode and duration settings, race panel, typing area, results, history
style.css                  theme variables, layout, caret and race styles, responsive and reduced-motion rules
words.js                   the word list (global WORDS, also exported for Node)
stats.js                   pure logic: stats, validation, word generation (no DOM)
multiplayer.js             pure multiplayer logic: URL checks, key batching, event validators (no DOM)
script.js                  state, rendering, timer, input handling, persistence, multiplayer client
tests/
  stats.test.js            unit tests for stats.js
  words.test.js            tests for the words.js Node export
  multiplayer.test.js      unit tests for multiplayer.js
  script-load.test.js      checks that solo starts with and without multiplayer.js
  helpers/
    load-script.js         shared fake-DOM loader for script.js tests
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
    roomStore.js           in-memory room store
    validate.js            payload validation (pure)
    origin.js              CORS origin rules (pure)
    clientIp.js            real client IP behind a reverse proxy, for the per-IP cap (pure)
    rateLimit.js           per-socket token bucket (pure)
    config.js              reads and checks environment settings
    constants.js           protocol constants
    shared.js              reuses the root stats.js and words.js
  test/                    node:test suites, including two-client race simulations
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
- **M2:** lobby and room codes
- **M3:** server-side anti-cheat
- **M4:** saved results and a leaderboard
- **Later:** Docker Compose and GitHub Actions CI

Other ideas:

- Browser tests for `script.js` (keyboard handling, phases and focus), for example with Playwright
- More solo test modes: a fixed word count, punctuation and numbers
- A per-second WPM chart on the results screen
