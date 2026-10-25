// Deployment checks with a stub backend (no real backend needed).   Run: node test-deploy.js
const assert = require("assert"), http = require("http");
(async () => {
  const stub = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ pending: [] })); });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  Object.assign(process.env, { NODE_ENV: "production", ADMIN_KEY: "k", ADMIN_USER: "boss", ADMIN_PASSWORD: "pw", NEWSVOCAB_BACKEND: "http://127.0.0.1:" + stub.address().port, ALLOWED_HOSTS: "admin.example.com" });
  const admin = await require("./server").start(0), port = admin.address().port;
  const req = (path, { method = "GET", headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path, method, headers }, (m) => { let t = ""; m.on("data", (c) => (t += c)); m.on("end", () => resolve({ status: m.statusCode, headers: m.headers, text: t })); });
    r.on("error", reject); r.end(body);
  });
  const H = { host: "admin.example.com", "content-type": "application/json", "x-forwarded-proto": "https" };
  assert.strictEqual((await req("/healthz", { headers: { host: "internal" } })).status, 200, "health check works without login or allowed Host");
  assert.strictEqual((await req("/", { headers: { host: "evil.example" } })).status, 403, "unlisted Host is refused");
  assert.strictEqual((await req("/api/pending", { headers: H })).status, 401, "API closed without login");
  assert.strictEqual((await req("/api/login", { method: "POST", headers: H, body: JSON.stringify({ user: "boss", password: "bad" }) })).status, 401);
  const ok = await req("/api/login", { method: "POST", headers: H, body: JSON.stringify({ user: "boss", password: "pw" }) });
  assert.strictEqual(ok.status, 200); assert.ok(/; Secure/.test(ok.headers["set-cookie"][0]), "cookie is Secure behind HTTPS");
  const cookie = ok.headers["set-cookie"][0].split(";")[0];
  const list = await req("/api/pending", { headers: { ...H, cookie } }); assert.strictEqual(list.status, 200);
  // lockout is per client address taken from X-Forwarded-For (last entry), not per proxy
  const bad = (ip) => req("/api/login", { method: "POST", headers: { ...H, "x-forwarded-for": "1.1.1.1, " + ip }, body: JSON.stringify({ user: "boss", password: "bad" }) });
  for (let i = 0; i < 5; i++) await bad("9.9.9.9");
  assert.strictEqual((await bad("9.9.9.9")).status, 429, "locked after 5 failures");
  assert.strictEqual((await bad("8.8.8.8")).status, 401, "other clients are not locked out");
  console.log("deploy tests passed"); admin.close(); stub.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
