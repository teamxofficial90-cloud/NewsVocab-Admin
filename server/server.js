// NewsVocab rewards admin: a small local web app to review pending reward claims and approve or reject them.
// It talks to the backend's existing endpoints (GET /admin/rewards/pending, POST /admin/rewards/decide) and keeps ADMIN_KEY on THIS
// server, so the key never reaches the browser and the backend's CORS settings need no change. Zero dependencies (Node 18+).
//   cd admin && node server/server.js      then open http://localhost:8890   (pages live in admin/client)
// Deployed (NODE_ENV=production): listens on 0.0.0.0 and the platform's PORT, serves GET /healthz, marks the login cookie Secure behind HTTPS,
// and needs ADMIN_KEY, ADMIN_USER, ADMIN_PASSWORD and NEWSVOCAB_BACKEND in the host's environment (no .env file is shipped).
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");

try { // ADMIN_KEY: from the environment, else admin/.env, else backend/.env (the same key the backend uses)
  for (const file of [path.join(__dirname, "..", ".env"), path.join(__dirname, ".env"), path.join(__dirname, "..", "..", "backend", ".env")]) {
    let text; try { text = fs.readFileSync(file, "utf8"); } catch (e) { continue; }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch (e) { /* no .env files */ }

const PRODUCTION = process.env.NODE_ENV === "production";
// Port: ADMIN_PORT wins; a hosting platform's PORT is used only when NEWSVOCAB_BACKEND is set (otherwise PORT means the local backend's port).
const PORT = Number(process.env.ADMIN_PORT || (process.env.NEWSVOCAB_BACKEND && process.env.PORT) || 8890);
const HOST = process.env.HOST || (PRODUCTION ? "0.0.0.0" : "127.0.0.1"); // local runs stay on 127.0.0.1; production must accept the platform's proxy
const LOOPBACK = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";
const ALLOWED_HOSTS = String(process.env.ALLOWED_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean); // e.g. admin.example.com
const TRUST_PROXY = process.env.TRUST_PROXY ? process.env.TRUST_PROXY === "true" : PRODUCTION; // behind the host's reverse proxy: trust X-Forwarded-*
const BACKEND = (process.env.NEWSVOCAB_BACKEND || "http://localhost:" + (process.env.PORT || 8787)).replace(/\/$/, "");
const ADMIN_KEY = process.env.ADMIN_KEY || "";
// Login (no sign-up): the one allowed user comes from the environment. Both are empty by default, and login stays OFF until you set them.
const ADMIN_USER = process.env.ADMIN_USER || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const PAGE = path.join(__dirname, "..", "client", "index.html");
const LOGIN_PAGE = path.join(__dirname, "..", "client", "login.html");

const json = (res, status, obj) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };


// ---- Login sessions (in memory: restarting the server logs everyone out) ----
const SESSION_MS = 12 * 60 * 60 * 1000, COOKIE = "admin_session";
const sessions = new Map();   // token -> expiry time (ms)
const fails = new Map();      // ip -> { count, until }  (simple brute-force brake)
const loginEnabled = () => ADMIN_USER !== "" && ADMIN_PASSWORD !== "";
const sha = (v) => crypto.createHash("sha256").update(String(v)).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b)); // constant-time compare
const cookieToken = (req) => { const m = String(req.headers.cookie || "").match(new RegExp("(?:^|;\\s*)" + COOKIE + "=([a-f0-9]{64})")); return m ? m[1] : ""; };
const isAuthed = (req) => { const t = cookieToken(req), exp = sessions.get(t); if (!exp) return false; if (exp < Date.now()) { sessions.delete(t); return false; } return true; };
const isHttps = (req) => !!req.socket.encrypted || (TRUST_PROXY && /^https\b/i.test(String(req.headers["x-forwarded-proto"] || "")));
const setCookie = (req, res, value, maxAgeSec) => res.setHeader("set-cookie", COOKIE + "=" + value + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + maxAgeSec + (isHttps(req) ? "; Secure" : ""));
// Behind a proxy every request comes from the proxy, so use the address the proxy appended (the LAST X-Forwarded-For entry; earlier ones can be forged).
const ipOf = (req) => { if (TRUST_PROXY) { const xf = String(req.headers["x-forwarded-for"] || "").split(",").map((v) => v.trim()).filter(Boolean); if (xf.length) return xf[xf.length - 1]; } return req.socket.remoteAddress || "local"; };

function login(req, res, b) {
  if (!loginEnabled()) return json(res, 503, { error: "Login is not set up. Set ADMIN_USER and ADMIN_PASSWORD (in admin/.env) and restart the server." });
  const ip = ipOf(req), f = fails.get(ip);
  if (f && f.until > Date.now()) return json(res, 429, { error: "Too many failed attempts. Try again in a few minutes." });
  const ok = typeof b.user === "string" && typeof b.password === "string" && same(b.user, ADMIN_USER) & same(b.password, ADMIN_PASSWORD); // & (not &&): always check both
  if (!ok) {
    const n = (f && !(f.until && f.until <= Date.now()) ? f.count : 0) + 1; // a finished lockout starts the count over
    fails.set(ip, { count: n, until: n >= 5 ? Date.now() + 5 * 60 * 1000 : 0 });
    return json(res, 401, { error: "Wrong user or password." });
  }
  fails.delete(ip);
  for (const [k, v] of fails) if (v.until && v.until <= Date.now()) fails.delete(k); // tidy finished lockouts
  for (const [t, exp] of sessions) if (exp < Date.now()) sessions.delete(t); // tidy expired sessions
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + SESSION_MS);
  setCookie(req, res, token, SESSION_MS / 1000);
  json(res, 200, { ok: true });
}

// Only this machine's own page may call the API: the Host header must be localhost (stops DNS-rebinding), and POST must be JSON
// (a page on another site cannot send that without a CORS preflight, which this server never approves).
// Deployed: set ALLOWED_HOSTS to your domain(s) to restrict Host the same way; unset on a public bind means any Host (the login still protects everything).
const hostOk = (req) => {
  const host = String(req.headers.host || "").toLowerCase();
  if (ALLOWED_HOSTS.length) return ALLOWED_HOSTS.includes(host) || ALLOWED_HOSTS.includes(host.replace(/:\d+$/, ""));
  return LOOPBACK ? /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host) : true;
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > 10 * 1024) reject(Object.assign(new Error("Request too large."), { status: 413 })); else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) || {}); } catch (e) { reject(Object.assign(new Error("Invalid JSON."), { status: 400 })); } });
    req.on("error", reject);
  });
}

// Calls the backend with the admin key and passes its status and JSON body through.
async function callBackend(method, urlPath, body) {
  if (!ADMIN_KEY) return { status: 500, body: { error: "ADMIN_KEY is not set. Put it in admin/.env or backend/.env (the same value the backend uses)." } };
  let res;
  try {
    res = await fetch(BACKEND + urlPath, {
      method, signal: AbortSignal.timeout(15000),
      headers: { "x-admin-key": ADMIN_KEY, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) { return { status: 502, body: { error: "Cannot reach the NewsVocab backend at " + BACKEND + ". Is it running?" } }; }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) data.error = "The backend rejected the admin key. Check ADMIN_KEY.";
  if (res.status === 404 && urlPath.startsWith("/admin/rewards/pending")) data.error = data.error === "Not found" ? "The backend has no ADMIN_KEY set, so its admin endpoints are off." : data.error;
  return { status: res.status, body: data };
}

async function route(req, res) {
  const url0 = req.url.split("?")[0]; // health check for the hosting platform: no login, no Host check, no secrets
  if ((req.method === "GET" || req.method === "HEAD") && url0 === "/healthz") { res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }); return res.end(req.method === "HEAD" ? undefined : "ok"); }
  if (!hostOk(req)) return json(res, 403, { error: ALLOWED_HOSTS.length ? "This host name is not allowed." : "Open this page at http://localhost:" + PORT });
  const url = req.url.split("?")[0];
  const page = (file) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", ...(isHttps(req) ? { "strict-transport-security": "max-age=31536000" } : {}) }); res.end(fs.readFileSync(file)); };

  // Public: the login page and the login/logout calls. There is no sign-up.
  if (req.method === "GET" && (url === "/" || url === "/index.html")) return page(isAuthed(req) ? PAGE : LOGIN_PAGE);
  if (req.method === "POST" && url === "/api/login") {
    if (!/^application\/json/i.test(req.headers["content-type"] || "")) return json(res, 415, { error: "Send JSON." });
    return login(req, res, await readBody(req));
  }
  if (req.method === "POST" && url === "/api/logout") {
    if (!/^application\/json/i.test(req.headers["content-type"] || "")) return json(res, 415, { error: "Send JSON." });
    sessions.delete(cookieToken(req)); setCookie(req, res, "", 0); return json(res, 200, { ok: true });
  }

  // Everything below needs a logged-in session.
  if (!isAuthed(req)) return json(res, 401, { error: "Please log in.", reason: "LOGIN_REQUIRED" });
  if (req.method === "GET" && url === "/api/pending") { const r = await callBackend("GET", "/admin/rewards/pending"); return json(res, r.status, r.body); }
  if (req.method === "POST" && url === "/api/decide") {
    if (!/^application\/json/i.test(req.headers["content-type"] || "")) return json(res, 415, { error: "Send JSON." });
    const b = await readBody(req);
    if (typeof b.email !== "string" || typeof b.reward !== "string" || typeof b.approve !== "boolean") return json(res, 400, { error: "Send { email, reward, approve }." });
    const r = await callBackend("POST", "/admin/rewards/decide", { email: b.email, reward: b.reward, approve: b.approve });
    return json(res, r.status, r.body);
  }
  json(res, 404, { error: "Not found" });
}

function start(port = PORT) {
  const server = http.createServer((req, res) => route(req, res).catch((e) => json(res, e.status || 500, { error: e.status ? e.message : "Server error." })));
  return new Promise((resolve) => server.listen(port, HOST, () => { // local: 127.0.0.1 only. Production: 0.0.0.0 so the platform's proxy can reach it
    console.log("Rewards admin on " + (LOOPBACK ? "http://localhost:" : HOST + ":") + server.address().port + "  (backend: " + BACKEND + ")");
    if (!ADMIN_KEY) console.warn("WARNING: ADMIN_KEY is not set; the page will show an error until it is.");
    if (!loginEnabled()) console.warn("WARNING: ADMIN_USER / ADMIN_PASSWORD are not set; nobody can log in until they are.");
    resolve(server);
  }));
}

if (require.main === module) {
  if (PRODUCTION) { // fail loudly on a bad deploy instead of serving a page that cannot work
    const missing = ["ADMIN_KEY", "ADMIN_USER", "ADMIN_PASSWORD", "NEWSVOCAB_BACKEND"].filter((k) => !process.env[k]);
    if (missing.length) { console.error("Missing environment variables: " + missing.join(", ")); process.exit(1); }
  }
  start().then((server) => { for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0))); });
}
module.exports = { start };
