import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "paceup-api-"));
process.env.DATABASE_URL = `file:${join(tempDir, "test.sqlite")}`;
process.env.APP_SECRET = "test-secret-that-is-long-enough-for-automated-tests";
process.env.APP_BASE_URL = "http://localhost:5173";

const { buildApp } = await import("../src/server.js");
const { db } = await import("../src/db.js");
const app = await buildApp({ logger: false });

function sessionCookie(response) {
  const value = response.headers["set-cookie"];
  const cookie = Array.isArray(value) ? value[0] : value;
  return cookie.split(";")[0];
}

test("club admins can manage their club and invite a member without crossing tenant boundaries", async () => {
  const ownerRegistration = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { name: "Club Owner", email: "owner@example.com", password: "strong-password-123", clubName: "First Club" }
  });
  assert.equal(ownerRegistration.statusCode, 201);
  const ownerCookie = sessionCookie(ownerRegistration);
  const ownerData = ownerRegistration.json();
  const clubId = ownerData.clubs[0].id;
  assert.equal(ownerData.clubs[0].role, "owner");

  const unauthenticated = await app.inject({ method: "GET", url: `/api/clubs/${clubId}/members` });
  assert.equal(unauthenticated.statusCode, 401);

  const renamed = await app.inject({
    method: "PATCH", url: `/api/clubs/${clubId}`, headers: { cookie: ownerCookie },
    payload: { name: "First Club Community" }
  });
  assert.equal(renamed.statusCode, 200);
  assert.equal(renamed.json().club.name, "First Club Community");

  const invite = await app.inject({
    method: "POST", url: `/api/clubs/${clubId}/invitations`, headers: { cookie: ownerCookie },
    payload: { email: "member@example.com", role: "member" }
  });
  assert.equal(invite.statusCode, 201);
  const inviteUrl = new URL(invite.json().invitation.inviteUrl);
  const token = inviteUrl.pathname.split("/").at(-1);

  const memberRegistration = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { name: "New Member", email: "member@example.com", password: "another-strong-password", inviteToken: token }
  });
  assert.equal(memberRegistration.statusCode, 201);
  assert.equal(memberRegistration.json().clubs.length, 0);
  const memberCookie = sessionCookie(memberRegistration);

  const accepted = await app.inject({
    method: "POST", url: "/api/invitations/accept", headers: { cookie: memberCookie },
    payload: { token }
  });
  assert.equal(accepted.statusCode, 200);
  assert.ok(accepted.json().clubs.some((club) => club.id === clubId && club.role === "member"));

  const members = await app.inject({
    method: "GET", url: `/api/clubs/${clubId}/members`, headers: { cookie: ownerCookie }
  });
  assert.equal(members.statusCode, 200);
  assert.equal(members.json().members.length, 2);

  const forbiddenRename = await app.inject({
    method: "PATCH", url: `/api/clubs/${clubId}`, headers: { cookie: memberCookie },
    payload: { name: "Attempted Takeover" }
  });
  assert.equal(forbiddenRename.statusCode, 404);

  const wrongAccountInvite = await app.inject({
    method: "POST", url: "/api/invitations/accept", headers: { cookie: ownerCookie },
    payload: { token }
  });
  assert.equal(wrongAccountInvite.statusCode, 410);
});

test.after(async () => {
  await app.close();
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});
