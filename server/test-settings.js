// Tests the Popup settings routes of the admin app against a STUB backend (no real backend needed).   Run: node server/test-settings.js
// Checks: login is required, the admin key is sent to the backend (and never to the browser), strict validation with per-field messages,
// only cleaned values reach the backend, backend answers pass through, and an old backend without /admin/settings gives a clear message.
const assert = require("assert"), http = require("http");
(async () => {
  // ---- stub backend: GET/POST /admin/settings guarded by x-admin-key, kept in memory ----
  let stored = null, mode = "ok", seen = [];
  const DEFAULTS = { wordLimit: { min: 1, max: 13, default: 10 }, freeWords: 3, plans: { trial: { price: 1, days: 3 }, premium: { price: 14, days: 30 } }, texts: {} };
  const stub = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      seen.push({ method: req.method, url: req.url, key: req.headers["x-admin-key"], body: body ? JSON.parse(body) : null });
      if (req.url === "/admin/settings" && mode === "old") return send(404, { error: "Not found" });
      if (req.headers["x-admin-key"] !== "test-admin-key") return send(401, { error: "bad key" });
      if (req.url === "/admin/settings" && req.method === "GET") return send(200, { settings: stored || DEFAULTS, defaults: DEFAULTS, updated: stored ? "2026-11-06T10:00:00.000Z" : null });
      if (req.url === "/admin/settings" && req.method === "POST") {
        if (mode === "reject") return send(400, { error: "Backend says no", errors: [{ field: "freeWords", message: "Backend says no" }] });
        stored = JSON.parse(body).settings; return send(200, { settings: stored, updated: "2026-11-06T10:05:00.000Z" });
      }
      send(200, { pending: [] });
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  Object.assign(process.env, { ADMIN_KEY: "test-admin-key", ADMIN_USER: "boss", ADMIN_PASSWORD: "pw", NEWSVOCAB_BACKEND: "http://127.0.0.1:" + stub.address().port, PORT: "0" });
  delete process.env.NODE_ENV;
  const { start, validateSettings } = require("./server");
  const admin = await start(0), base = "http://localhost:" + admin.address().port;
  let cookie = "";
  const call = async (p, o = {}) => { const r = await fetch(base + p, { ...o, headers: { ...(cookie ? { cookie } : {}), ...(o.headers || {}) } }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) { /* html */ } return { status: r.status, text: t, json: j, headers: r.headers }; };
  const post = (p, body) => call(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const GOOD = () => ({ wordLimit: { min: 2, max: 20, default: 8 }, freeWords: 5, plans: { trial: { price: 2, days: 4 }, premium: { price: 49.5, days: 60 } }, texts: { tagline: "  Hello  ", premiumButton: "", trialButton: "Go for Rs. {trialPrice}" } });

  // 1. closed without login; no sign-up
  assert.strictEqual((await call("/api/settings")).status, 401);
  assert.strictEqual((await post("/api/settings", { settings: GOOD() })).status, 401);
  assert.strictEqual(seen.length, 0, "nothing reached the backend without a login");
  const li = await post("/api/login", { user: "boss", password: "pw" }); assert.strictEqual(li.status, 200); cookie = li.headers.get("set-cookie").split(";")[0];

  // 2. the page has the new tab and never contains the key
  const page = await call("/"); assert.ok(page.text.includes("Popup settings") && page.text.includes("Pending rewards") && page.text.includes('id="sform"'));
  assert.ok(!page.text.includes("test-admin-key"), "the key never reaches the browser");

  // 3. load: passes through, key sent to the backend
  let r = await call("/api/settings"); assert.strictEqual(r.status, 200); assert.strictEqual(r.json.settings.freeWords, 3);
  assert.strictEqual(seen[seen.length - 1].key, "test-admin-key");

  // 4. validation: every kind of bad value is refused with a field name, and nothing is sent to the backend
  const before = seen.length;
  const bad = (mut, field) => { const s = GOOD(); mut(s); const v = validateSettings(s); assert.ok(!v.ok, "should be refused: " + field); assert.ok(v.errors.some((e) => e.field === field), "error names " + field + ": " + JSON.stringify(v.errors)); };
  bad((s) => { s.wordLimit.min = 10; s.wordLimit.max = 5; }, "wordLimit.max");
  bad((s) => { s.wordLimit.default = 99; }, "wordLimit.default");
  bad((s) => { s.wordLimit.max = 101; }, "wordLimit.max");
  bad((s) => { s.wordLimit.min = 0; }, "wordLimit.min");
  bad((s) => { s.wordLimit.min = 1.5; }, "wordLimit.min");
  bad((s) => { s.wordLimit.max = ""; }, "wordLimit.max");
  bad((s) => { s.freeWords = -1; }, "freeWords");
  bad((s) => { delete s.freeWords; }, "freeWords");
  bad((s) => { s.plans.premium.days = 0; }, "plans.premium.days");
  bad((s) => { s.plans.trial.days = 3651; }, "plans.trial.days");
  bad((s) => { s.plans.premium.price = -5; }, "plans.premium.price");
  bad((s) => { s.plans.trial.price = 1.005; }, "plans.trial.price");
  bad((s) => { s.plans.trial.price = "abc"; }, "plans.trial.price");
  bad((s) => { s.texts.tagline = "Hi {evil}"; }, "texts.tagline");
  bad((s) => { s.texts.trialInfo = "x".repeat(301); }, "texts.trialInfo");
  bad((s) => { s.texts.premiumInfo = 42; }, "texts.premiumInfo");
  assert.ok(!validateSettings(null).ok && !validateSettings([]).ok && !validateSettings("x").ok);
  r = await post("/api/settings", { settings: { ...GOOD(), freeWords: -1 } }); assert.strictEqual(r.status, 400); assert.strictEqual(r.json.reason, "INVALID_SETTINGS"); assert.strictEqual(r.json.errors[0].field, "freeWords");
  r = await post("/api/settings", {}); assert.strictEqual(r.status, 400);
  r = await post("/api/settings", { settings: { wordLimit: { min: 9, max: 3, default: 1 }, freeWords: "x", plans: {}, texts: {} } }); assert.strictEqual(r.status, 400); assert.ok(r.json.errors.length >= 4 && /more to fix/.test(r.json.error));
  assert.strictEqual(seen.length, before, "refused values never reach the backend");

  // 5. valid save: numbers typed as text are accepted, texts are trimmed, blank texts and unknown keys are dropped
  const dirty = GOOD(); dirty.wordLimit.min = "2"; dirty.plans.premium.price = "49.5"; dirty.hacker = { x: 1 }; dirty.texts.evil = "x"; dirty.plans.gold = { price: 1, days: 1 };
  r = await post("/api/settings", { settings: dirty }); assert.strictEqual(r.status, 200, r.text);
  const sent = seen[seen.length - 1]; assert.strictEqual(sent.method, "POST"); assert.strictEqual(sent.key, "test-admin-key");
  assert.deepStrictEqual(sent.body.settings, { wordLimit: { min: 2, max: 20, default: 8 }, freeWords: 5, plans: { trial: { price: 2, days: 4 }, premium: { price: 49.5, days: 60 } }, texts: { tagline: "Hello", trialButton: "Go for Rs. {trialPrice}" } });
  assert.deepStrictEqual(Object.keys(sent.body), ["settings"]);
  assert.strictEqual(r.json.updated, "2026-11-06T10:05:00.000Z");
  r = await call("/api/settings"); assert.strictEqual(r.json.settings.freeWords, 5, "what was saved is what loads");

  // 6. backend refusal passes through; non-JSON POST refused; old backend gives a clear message
  mode = "reject"; r = await post("/api/settings", { settings: GOOD() }); assert.strictEqual(r.status, 400); assert.strictEqual(r.json.error, "Backend says no");
  mode = "ok"; assert.strictEqual((await call("/api/settings", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415);
  mode = "old"; r = await call("/api/settings"); assert.strictEqual(r.status, 404); assert.strictEqual(r.json.reason, "NO_ENDPOINT"); assert.ok(/updated backend/i.test(r.json.error));
  r = await post("/api/settings", { settings: GOOD() }); assert.strictEqual(r.status, 404); assert.strictEqual(r.json.reason, "NO_ENDPOINT");
  mode = "ok";

  // 7. wrong admin key on the admin server is reported, not leaked
  process.env.ADMIN_KEY = "test-admin-key";

  // 8. logout closes it again
  await post("/api/logout", {}); assert.strictEqual((await call("/api/settings")).status, 401);
  console.log("admin settings tests passed"); admin.close(); stub.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
