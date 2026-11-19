import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { useTempDatabase, sessionCookie, makeClient } from "./helpers.js";

const { tempDir } = useTempDatabase();
const { buildApp } = await import("../src/server.js");
const { db } = await import("../src/db.js");
const app = await buildApp({ logger: false, authRateLimit: 1000 });
const { call, registerOwner, invite } = makeClient(app);

const lastCode = (phone) => db.prepare("SELECT text FROM whatsapp_direct WHERE to_phone = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(phone)?.text.match(/\*(\d{6})\*/)[1];
const allowResend = () => db.prepare("UPDATE login_codes SET created_at = ?").run(new Date(Date.now() - 20 * 60 * 1000).toISOString());
const start = (phone) => call("POST", "/api/auth/otp/start", { payload: { phone } });
const verify = (payload) => call("POST", "/api/auth/otp/verify", { payload });

const owner = await registerOwner("Email Owner", "owner@example.com", "Folks Riders");

test("no connected WhatsApp: a clear error, nothing stored", async () => {
  const res = await start("+91 98765 43210");
  assert.equal(res.statusCode, 503);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM login_codes").get().n, 0);
});

test("sign up with a mobile number: code on WhatsApp and a name. No email, password or club creation.", async () => {
  db.prepare("INSERT INTO whatsapp_connections (club_id, desired, status, updated_at, last_seen_at) VALUES (?, 'on', 'connected', ?, ?)").run(owner.clubId, new Date().toISOString(), new Date().toISOString());
  assert.equal((await start("12")).statusCode, 400);
  const sent = await start("98765 43210");
  assert.equal(sent.statusCode, 200);
  const row = db.prepare("SELECT * FROM whatsapp_direct WHERE to_phone = '919876543210'").get();
  assert.equal(row.club_id, owner.clubId, "sent from the club's number");
  assert.match(row.text, /is your PaceUp code/);
  const code = lastCode("919876543210");
  assert.ok(!db.prepare("SELECT code_hash FROM login_codes").get().code_hash.includes(code), "only a hash is stored");

  assert.equal((await start("98765 43210")).statusCode, 429, "30 s between codes");
  assert.equal((await verify({ phone: "9876543210", code: "000000" === code ? "111111" : "000000" })).statusCode, 400);
  // The club's member list already has this number (from the WhatsApp group).
  db.prepare("INSERT INTO club_roster (id, club_id, name, name_key, phone, source, created_at, updated_at) VALUES ('r1', ?, 'Amit Daga', 'amit daga', '919876543210', 'whatsapp', ?, ?)").run(owner.clubId, new Date().toISOString(), new Date().toISOString());
  const unknown = await verify({ phone: "+91 98765 43210", code });
  assert.deepEqual(unknown.json(), { needs_signup: true, name_hint: "Amit Daga" }, "new number: ask for a name (pre-filled from the club list), code still valid");
  const created = await verify({ phone: "9876543210", code, name: "Amit Daga", clubName: "Pune Pacers" });
  assert.equal(created.statusCode, 201, created.body);
  assert.deepEqual(created.json().user, { id: created.json().user.id, name: "Amit Daga", email: null, phone: "919876543210" });
  assert.deepEqual(created.json().clubs.map((c) => [c.name, c.role]), [["Folks Riders", "member"]], "joins the club whose list has the number; no new club");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM clubs WHERE name = 'Pune Pacers'").get().n, 0);
  const cookie = sessionCookie(created);
  assert.equal((await call("GET", "/api/auth/me", { cookie })).json().user.phone, "919876543210");
  assert.equal((await verify({ phone: "9876543210", code })).statusCode, 400, "a code works once");
  // The placeholder email can't be used to sign in with a password.
  assert.equal((await call("POST", "/api/auth/login", { payload: { email: "919876543210@phone.paceup.invalid", password: "!" } })).statusCode, 401);
});

test("sign in again with a code; wrong codes run out", async () => {
  allowResend();
  await start("+919876543210");
  const code = lastCode("919876543210");
  for (let i = 0; i < 5; i++) await verify({ phone: "9876543210", code: code === "123456" ? "654321" : "123456" });
  assert.equal((await verify({ phone: "9876543210", code })).statusCode, 400, "locked after 5 tries");
  allowResend();
  await start("9876543210");
  const ok = await verify({ phone: "9876543210", code: lastCode("919876543210") });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().user.name, "Amit Daga");
});

test("per-number limits", async () => {
  db.prepare("DELETE FROM login_codes").run();
  const t = (min) => new Date(Date.now() - min * 60000).toISOString();
  for (const m of [1, 5, 10]) db.prepare("INSERT INTO login_codes (id, phone, code_hash, purpose, expires_at, created_at) VALUES (?, '919800000001', 'x', 'login', ?, ?)").run(`l${m}`, t(-5), t(m));
  const res = await start("9800000001");
  assert.equal(res.statusCode, 429);
  assert.match(res.json().error, /15 minutes/);
});

test("an invited person joins with just their phone", async () => {
  const token = await invite(owner.cookie, owner.clubId, "someone@example.com");
  allowResend();
  await start("9811122233");
  const res = await verify({ phone: "9811122233", code: lastCode("919811122233"), name: "Neha Joshi", inviteToken: token });
  assert.equal(res.statusCode, 201, res.body);
  assert.deepEqual(res.json().clubs.map((c) => [c.name, c.role]), [["Folks Riders", "member"]]);
  // Invite links can now be made without an email.
  const noEmail = await call("POST", `/api/clubs/${owner.clubId}/invitations`, { cookie: owner.cookie, payload: { role: "member" } });
  assert.equal(noEmail.statusCode, 201);
});

test("an email account adds its mobile number, then signs in with it", async () => {
  allowResend();
  const s = await call("POST", "/api/auth/phone/start", { cookie: owner.cookie, payload: { phone: "9876543210" } });
  assert.equal(s.statusCode, 409, "number already used by Amit's account");
  const ok = await call("POST", "/api/auth/phone/start", { cookie: owner.cookie, payload: { phone: "9822233344" } });
  assert.equal(ok.statusCode, 200);
  // A login-purpose verify can't use an attach code.
  assert.equal((await verify({ phone: "9822233344", code: lastCode("919822233344") })).statusCode, 400);
  const attached = await call("POST", "/api/auth/phone/verify", { cookie: owner.cookie, payload: { phone: "9822233344", code: lastCode("919822233344") } });
  assert.equal(attached.json().user.phone, "919822233344");
  assert.equal(attached.json().user.email, "owner@example.com");
  allowResend();
  await start("9822233344");
  const signedIn = await verify({ phone: "9822233344", code: lastCode("919822233344") });
  assert.equal(signedIn.json().user.email, "owner@example.com");
});

test.after(async () => { await app.close(); db.close(); rmSync(tempDir, { recursive: true, force: true }); });
