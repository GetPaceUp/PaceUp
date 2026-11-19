import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { useTempDatabase, sessionCookie, makeClient } from "./helpers.js";

const { tempDir } = useTempDatabase();
const { buildApp } = await import("../src/server.js");
const { db } = await import("../src/db.js");
const app = await buildApp({ logger: false, authRateLimit: 1000 });
const { call, registerOwner, invite } = makeClient(app);

async function joinAs(owner, name, email, role = "member") {
  const res = await call("POST", `/api/clubs/${owner.clubId}/invitations`, { cookie: owner.cookie, payload: { email, role } });
  const token = new URL(res.json().invitation.inviteUrl).pathname.split("/").at(-1);
  const reg = await call("POST", "/api/auth/register", { payload: { name, email, password: "original-password-1", inviteToken: token } });
  return { cookie: sessionCookie(reg), user: reg.json().user };
}
const tokenOf = (res) => new URL(res.json().resetUrl).pathname.split("/").at(-1);
const login = (email, password) => call("POST", "/api/auth/login", { payload: { email, password } });

const owner = await registerOwner("Priya Sharma", "priya@example.com", "Club A");
const member = await joinAs(owner, "Arjun Rao", "arjun@example.com");
const coAdmin = await joinAs(owner, "Meera Iyer", "meera@example.com", "admin");
const other = await registerOwner("Other Owner", "other@example.com", "Club B");
const reset = (actor, club, target) => call("POST", `/api/clubs/${club.clubId}/members/${target.user.id}/password-reset`, { cookie: actor.cookie });

test("a club admin resets a member: link works once, sets the password, ends old sessions", async () => {
  const created = await reset(owner, owner, member);
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().name, "Arjun Rao");
  const token = tokenOf(created);

  const check = await call("GET", `/api/password-reset/${token}`);
  assert.equal(check.statusCode, 200);
  assert.equal(check.json().email, "ar•••@example.com");

  assert.equal((await call("POST", "/api/password-reset", { payload: { token, password: "short" } })).statusCode, 400);
  const done = await call("POST", "/api/password-reset", { payload: { token, password: "brand-new-password-2" } });
  assert.equal(done.statusCode, 200);
  assert.equal(done.json().user.email, "arjun@example.com");
  assert.equal((await call("GET", "/api/auth/me", { cookie: sessionCookie(done) })).statusCode, 200, "signed in on this device");

  assert.equal((await call("GET", "/api/auth/me", { cookie: member.cookie })).statusCode, 401, "old sessions ended");
  assert.equal((await login("arjun@example.com", "original-password-1")).statusCode, 401);
  assert.equal((await login("arjun@example.com", "brand-new-password-2")).statusCode, 200);

  assert.equal((await call("POST", "/api/password-reset", { payload: { token, password: "another-password-3" } })).statusCode, 410, "single use");
  assert.equal((await call("GET", `/api/password-reset/${token}`)).statusCode, 410);
});

test("expired links and superseded links don't work", async () => {
  const first = tokenOf(await reset(owner, owner, member));
  const second = tokenOf(await reset(owner, owner, member));
  assert.equal((await call("GET", `/api/password-reset/${first}`)).statusCode, 410, "only the newest link works");
  db.prepare("UPDATE password_resets SET expires_at = ? WHERE used_at IS NULL").run(new Date(Date.now() - 1000).toISOString());
  assert.equal((await call("POST", "/api/password-reset", { payload: { token: second, password: "brand-new-password-9" } })).statusCode, 410);
});

test("admins can't take over admins, owners, other clubs' members or themselves", async () => {
  assert.equal((await reset(coAdmin, owner, owner)).statusCode, 403, "admin can't reset the owner");
  assert.equal((await reset(owner, owner, coAdmin)).statusCode, 403, "owner can't reset another admin");
  assert.equal((await reset(other, other, member)).statusCode, 404, "other club's owner can't reset our member");
  assert.equal((await reset(other, owner, member)).statusCode, 404, "can't use someone else's club id");
  const memberNow = { ...member, cookie: sessionCookie(await login("arjun@example.com", "brand-new-password-2")) };
  assert.equal((await reset(memberNow, owner, coAdmin)).statusCode, 404, "plain members can't create links");
  assert.equal((await reset(owner, owner, owner)).statusCode, 400);
  assert.equal((await call("POST", `/api/platform/users/${member.user.id}/password-reset`, { cookie: owner.cookie })).statusCode, 403);
});

test("the Super Admin can reset anyone, including club owners, and it is audited", async () => {
  db.prepare("UPDATE users SET platform_role = 'super_admin' WHERE id = ?").run(owner.user.id);
  const res = await call("POST", `/api/platform/users/${other.user.id}/password-reset`, { cookie: owner.cookie });
  assert.equal(res.statusCode, 201);
  const done = await call("POST", "/api/password-reset", { payload: { token: tokenOf(res), password: "owner-new-password-4" } });
  assert.equal(done.statusCode, 200);
  const actions = db.prepare("SELECT action FROM platform_audit_log ORDER BY created_at").all().map((r) => r.action);
  assert.ok(actions.includes("password_reset.created") && actions.includes("password_reset.used"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM platform_audit_log WHERE action LIKE 'password_reset%' AND (new_value IS NOT NULL OR old_value IS NOT NULL)").get().n, 0, "no secrets stored in the audit log");
});

test.after(async () => { await app.close(); db.close(); rmSync(tempDir, { recursive: true, force: true }); });
