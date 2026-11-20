import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { useTempDatabase, sessionCookie, makeClient } from "./helpers.js";

const { tempDir } = useTempDatabase();
process.env.PACEUP_SUPERADMIN_EMAIL = "boss@example.com";
const { buildApp } = await import("../src/server.js");
const { db } = await import("../src/db.js");
const app = await buildApp({ logger: false, authRateLimit: 1000 });
const { call } = makeClient(app);
const register = async (name, email) => {
  const res = await call("POST", "/api/auth/register", { payload: { name, email, password: "strong-password-123", clubName: "Sneaky Club" } });
  assert.equal(res.statusCode, 201, res.body);
  return { cookie: sessionCookie(res), body: res.json() };
};

test.after(async () => { await app.close(); rmSync(tempDir, { recursive: true, force: true }); });

test("signing up never creates a club", async () => {
  const someone = await register("Some One", "some@example.com");
  assert.deepEqual(someone.body.clubs, []);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM clubs").get().n, 0);
});

test("only the platform owner creates clubs, naming the first admin by mobile number", async () => {
  const someone = (await call("POST", "/api/auth/login", { payload: { email: "some@example.com", password: "strong-password-123" } }));
  assert.equal((await call("POST", "/api/platform/clubs", { cookie: sessionCookie(someone), payload: { name: "Nope Club" } })).statusCode, 403);

  const boss = await register("Boss", "boss@example.com");
  const missingName = await call("POST", "/api/platform/clubs", { cookie: boss.cookie, payload: { name: "Sunrise Riders", adminPhone: "98111 22233" } });
  assert.equal(missingName.statusCode, 400, "a new number needs a name");
  const res = await call("POST", "/api/platform/clubs", { cookie: boss.cookie, payload: { name: "Sunrise Riders", adminPhone: "98111 22233", adminName: "kavya rao" } });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().owner.name, "Kavya Rao");
  assert.equal(res.json().owner.phone, "919811122233");
  assert.equal((await call("POST", "/api/platform/clubs", { cookie: boss.cookie, payload: { name: "sunrise riders" } })).statusCode, 409);

  // Without a number, the platform owner owns it.
  const own = await call("POST", "/api/platform/clubs", { cookie: boss.cookie, payload: { name: "Boss Club" } });
  assert.equal(own.statusCode, 201);
  const clubs = (await call("GET", "/api/auth/me", { cookie: boss.cookie })).json().clubs;
  assert.deepEqual(clubs.map((c) => [c.name, c.role]), [["Boss Club", "owner"]]);

  // The owner adds another admin by number; an existing account is reused, not duplicated.
  const clubId = own.json().club.id;
  const added = await call("POST", `/api/clubs/${clubId}/admins`, { cookie: boss.cookie, payload: { phone: "+91 98111 22233" } });
  assert.equal(added.statusCode, 201, added.body);
  assert.equal(added.json().admin.name, "Kavya Rao");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE phone = '919811122233'").get().n, 1);
  assert.equal(db.prepare("SELECT role FROM club_memberships WHERE club_id = ? AND user_id = ?").get(clubId, added.json().admin.id).role, "admin");
  // Members can't add admins.
  assert.equal((await call("POST", `/api/clubs/${clubId}/admins`, { cookie: sessionCookie(someone), payload: { phone: "9811100000", name: "X Y" } })).statusCode, 404);
});

test("invites go by mobile number: added at once and WhatsApped from the club number", async () => {
  const boss = (await call("POST", "/api/auth/login", { payload: { email: "boss@example.com", password: "strong-password-123" } }));
  const cookie = sessionCookie(boss);
  const clubId = db.prepare("SELECT id FROM clubs WHERE name = 'Boss Club'").get().id;
  // WhatsApp not connected: the person is still added; the page gets the text to share by hand.
  const first = await call("POST", `/api/clubs/${clubId}/people`, { cookie, payload: { phone: "98765 11111", name: "neha joshi", role: "member" } });
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(first.json().whatsapp.sent, false);
  assert.match(first.json().whatsapp.text, /Hi Neha! Boss added you to \*Boss Club\* on PaceUp as a member/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM whatsapp_direct").get().n, 0);

  db.prepare("INSERT INTO whatsapp_connections (club_id, desired, status, updated_at, last_seen_at) VALUES (?, 'on', 'connected', ?, ?)").run(clubId, new Date().toISOString(), new Date().toISOString());
  const admin = await call("POST", `/api/clubs/${clubId}/people`, { cookie, payload: { phone: "+91 98765 22222", name: "Ravi Menon", role: "admin" } });
  assert.equal(admin.json().whatsapp.sent, true);
  const dm = db.prepare("SELECT * FROM whatsapp_direct WHERE to_phone = '919876522222'").get();
  assert.equal(dm.club_id, clubId, "sent from this club's number");
  assert.match(dm.text, /as a club admin/);
  assert.match(dm.text, /Sign in with this mobile number/);

  // The invited person signs in with a code to that number and lands in the club.
  const neha = first.json().person.id;
  assert.equal((await call("POST", `/api/clubs/${clubId}/members/${neha}/welcome`, { cookie })).json().whatsapp.sent, true, "resend");
  assert.equal((await call("DELETE", `/api/clubs/${clubId}/members/${neha}`, { cookie })).statusCode, 200, "remove");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM club_memberships WHERE club_id = ? AND user_id = ?").get(clubId, neha).n, 0);
  const bossId = db.prepare("SELECT id FROM users WHERE email = 'boss@example.com'").get().id;
  assert.equal((await call("DELETE", `/api/clubs/${clubId}/members/${bossId}`, { cookie })).statusCode, 409, "owner stays");
});

test("an invited number later added to an existing email account joins that account, not a duplicate", async () => {
  const { attachPhone } = await import("../src/otp.js");
  const clubId = db.prepare("SELECT id FROM clubs WHERE name = 'Boss Club'").get().id;
  const boss = sessionCookie(await call("POST", "/api/auth/login", { payload: { email: "boss@example.com", password: "strong-password-123" } }));
  const invited = await call("POST", `/api/clubs/${clubId}/people`, { cookie: boss, payload: { phone: "98765 33333", name: "Some One", role: "admin" } });
  const placeholder = invited.json().person.id;
  const someone = db.prepare("SELECT id FROM users WHERE email = 'some@example.com'").get().id;
  // The person proves the number from their email account.
  const code = "123456";
  const { createHash, randomUUID } = await import("node:crypto");
  db.prepare("INSERT INTO login_codes (id, phone, code_hash, purpose, user_id, expires_at, created_at) VALUES (?, '919876533333', ?, 'attach', ?, ?, ?)")
    .run(randomUUID(), createHash("sha256").update(`${process.env.APP_SECRET}:otp:919876533333:${code}`).digest("hex"), someone, new Date(Date.now() + 60000).toISOString(), new Date().toISOString());
  const user = attachPhone(someone, "919876533333", code);
  assert.equal(user.phone, "919876533333");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE id = ?").get(placeholder).n, 0, "the phone-only duplicate is gone");
  assert.equal(db.prepare("SELECT role FROM club_memberships WHERE club_id = ? AND user_id = ?").get(clubId, someone).role, "admin", "its club role moved over");
});
