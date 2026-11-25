# Deploying the game server to Render (free tier)

This guide puts the multiplayer game server in `server/` on Render's free
tier, then points the GitHub Pages site at it. It takes about 15 minutes, most
of which is waiting for the first deploy.

The settings live in [`render.yaml`](../render.yaml) at the repo root (a Render
"Blueprint"). The same settings are listed for the dashboard in case you
prefer to click through it.

## 1. What is deployed and what is not

Deployed:

- **One Render web service** (Node runtime, free instance) that runs
  `node server/src/index.js`: Express plus Socket.io, with the `/health` route.

Not deployed (not needed yet):

- **No Docker.** Render builds the service with its native Node runtime.
- **No database and no Redis.** Rooms live in the server's memory. They are
  lost whenever the instance sleeps, restarts or redeploys. That is accepted
  for now; saved results come in M4.
- **The client is not on Render.** It stays on GitHub Pages at
  `https://prathambasu03-git.github.io/typing-speed-tester/`. Only one line in
  `index.html` changes (step 5).

## 2. Choose the region first

`render.yaml` uses `region: singapore` (Asia), because it is the closest Render
region to players in India and so gives the lowest latency. Render's default is
`oregon` (US West). If most of your players are elsewhere, pick a closer
region, for example `frankfurt` (Europe). Other values Render accepts are
`oregon`, `ohio` and `virginia`.

**Decide before step 3.** Render cannot move an existing service to another
region. To change it later you would have to delete the service and create a
new one (and its URL may change). To use another region, edit the `region:`
line in `render.yaml`, commit and push, and only then apply the Blueprint.

## 3. Create the service from the Blueprint (recommended)

1. Make sure `render.yaml` is committed and pushed to the `main` branch on
   GitHub:

   ```sh
   git push origin main
   ```

2. Sign in at <https://dashboard.render.com> (signing up with your GitHub
   account is simplest). The free tier needs no credit card for a free web
   service.
3. Click **New** → **Blueprint**.
4. Connect GitHub if asked, and give Render access to the
   `prathambasu03-git/typing-speed-tester` repository (access to this one
   repository is enough).
5. Select the repository. Render reads `render.yaml` from `main` and shows one
   service, `typing-speed-tester-server`, on the **Free** plan.
6. Enter a Blueprint name if asked (anything, for example `typing-speed-tester`),
   then click **Apply** (the button may be labelled **Deploy Blueprint**).
7. Open the service and watch the **Logs** / **Events** tab. The first build
   runs `cd server && npm ci --omit=dev`, then starts the server. A successful
   deploy logs a line like:

   ```
   [server] listening on port 10000
   ```

   (Render chooses the port and passes it in `PORT`; the number may differ.)
   The service status turns **Live**.
8. Copy the service URL from the top of the service page. It looks like
   `https://typing-speed-tester-server.onrender.com`. If that name was already
   taken, Render adds a suffix (for example
   `https://typing-speed-tester-server-ab12.onrender.com`). Use the exact URL
   Render shows. Below it is called `<your-service-url>`.

## 4. Or create it by hand in the dashboard

Skip this section if you used the Blueprint. Click **New** → **Web Service**,
pick the repository, and fill in the form with these values. Render may
pre-fill the build and start commands with `npm install` / `npm start`;
replace them.

| Setting | Value |
|---------|-------|
| Name | `typing-speed-tester-server` |
| Language | `Node` |
| Branch | `main` |
| Region | `Singapore (Southeast Asia)`, or your choice from section 2 |
| Root Directory | *(leave empty)* |
| Build Command | `cd server && npm ci --omit=dev` |
| Start Command | `node server/src/index.js` |
| Instance Type | `Free` |
| Health Check Path | `/health` (under **Advanced**) |
| Auto-Deploy | `On Commit` (Yes) |
| Build Filters (optional, under **Advanced** or later in **Settings**) | Included paths: `server/**`, `stats.js`, `words.js`. Ignored paths: `server/test/**` |

Environment variables (**Environment** section, **Add Environment Variable**):

| Key | Value | Why |
|-----|-------|-----|
| `NODE_VERSION` | `22` | Pins Node 22 LTS (section 5). |
| `CORS_ORIGINS` | `https://prathambasu03-git.github.io` | The only browser origin allowed to connect. Origin only: no `/typing-speed-tester` path and no trailing slash, because the server compares it exactly. |
| `ALLOW_LOCALHOST` | `false` | Refuse `http://localhost:*` pages in production. |
| `ALLOW_NULL_ORIGIN` | `false` | Refuse pages opened from `file://` (`Origin: null`). |
| `TRUST_PROXY_HOPS` | `1` | Render has one proxy in front of the app; the server reads the client IP from the last `X-Forwarded-For` entry. Checked in section 7.4. |
| `MAX_CONNECTIONS_PER_IP` | `10` | Concurrent Socket.io connections allowed from one IP address. |
| `PORT` | *(do not add)* | Render sets it; `server/src/config.js` reads it. |

Then click **Create Web Service** and continue from step 7 of section 3.

**Why Root Directory must stay empty:** `server/src/shared.js` loads
`../../stats.js` and `../../words.js` from the repo root (the same files the
client uses). Render's docs say a service with a root directory may not be
able to use files outside it, so the service builds from the repo root and the
build command `cd`s into `server/`. The start command runs from the repo root,
so those paths resolve.

## 5. Why Node is pinned with `NODE_VERSION`

- Render checks the `NODE_VERSION` environment variable first, before a
  `.node-version` file, an `.nvmrc` file or `engines` in `package.json`.
- With no root directory, Render looks for `engines` in a `package.json` at the
  repo root. There is none, so the `"node": ">=20.12"` in
  `server/package.json` would not be seen, and Render would use its own
  default version.
- `>=20.12` is a range anyway, so it would float to whatever is newest.
- Node 22 is the current LTS and meets `>=20.12`. Setting a major version
  (`22`) gets the latest 22.x patch on each deploy.
- An environment variable avoids adding another dotfile to the repo.

To move to a newer Node later, change the value in `render.yaml` (or in the
dashboard) and redeploy.

## 6. Point the client at the server

Until this step the live site shows no Multiplayer button, because the meta
tag in `index.html` holds the placeholder `REPLACE_WITH_RENDER_URL`.

1. Open `index.html` and find:

   ```html
   <meta name="typing-server-url" content="REPLACE_WITH_RENDER_URL">
   ```

2. Replace the placeholder with `<your-service-url>`, the **origin only**:
   `https://`, the host, nothing after it. No path, no trailing slash. For
   example:

   ```html
   <meta name="typing-server-url" content="https://typing-speed-tester-server.onrender.com">
   ```

   It must start with `https://`. An `http://` URL is blocked on the `https`
   Pages site, so the client hides Multiplayer.
3. Commit and push:

   ```sh
   git add index.html
   git commit -m "Point multiplayer at the Render server"
   git push origin main
   ```

4. Wait for GitHub Pages to republish (about a minute; see the **Actions** tab
   or **Settings** → **Pages** on GitHub). This push does not redeploy the
   server, because of the build filter.

Notes:

- Pages served from `localhost` or `127.0.0.1` ignore this tag and always use
  `http://localhost:3000`, so local development needs no edits.
- Pages opened from `file://` are always solo-only, even with the URL filled
  in.

## 7. Verify

### 7.1 Health check

```sh
curl https://<your-service-url-host>/health
```

(for example `curl https://typing-speed-tester-server.onrender.com/health`).

Expected output:

```json
{"status":"ok"}
```

If the service was asleep, the first call can take about a minute.

### 7.2 Two-window race

1. Open `https://prathambasu03-git.github.io/typing-speed-tester/` in two
   windows, for example a normal window and a private window.
2. Press **Multiplayer** in both. They join the same room.
3. Race to the end and check that both windows show the results.

### 7.3 Cold-start check

1. Leave the site closed for more than 15 minutes, so the server spins down.
2. Open the live site and press **Multiplayer**.
3. Expected: "Connecting to the multiplayer server…", then after about 3
   seconds "Waking up the game server, this can take up to a minute…".
4. The connection then succeeds (within about a minute) and you join a room.

### 7.4 Hop check (`TRUST_PROXY_HOPS`)

This checks that the per-IP limit counts each player by their own address,
not Render's proxy address. It logs no IPs. It relies on one fact: the per-IP
limit refuses a connection at the handshake, which the client reports as
"Could not reach the multiplayer server…". A "The race room is full" message
means the connection **was** accepted, because the room check comes after the
handshake.

1. In the Render dashboard, open the service → **Environment**, temporarily
   set `MAX_CONNECTIONS_PER_IP` to `2`, and save. The service restarts.
2. On one computer, open the live site in three tabs. Press **Multiplayer**
   in tabs 1 and 2. Both join.
3. **Immediately**, on a phone on mobile data (a different IP, so turn Wi-Fi
   off), open the site and press **Multiplayer**. Expected: "The race room is
   full…". The phone's connection was accepted, so it has its own count.
4. Only then press **Multiplayer** in tab 3 on the computer. Expected: "Could
   not reach…" after the wake budget runs out (up to 90 s). The limit applies
   to this computer.
5. If the phone shows "Could not reach…" instead, every client shares one key.
   Set `TRUST_PROXY_HOPS=2` and repeat from step 2.
6. Restore `MAX_CONNECTIONS_PER_IP` to `10`.

Notes on reading the result:

- The phone step only counts while tabs 1 and 2 still show they are in the
  room, with no "You were idle…" message. With nobody typing, their race ends
  after about 2 minutes, and about a minute later the server disconnects both
  tabs as idle, which frees the computer's count.
- If the phone shows "Connected. Waiting for an opponent.", the result is
  inconclusive (tabs 1 and 2 had probably already left). Repeat from step 2.
- Optionally, press **Race again** in tabs 1 and 2 after their race ends, so
  they are not disconnected as idle.

If you had to change `TRUST_PROXY_HOPS`, also change it in `render.yaml` and
commit, so the file matches the dashboard. Never set it higher than the real
number of proxies, or clients can fake their address.

## 8. Free-tier limits

- **Spin-down:** the service goes to sleep after about 15 minutes with no
  inbound traffic. Socket.io's 25-second heartbeat counts as traffic, so it
  stays up while players are connected.
- **Cold start:** the first request after sleeping takes about a minute. The
  client shows the waking message and waits up to 90 seconds.
- **Rooms reset:** rooms are in memory, so they are lost on spin-down,
  redeploy or restart. Players in a race at that moment see "Lost connection…"
  and drop back to solo.
- **Instance hours:** 750 free instance hours per workspace per month. One
  service running all month needs at most 744, so this is enough, but the
  hours are shared with any other free services in the same workspace.
- **Memory:** the free instance has 512 MB of RAM, which is plenty for this
  server.
- No keep-alive pinger is used on purpose: it would burn instance hours and
  need a third-party service.

## 9. Troubleshooting

| Symptom | Likely cause and fix |
|---------|----------------------|
| Waking message, then "Could not reach" on a server that `/health` shows is up | Two possible causes. (1) `CORS_ORIGINS` is wrong. It must be exactly `https://prathambasu03-git.github.io`: no path, no trailing slash. Fix it under **Environment** and save. (2) The per-IP cap (`MAX_CONNECTIONS_PER_IP`) refused the connection, for example more than 10 tabs, or players behind one school or office network, or a wrong `TRUST_PROXY_HOPS` that makes everyone share one key (see [section 7.4](#74-hop-check-trust_proxy_hops)). To tell them apart, open the browser console: a CORS refusal names the origin, while a cap refusal is a plain failed WebSocket handshake. |
| Multiplayer button missing on the live site | The meta tag still holds the placeholder, or holds an `http:` URL. Redo section 6, then hard-refresh the page (Ctrl+F5) once Pages has republished. |
| Phone refused in the hop check | `TRUST_PROXY_HOPS` is wrong (see section 7.4). |
| Deploy fails with `Cannot find module '../../stats.js'` | A Root Directory (`rootDir`) was set. Remove it (**Settings** → **Root Directory**, leave empty) and redeploy. |

Other places to look: the service's **Logs** tab shows `[config]` warnings
when an environment variable has a bad value (the server then falls back to
the default), and the **Events** tab shows failed builds and health checks.

## 10. Redeploys and changing environment variables

- **Automatic redeploys:** every push to `main` that changes `server/**`
  (except `server/test/**`), `stats.js` or `words.js` redeploys the server.
  Pushes that only change the client, tests or docs do not, so live rooms are
  not dropped for nothing.
- **Manual redeploy:** service page → **Manual Deploy** → **Deploy latest
  commit**.
- **Changing an environment variable:** service page → **Environment** → edit
  → **Save Changes**. Render restarts the service with the new value (it may
  offer "Save, rebuild, and deploy" or "Save and deploy"; either works).
  Live rooms are lost on the restart.
- **Keep `render.yaml` in sync:** after changing a value in the dashboard,
  make the same change in `render.yaml` and commit it. Values set in
  `render.yaml` can overwrite dashboard edits the next time the Blueprint
  syncs.
- **Adding your own domain or another Pages origin:** add it to
  `CORS_ORIGINS`, comma-separated, each as an exact origin.

## 11. Secrets

No secrets are involved. Every value in `render.yaml` and above is public
configuration and safe to commit. There is no database password or API key
yet. When secrets arrive (M4), they go in the Render dashboard only (or as
`sync: false` entries in `render.yaml`, which Render asks you to fill in),
never in the repo. Local values go in `server/.env`, which is git-ignored;
every variable is listed in `server/.env.example`.

## Placeholders to fill in

| Placeholder | Where | What to put |
|-------------|-------|-------------|
| `<your-service-url>` | Sections 3, 6 | The URL Render shows for the service, for example `https://typing-speed-tester-server.onrender.com` (it may have a suffix). |
| `<your-service-url-host>` | Section 7.1 | The same URL without `https://`, for the `curl` command. |
| `REPLACE_WITH_RENDER_URL` | `index.html`, the `typing-server-url` meta tag | `<your-service-url>`: origin only, `https://`, no path, no trailing slash. |
