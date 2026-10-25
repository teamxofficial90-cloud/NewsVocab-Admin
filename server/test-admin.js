// Runs the admin app against the REAL backend (in-memory database) with one pending claim:
// list, approve, reject, repeated decision, wrong key, and the local-only protections.   Run: node admin/server/test-admin.js
process.env.ADMIN_KEY = "test-admin-key"; process.env.ADMIN_USER = "boss"; process.env.ADMIN_PASSWORD = "s3cret-pass"; process.env.PORT = "0"; process.env.GEMINI_API_KEY = "x"; process.env.SESSION_SECRET = "s";
const assert = require("assert"), path = require("path");
(async () => {
  const { createMemoryCollections } = require("../../backend/memory-db");
  const cols = createMemoryCollections();
  const backend = await require("../../backend/server").start(cols, { today: () => "2026-10-24" });
  process.env.NEWSVOCAB_BACKEND = "http://localhost:" + backend.address().port;
  const admin = await require("./server").start(0);
  const base = "http://localhost:" + admin.address().port;

  const users = [["a@gmail.com", "2026-10-20"], ["b@gmail.com", "2026-10-30"]];   // a is on the Free plan, b is Premium
  for (const [email, expiry_date] of users) await cols.users.insertOne({ email, expiry_date, daily_quota: 13, last_used: null });
  const ua = await cols.users.findOne({ email: "a@gmail.com" }), ub = await cols.users.findOne({ email: "b@gmail.com" });
  await cols.rewards.insertOne({ key: ua._id + ":review", user_id: ua._id, email: ua.email, reward: "review", days: 3, apply: "now", status: "pending", created: new Date("2026-10-23T10:00:00Z"), proof: "Asha K", proof_link: "" });
  await cols.rewards.insertOne({ key: ub._id + ":instagram", user_id: ub._id, email: ub.email, reward: "instagram", days: 7, apply: "next_premium", status: "pending", created: new Date("2026-10-24T08:00:00Z"), proof: "https://www.instagram.com/p/ABCDE12345/", proof_link: "https://www.instagram.com/p/ABCDE12345/" });

  let cookie = "";
  const get = async (p, o = {}) => { const r = await fetch(base + p, { ...o, headers: { ...(cookie ? { cookie } : {}), ...(o.headers || {}) } }); return { status: r.status, text: await r.text(), headers: r.headers }; };
  const post = (p, body, headers) => get(p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  // login: the page and API are closed until the env user and password are given; there is no sign-up
  assert.ok((await get("/")).text.includes("Log in"), "logged-out visitors get the login page");
  assert.strictEqual((await get("/api/pending")).status, 401); assert.strictEqual((await post("/api/decide", { email: "a@gmail.com", reward: "review", approve: true })).status, 401);
  assert.strictEqual((await post("/api/signup", { user: "x", password: "y" })).status, 401, "no sign-up route");
  assert.strictEqual((await post("/api/login", { user: "boss", password: "wrong" })).status, 401);
  assert.strictEqual((await post("/api/login", { user: "", password: "" })).status, 401, "empty credentials never work when the env has values");
  const li = await post("/api/login", { user: "boss", password: "s3cret-pass" }); assert.strictEqual(li.status, 200);
  const sc = li.headers.get("set-cookie"); assert.ok(/HttpOnly/i.test(sc) && /SameSite=Strict/i.test(sc)); cookie = sc.split(";")[0];

  const page = await get("/"); assert.strictEqual(page.status, 200); assert.ok(page.text.includes("Pending rewards")); assert.ok(!page.text.includes("test-admin-key"), "the key never reaches the browser");
  let list = JSON.parse((await get("/api/pending")).text).pending;
  assert.strictEqual(list.length, 2); assert.ok(list.some((c) => c.email === "b@gmail.com" && c.link.startsWith("https://www.instagram.com/")));

  // approve "now" reward: the Free user's plan restarts today (3 days = through 2026-10-26, so expiry 2026-10-27)
  let r = await post("/api/decide", { email: "a@gmail.com", reward: "review", approve: true }); assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual((await cols.users.findOne({ email: "a@gmail.com" })).expiry_date, "2026-10-27");
  // approve "next_premium" reward: days are saved as bonus_days, the plan itself is unchanged
  r = await post("/api/decide", { email: "b@gmail.com", reward: "instagram", approve: true }); assert.strictEqual(r.status, 200, r.text);
  const b = await cols.users.findOne({ email: "b@gmail.com" }); assert.strictEqual(b.bonus_days, 7); assert.strictEqual(b.expiry_date, "2026-10-30");
  assert.strictEqual(JSON.parse((await get("/api/pending")).text).pending.length, 0, "nothing pending any more");
  // deciding twice changes nothing and says so
  r = await post("/api/decide", { email: "b@gmail.com", reward: "instagram", approve: true }); assert.strictEqual(r.status, 409); assert.strictEqual(JSON.parse(r.text).reason, "ALREADY_DECIDED");
  assert.strictEqual((await cols.users.findOne({ email: "b@gmail.com" })).bonus_days, 7);
  // reject: no days, claim closed
  await cols.rewards.insertOne({ key: ub._id + ":review", user_id: ub._id, email: ub.email, reward: "review", days: 3, apply: "now", status: "pending", created: new Date(), proof: "Bo" });
  r = await post("/api/decide", { email: "b@gmail.com", reward: "review", approve: false }); assert.strictEqual(r.status, 200);
  assert.strictEqual((await cols.rewards.findOne({ key: ub._id + ":review" })).status, "rejected"); assert.strictEqual((await cols.users.findOne({ email: "b@gmail.com" })).expiry_date, "2026-10-30");
  // bad input and unknown claim
  assert.strictEqual((await post("/api/decide", { email: "b@gmail.com", reward: "review", approve: "yes" })).status, 400);
  assert.strictEqual((await post("/api/decide", { email: "nobody@gmail.com", reward: "review", approve: true })).status, 404);

  // local-only protections: a foreign Host header, and a POST that is not JSON (what a cross-site form would send)
  const evil = await new Promise((res) => require("http").get({ port: admin.address().port, host: "127.0.0.1", path: "/api/pending", headers: { host: "evil.example" } }, (m) => res(m.statusCode)));
  assert.strictEqual(evil, 403);
  assert.strictEqual((await get("/api/decide", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415);
  // logout closes the session
  await post("/api/logout", {}); assert.strictEqual((await get("/api/pending")).status, 401);
  console.log("admin tests passed"); admin.close(); backend.close(); process.exit(0);
})().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
