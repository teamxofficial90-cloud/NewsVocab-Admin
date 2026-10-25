# NewsVocab rewards admin

Layout: `server/` is the Node server (login, sessions, calls to the backend), `client/` holds the two pages it serves (`login.html`, `index.html`). `.env` goes in the root of this folder.

A small local web page for the "Earn free days" claims that are waiting for your decision. It lists them with the user's proof (Instagram links open in a new tab), and you press **Approve** or **Reject**. It uses the backend's existing `/admin/rewards/pending` and `/admin/rewards/decide` endpoints, so the backend needs no changes.

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
