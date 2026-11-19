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
  const missingName = await call("POST", "/api/platform/clubs", { cookie: boss.cookie, payload: { name: "Folks Riders", adminPhone: "98111 22233" } });
  assert.equal(missingName.statusCode, 400, "a new number needs a name");
  const res = await call("POST", "/api/platform/clubs", { cookie: boss.cookie, payload: { name: "Folks Riders", adminPhone: "98111 22233", adminName: "kavya rao" } });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().owner.name, "Kavya Rao");
  assert.equal(res.json().owner.phone, "919811122233");
  assert.equal((await call("POST", "/api/platform/clubs", { cookie: boss.cookie, payload: { name: "folks riders" } })).statusCode, 409);

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
