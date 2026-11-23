# Typing Speed Tester

A minimal typing speed test built with **vanilla HTML, CSS and JavaScript**: no frameworks, no build step, no dependencies.

**Live demo:** `https://<your-username>.github.io/<repo-name>/`

## Features

- 15 / 30 / 60 second tests
- Live WPM, accuracy and countdown
- Results: WPM, raw WPM, accuracy, correct / incorrect characters
- Personal best for each duration, plus the last 10 results (saved in `localStorage`)
- Dark and light themes (remembers your choice and follows your system setting by default)
- Smooth floating caret that scrolls the text line by line
- Text keeps growing, so you never run out of words
- Keyboard first: <kbd>Tab</kbd> restarts at any time
- Works on mobile (on-screen keyboard) and down to 360px wide
- Accessible: semantic HTML, visible focus, results announced to screen readers, AA color contrast, reduced-motion support

## Project structure

```
index.html   page structure (header, settings, text area, results, history)
style.css    theme variables, layout, character / caret styles, responsive rules
script.js    state, rendering, timer, stats, input handling, persistence
words.js     the word list
```

## How it works

### 1. One state object
Everything about the current test lives in a single `state` object:

| field | meaning |
|---|---|
| `phase` | `'idle'`, `'running'` or `'finished'` |
| `chars` | the expected characters |
| `index` | position of the next character to type |
| `results` | `null` / `'correct'` / `'incorrect'` for each character |
| `duration`, `timeLeft` | seconds |
| `startTime` | `Date.now()` when typing began |
| `intervalId` | the `setInterval` handle |
| `totalKeystrokes`, `correctKeystrokes` | used for accuracy |

Data only flows one way: **event → update state → render**. Render functions only write to the DOM, and the app never reads its state back out of the DOM.

### 2. Phases
```
idle ──first valid key──▶ running ──timer hits 0──▶ finished
  ▲                                                    │
  └──────────────────── restart (Tab / button) ────────┘
```

### 3. Rendering text efficiently
50 random words are joined with spaces and split into characters. Each character becomes a `<span>`. All spans are built inside a `DocumentFragment` and inserted at once. References are kept in a `spans` array, so a keystroke updates **one span** (`spans[i]`) instead of re-rendering the text.

### 4. Timing accurately
The interval (every 100 ms) only *refreshes the display*. Time is always measured as `Date.now() - startTime`, because interval ticks drift and are slowed down in background tabs.

### 5. Stats as pure functions
- **WPM** = (correct characters ÷ 5) ÷ minutes
- **Raw WPM** = (all typed characters ÷ 5) ÷ minutes
- **Accuracy** = correct keystrokes ÷ total keystrokes × 100

Each formula guards against dividing by zero and passes its result through `Number.isFinite`, so `NaN` and `Infinity` never reach the screen.

## Run locally
Open `index.html` in a browser. That's it.

## Deploy to GitHub Pages
1. Create an empty repository on GitHub (for example `typing-speed-tester`).
2. Push this project:
   ```bash
   git remote add origin https://github.com/<your-username>/<repo-name>.git
   git push -u origin main
   ```
3. On GitHub, open **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**, then pick branch `main` and folder `/ (root)`. Click **Save**.
4. After about a minute the site is live at `https://<your-username>.github.io/<repo-name>/`.
