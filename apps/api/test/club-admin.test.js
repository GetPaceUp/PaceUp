import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { useTempDatabase, sessionCookie, makeClient } from "./helpers.js";

process.env.PACEUP_SUPERADMIN_EMAIL = "boss@example.com";
const { tempDir } = useTempDatabase();
const { buildApp } = await import("../src/server.js");
const { db } = await import("../src/db.js");
const app = await buildApp({ logger: false, authRateLimit: 1000 });
const { call, registerOwner, invite } = makeClient(app);

test("club admins can manage their club and invite a member without crossing tenant boundaries", async () => {
  const owner = await registerOwner("Club Owner", "owner@example.com", "First Club");
  const { clubId, cookie: ownerCookie } = owner;

  assert.equal((await call("GET", `/api/clubs/${clubId}/members`)).statusCode, 401);

  // The Club Owner renames the club; so can the PaceUp Admin, even for a club they're not in.
  const renamed = await call("PATCH", `/api/clubs/${clubId}`, { cookie: ownerCookie, payload: { name: "First Club Community" } });
  assert.equal(renamed.statusCode, 200);
  assert.equal(renamed.json().club.name, "First Club Community");
  const boss = await registerOwner("Boss", "boss@example.com", "Boss Club");
  assert.equal((await call("PATCH", `/api/clubs/${clubId}`, { cookie: boss.cookie, payload: { name: "First Club Community" } })).statusCode, 200);

  const token = await invite(ownerCookie, clubId, "member@example.com");

  // Registering through an invitation creates the account and joins the club in one step.
  const memberRegistration = await call("POST", "/api/auth/register", {
    payload: { name: "New Member", email: "member@example.com", password: "another-strong-password", inviteToken: token }
  });
  assert.equal(memberRegistration.statusCode, 201);
  assert.ok(memberRegistration.json().clubs.some((club) => club.id === clubId && club.role === "member"));
  const memberCookie = sessionCookie(memberRegistration);

  // The link is spent: accepting it again is refused.
  const replay = await call("POST", "/api/invitations/accept", { cookie: memberCookie, payload: { token } });
  assert.equal(replay.statusCode, 410);

  const members = await call("GET", `/api/clubs/${clubId}/members`, { cookie: ownerCookie });
  assert.equal(members.statusCode, 200);
  assert.equal(members.json().members.length, 2);

  const forbiddenRename = await call("PATCH", `/api/clubs/${clubId}`, { cookie: memberCookie, payload: { name: "Attempted Takeover" } });
  assert.equal(forbiddenRename.statusCode, 404);
});

test("invitation role defaults to member, never admin", async () => {
  const owner = await registerOwner("Default Owner", "default-owner@example.com", "Default Club");
  const res = await call("POST", `/api/clubs/${owner.clubId}/invitations`, { cookie: owner.cookie, payload: { email: "someone@example.com" } });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().invitation.role, "member");
});

test("users cannot read or change another club's data", async () => {
  const a = await registerOwner("Owner A", "a@example.com", "Club A");
  const b = await registerOwner("Owner B", "b@example.com", "Club B");
  const memberToken = await invite(a.cookie, a.clubId, "a-member@example.com");
  const member = await call("POST", "/api/auth/register", {
    payload: { name: "A Member", email: "a-member@example.com", password: "strong-password-123", inviteToken: memberToken }
  });
  const memberCookie = sessionCookie(member);

  for (const [method, url, payload] of [
    ["GET", `/api/clubs/${a.clubId}/members`],
    ["GET", `/api/clubs/${a.clubId}/invitations`],
    ["PATCH", `/api/clubs/${a.clubId}`, { name: "Hijacked" }],
    ["POST", `/api/clubs/${a.clubId}/invitations`, { email: "spy@example.com", role: "admin" }]
  ]) {
    assert.equal((await call(method, url, { cookie: b.cookie, payload })).statusCode, 404, `owner of B: ${method} ${url}`);
    assert.equal((await call(method, url, { cookie: memberCookie, payload })).statusCode, 404, `plain member of A: ${method} ${url}`);
  }
  // B's members list does not include anyone from A.
  const bMembers = (await call("GET", `/api/clubs/${b.clubId}/members`, { cookie: b.cookie })).json().members;
  assert.deepEqual(bMembers.map((m) => m.email), ["b@example.com"]);
  // A's invitation cannot be used to join by someone else, even the owner of B.
  const aToken = await invite(a.cookie, a.clubId, "invitee@example.com");
  assert.equal((await call("POST", "/api/invitations/accept", { cookie: b.cookie, payload: { token: aToken } })).statusCode, 403);
  // Malformed ids are treated as not found.
  assert.equal((await call("GET", "/api/clubs/not-a-real-id/members", { cookie: a.cookie })).statusCode, 404);
  assert.equal(db.prepare("SELECT name FROM clubs WHERE id = ?").get(a.clubId).name, "Club A");
});

test("expired invitations cannot be used to accept or register", async () => {
  const owner = await registerOwner("Expiry Owner", "expiry-owner@example.com", "Expiry Club");
  const token = await invite(owner.cookie, owner.clubId, "late@example.com");
  db.prepare("UPDATE club_invitations SET expires_at = ? WHERE email = ?").run(new Date(Date.now() - 1000).toISOString(), "late@example.com");

  const register = await call("POST", "/api/auth/register", {
    payload: { name: "Late Person", email: "late@example.com", password: "strong-password-123", inviteToken: token }
  });
  assert.equal(register.statusCode, 410);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'late@example.com'").get().n, 0, "no orphan account");
});

test("simultaneous acceptance of one invitation succeeds exactly once", async () => {
  const owner = await registerOwner("Race Owner", "race-owner@example.com", "Race Club");
  const invitee = await registerOwner("Racer", "racer@example.com", "Racer Own Club");
  const token = await invite(owner.cookie, owner.clubId, "racer@example.com");
  const results = await Promise.all(Array.from({ length: 8 }, () => call("POST", "/api/invitations/accept", { cookie: invitee.cookie, payload: { token } })));
  const codes = results.map((r) => r.statusCode).sort();
  assert.equal(codes.filter((c) => c === 200).length, 1, `codes: ${codes}`);
  assert.ok(codes.filter((c) => c !== 200).every((c) => c === 410));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM club_memberships WHERE club_id = ? AND user_id = ?").get(owner.clubId, invitee.user.id).n, 1);
});

test("signing out ends the session server-side", async () => {
  const owner = await registerOwner("Session Owner", "session@example.com", "Session Club");
  assert.equal((await call("GET", "/api/auth/me", { cookie: owner.cookie })).statusCode, 200);
  await call("POST", "/api/auth/logout", { cookie: owner.cookie });
  assert.equal((await call("GET", "/api/auth/me", { cookie: owner.cookie })).statusCode, 401, "old cookie no longer works");

  const login = () => call("POST", "/api/auth/login", { payload: { email: "session@example.com", password: "strong-password-123" } });
  const phone = sessionCookie(await login());
  const laptop = sessionCookie(await login());
  assert.equal((await call("POST", "/api/auth/logout-all", { cookie: phone })).json().sessionsEnded, 2);
  assert.equal((await call("GET", "/api/auth/me", { cookie: laptop })).statusCode, 401);
});

test("cross-site writes are refused, same-site writes allowed", async () => {
  const owner = await registerOwner("Origin Owner", "origin@example.com", "Origin Club");
  const boss = await call("POST", "/api/auth/login", { payload: { email: "boss@example.com", password: "strong-password-123" } });
  const bossCookie = sessionCookie(boss);
  const evil = await call("PATCH", `/api/clubs/${owner.clubId}`, { cookie: bossCookie, payload: { name: "Pwned" }, headers: { origin: "https://evil.example" } });
  assert.equal(evil.statusCode, 403);
  const ok = await call("PATCH", `/api/clubs/${owner.clubId}`, { cookie: bossCookie, payload: { name: "Origin Club 2" }, headers: { origin: "http://localhost:5173" } });
  assert.equal(ok.statusCode, 200);
});

test("security headers are set", async () => {
  const res = await call("GET", "/health");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.ok(res.headers["content-security-policy"]);
  assert.equal(res.headers["x-frame-options"], "SAMEORIGIN");
});

test("invalid bodies are rejected with a clean 400", async () => {
  const res = await call("POST", "/api/auth/register", { payload: { name: "X".repeat(500), email: "x@example.com", password: "strong-password-123", clubName: "Club" } });
  assert.equal(res.statusCode, 400);
  assert.ok(res.json().error);
});

test.after(async () => {
  await app.close();
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});
