import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { Writable } from "node:stream";
import { useTempDatabase, sessionCookie, makeClient } from "./helpers.js";

const { tempDir } = useTempDatabase();
const { buildApp } = await import("../src/server.js");
const { db, changePlatformRole } = await import("../src/db.js");
const app = await buildApp({ logger: false, authRateLimit: 1000 });
const { call, registerOwner } = makeClient(app);

const alice = await registerOwner("Alice Admin", "alice@example.com", "Alice Club");
const bob = await registerOwner("Bob User", "bob@example.com", "Bob Club");
db.prepare("UPDATE users SET platform_role = 'super_admin' WHERE id = ?").run(alice.user.id);
const role = (cookie, userId, value) => call("PATCH", `/api/platform/users/${userId}/role`, { cookie, payload: { role: value } });

test("non-admins cannot reach any platform endpoint", async () => {
  assert.equal((await call("GET", "/api/platform/overview")).statusCode, 401);
  assert.equal((await call("GET", "/api/platform/overview", { cookie: bob.cookie })).statusCode, 403);
  assert.equal((await call("GET", "/api/platform/audit", { cookie: bob.cookie })).statusCode, 403);
  assert.equal((await role(bob.cookie, bob.user.id, "super_admin")).statusCode, 403, "cannot self-promote");
  assert.equal((await call("GET", "/api/platform/overview", { cookie: alice.cookie })).statusCode, 200);
});

test("promotion and demotion are audited, and the last Super Admin is protected", async () => {
  assert.equal((await role(alice.cookie, alice.user.id, "user")).statusCode, 400, "cannot remove own access");
  assert.throws(() => changePlatformRole({ actorUserId: alice.user.id, targetUserId: alice.user.id, role: "user" }), /at least one Super Admin/);

  const promoted = await role(alice.cookie, bob.user.id, "super_admin");
  assert.equal(promoted.statusCode, 200);
  assert.equal(promoted.json().user.platform_role, "super_admin");

  const demoted = await role(bob.cookie, alice.user.id, "user");
  assert.equal(demoted.statusCode, 200);
  // Alice lost access immediately and cannot act on the change she might have had in flight.
  assert.equal((await role(alice.cookie, bob.user.id, "user")).statusCode, 403);
  assert.equal((await call("GET", "/api/platform/overview", { cookie: alice.cookie })).statusCode, 403);
  // Bob is now the only one left and cannot be demoted by anyone.
  assert.throws(() => changePlatformRole({ actorUserId: bob.user.id, targetUserId: bob.user.id, role: "user" }), /at least one Super Admin/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE platform_role = 'super_admin'").get().n, 1);

  const audit = (await call("GET", "/api/platform/audit", { cookie: bob.cookie })).json().entries;
  assert.deepEqual(audit.map((e) => [e.action, e.actor_email, e.target_email]), [
    ["platform_role.demote", "bob@example.com", "alice@example.com"],
    ["platform_role.promote", "alice@example.com", "bob@example.com"]
  ]);
});

test("login and registration are rate limited per client", async () => {
  const limited = await buildApp({ logger: false, authRateLimit: 3 });
  const attempt = () => limited.inject({ method: "POST", url: "/api/auth/login", payload: { email: "nobody@example.com", password: "wrong-password" } });
  for (let i = 0; i < 3; i++) assert.equal((await attempt()).statusCode, 401);
  const blocked = await attempt();
  assert.equal(blocked.statusCode, 429);
  assert.match(blocked.json().error, /Too many attempts/);
  // A different client address behind the proxy has its own allowance.
  const other = await limited.inject({ method: "POST", url: "/api/auth/login", headers: { "x-forwarded-for": "203.0.113.9" }, payload: { email: "nobody@example.com", password: "wrong-password" } });
  assert.equal(other.statusCode, 401);
  await limited.close();
});

test("passwords, cookies and invitation tokens never appear in logs", async () => {
  let output = "";
  const stream = new Writable({ write(chunk, _enc, cb) { output += chunk; cb(); } });
  const logged = await buildApp({ authRateLimit: 1000, logLevel: "trace", logStream: stream });
  const password = "very-secret-password-42";
  const reg = await logged.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Log Owner", email: "log@example.com", password } });
  const cookie = sessionCookie(reg);
  const { createClub } = await import("../src/clubs-admin.js");
  const logClub = createClub({ name: "Log Club", actorId: reg.json().user.id }).club;
  const invite = await logged.inject({ method: "POST", url: `/api/clubs/${logClub.id}/invitations`, headers: { cookie }, payload: { email: "logged@example.com" } });
  const token = new URL(invite.json().invitation.inviteUrl).pathname.split("/").at(-1);
  await logged.inject({ method: "POST", url: "/api/invitations/accept", headers: { cookie }, payload: { token } });
  await logged.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
  const member = await logged.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Logged Member", email: "logged@example.com", password: "member-password-42", inviteToken: token } });
  const resetRes = await logged.inject({ method: "POST", url: `/api/clubs/${logClub.id}/members/${member.json().user.id}/password-reset`, headers: { cookie } });
  const resetToken = new URL(resetRes.json().resetUrl).pathname.split("/").at(-1);
  assert.equal((await logged.inject({ method: "POST", url: "/api/password-reset/check", payload: { token: resetToken } })).statusCode, 200);
  await logged.close();
  assert.ok(!output.includes(resetToken), "reset token is not logged");
  assert.ok(output.length > 0, "logger produced output");
  for (const secret of [password, cookie.split("=")[1], token]) assert.ok(!output.includes(secret), "secret leaked into logs");
});

test.after(async () => {
  await app.close();
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});
