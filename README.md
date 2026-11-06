# NewsVocab admin

Layout: `server/` is the Node server (login, sessions, calls to the backend), `client/` holds the two pages it serves (`login.html`, `index.html`). `.env` goes in the root of this folder.

A small web app with two tabs: **Rewards** (approve or reject claims) and **Popup settings** (edit what the extension popup shows, see below).

The Rewards tab lists the "Earn free days" claims that are waiting for your decision. It lists them with the user's proof (Instagram links open in a new tab), and you press **Approve** or **Reject**. It uses the backend's existing `/admin/rewards/pending` and `/admin/rewards/decide` endpoints, so the backend needs no changes.

```bash
cd admin
node server/server.js          # Node 18+, no npm install
```

Open http://localhost:8890.

- **Login:** the page asks for a user and password (no sign-up). Both come from the environment: set `ADMIN_USER` and `ADMIN_PASSWORD` in `admin/.env` (copy `.env.example`). They are empty by default, and **login stays disabled until both are set**. Sessions last 12 hours, live in memory (a restart logs you out), and 5 wrong attempts lock login for 5 minutes.
- **Key:** `ADMIN_KEY` is read from the environment, `admin/.env`, or `backend/.env` (the same value the backend uses). It stays on this server and is never sent to the browser.
- **Backend address:** `http://localhost:8787` by default. For a deployed backend set `NEWSVOCAB_BACKEND=https://your-host` (and `ADMIN_PORT` to change the page's port).
- **Safety:** the page listens on `127.0.0.1` only, refuses other `Host` names, and accepts decisions only as JSON, so other websites and other computers cannot use it. If you ever expose it beyond this machine, put it behind HTTPS, since the login cookie is not marked Secure.
- **Approve** adds the days (to the plan now, or saved for the next Premium plan, as that reward's `apply` says). **Reject** is final: the user cannot claim that reward again, so it asks you to press twice.
- The list refreshes every 30 seconds. A claim someone else already decided is removed with a message.

Test: `node admin/server/test-admin.js` (runs the page's API against the real backend with an in-memory database).

## Popup settings tab

Edits the values the extension popup reads from the backend's `GET /config`: word limit (smallest, largest, starting number), words shown on the Free plan, trial and Premium price and days, and five popup texts (tagline, Premium button, trial button and the two lines under them). A text left empty uses the popup's standard text. A live preview shows what the popup will display. Users get a change the next time they open the popup.

- **Prices and days are display only.** The amount charged is set on the Razorpay payment page and the days granted are set in the backend. Change them there as well.
- **Checked twice.** The admin server refuses a wrong value with a message naming the field (for example "The largest word count cannot be smaller than the smallest"), and only cleaned values are sent on. Blank texts and unknown keys are dropped. The extension also ignores any bad field, so a mistake can never break the popup.
- **Needs the updated backend.** Until the backend has the endpoints below, the tab shows the standard values with Save turned off and says so.

Backend contract (the admin sends `x-admin-key`, like the rewards routes):

| Call | Body | Answer |
| --- | --- | --- |
| `GET /admin/settings` | none | `200 { settings, defaults, updated }` (`defaults` and `updated` are optional) |
| `POST /admin/settings` | `{ settings }` | `200 { settings, updated }`, or `400 { error, errors: [{ field, message }] }` |

`settings` looks like `{ wordLimit: { min, max, default }, freeWords, plans: { trial: { price, days }, premium: { price, days } }, texts: { tagline, premiumButton, trialButton, premiumInfo, trialInfo } }`. The public `GET /config` the popup reads returns the same object (no login, no secrets).

Test: `npm run test:settings` (uses a stub backend, no real backend needed).

## Deploying

No build step and no dependencies, so any Node 18+ host works (Render, Railway, Fly.io, a VPS) or use the included `Dockerfile`. No `.env` file is shipped or needed: set these in the host's environment settings.

| Variable | Required | Meaning |
| --- | --- | --- |
| `NODE_ENV` | yes | `production` (the Dockerfile sets it). Listens on `0.0.0.0` and the platform's `PORT`. |
| `NEWSVOCAB_BACKEND` | yes | Public URL of the deployed backend, e.g. `https://api.example.com`. |
| `ADMIN_KEY` | yes | Same value the backend uses. |
| `ADMIN_USER`, `ADMIN_PASSWORD` | yes | The one allowed login. Use a long password. |
| `ALLOWED_HOSTS` | recommended | Your domain(s), comma separated, e.g. `admin.example.com`. |
| `ADMIN_PORT` | no | Overrides `PORT`. |
| `TRUST_PROXY` | no | Defaults to `true` in production (reads `X-Forwarded-Proto/For` from the host's proxy). |

- Start command: `node server/server.js` (or `npm start`), run from the repo root. Health check path: `/healthz`.
- The server exits at startup if a required variable is missing, so a bad deploy shows in the logs.
- Serve it over HTTPS (all the platforms above do); the login cookie is then marked `Secure` automatically.
- Sessions are kept in memory: run **one instance** only, and a restart logs you out.
- Docker: `docker build -t newsvocab-admin .` then `docker run -p 8890:8890 -e ADMIN_KEY=... -e ADMIN_USER=... -e ADMIN_PASSWORD=... -e NEWSVOCAB_BACKEND=https://... newsvocab-admin`
- Test the deployment behaviour (no backend needed): `npm run test:deploy`.
