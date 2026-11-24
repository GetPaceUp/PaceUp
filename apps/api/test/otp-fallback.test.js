import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { useTempDatabase, makeClient } from "./helpers.js";

const { tempDir } = useTempDatabase();
const { buildApp } = await import("../src/server.js");
const { db } = await import("../src/db.js");
const app = await buildApp({ logger: false, authRateLimit: 1000 });
const { call, registerOwner } = makeClient(app);

const start = (phone) => call("POST", "/api/auth/otp/start", { payload: { phone } });
const allowResend = () => db.prepare("UPDATE login_codes SET created_at = ?").run(new Date(Date.now() - 20 * 60 * 1000).toISOString());
const sender = (phone) => db.prepare("SELECT club_id FROM whatsapp_direct WHERE to_phone = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(phone)?.club_id;
const link = (clubId, phone) => db.prepare("INSERT OR REPLACE INTO whatsapp_connections (club_id, desired, status, phone, last_seen_at, updated_at) VALUES (?, 'on', 'connected', ?, ?, ?)").run(clubId, phone, new Date().toISOString(), new Date().toISOString());

const boss = await registerOwner("Boss Owner", "boss@example.com", "House Club");
db.prepare("UPDATE users SET platform_role = 'super_admin', phone = '919811991181' WHERE id = ?").run(boss.user.id);
const other = await registerOwner("Raghu", "raghu@example.com", "Gurgaon Cyclists");
link(other.clubId, "919910041077");

test("no PaceUp Admin number linked: a new person still can't get a code, and no other club's number is used", async () => {
  const res = await start("9886279463");
  assert.equal(res.statusCode, 503);
  assert.equal(sender("919886279463"), undefined);
});

test("someone in no club gets their sign-in code from the PaceUp Admin's number", async () => {
  link(boss.clubId, "919811991191");
  const res = await start("9886279463");
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(sender("919886279463"), boss.clubId);
  assert.equal(db.prepare("SELECT sent_via FROM login_codes WHERE phone = '919886279463'").get().sent_via, "paceup");
  // ...and can finish signing up with it.
  const code = db.prepare("SELECT text FROM whatsapp_direct WHERE to_phone = '919886279463'").get().text.match(/\*(\d{6})\*/)[1];
  const done = await call("POST", "/api/auth/otp/verify", { payload: { phone: "9886279463", code, name: "New Person" } });
  assert.equal(done.statusCode, 201, done.body);
});

test("a club's own number still comes first", async () => {
  db.prepare("INSERT INTO club_roster (id, club_id, name, name_key, phone, source, created_at, updated_at) VALUES ('r1', ?, 'Kiran Rao', 'kiran rao', '919700000001', 'whatsapp', ?, ?)").run(other.clubId, new Date().toISOString(), new Date().toISOString());
  assert.equal((await start("9700000001")).statusCode, 200);
  assert.equal(sender("919700000001"), other.clubId);
  assert.equal(db.prepare("SELECT sent_via FROM login_codes WHERE phone = '919700000001'").get().sent_via, "club");
});

test("password reset never uses the PaceUp Admin's number", async () => {
  await call("POST", "/api/auth/password-reset/start", { payload: { phone: "9555500001" } });
  assert.equal(sender("919555500001"), undefined);
});

test("the PaceUp Admin's number sends at most 3 codes a day to one number", async () => {
  for (let i = 0; i < 2; i += 1) { allowResend(); assert.equal((await start("9886279463")).statusCode, 200); }
  allowResend();
  const res = await start("9886279463");
  assert.equal(res.statusCode, 429);
  assert.match(res.json().error, /try again in an hour/);
});

test("the PaceUp Admin's number has an hourly and a daily cap across everyone", async () => {
  process.env.SIGNIN_FALLBACK_PER_HOUR = "2";
  db.prepare("DELETE FROM login_codes").run();
  assert.equal((await start("9600000001")).statusCode, 200);
  assert.equal((await start("9600000002")).statusCode, 200);
  assert.equal((await start("9600000003")).statusCode, 429);
  delete process.env.SIGNIN_FALLBACK_PER_HOUR;
  process.env.SIGNIN_FALLBACK_PER_DAY = "2";
  allowResend();
  assert.equal((await start("9600000004")).statusCode, 429);
  delete process.env.SIGNIN_FALLBACK_PER_DAY;
  // People whose own club number can send are never held by these caps.
  allowResend();
  process.env.SIGNIN_FALLBACK_PER_DAY = "1";
  assert.equal((await start("9700000001")).statusCode, 200);
  delete process.env.SIGNIN_FALLBACK_PER_DAY;
});

test.after(async () => { await app.close(); db.close(); rmSync(tempDir, { recursive: true, force: true }); });
