import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Points the API at a fresh temporary SQLite file. Call before importing src/. */
export function useTempDatabase() {
  const tempDir = mkdtempSync(join(tmpdir(), "paceup-api-"));
  const file = join(tempDir, "test.sqlite");
  process.env.DATABASE_URL = `file:${file}`;
  process.env.APP_SECRET = "test-secret-that-is-long-enough-for-automated-tests";
  process.env.APP_BASE_URL = "http://localhost:5173";
  return { tempDir, file };
}

export function sessionCookie(response) {
  const value = response.headers["set-cookie"];
  const cookie = Array.isArray(value) ? value[0] : value;
  return cookie.split(";")[0];
}

export function makeClient(app) {
  async function call(method, url, { cookie, payload, headers = {} } = {}) {
    return app.inject({ method, url, payload, headers: { ...(cookie ? { cookie } : {}), ...headers } });
  }
  // Clubs are created by the platform owner; tests create one directly and make this person its owner.
  async function registerOwner(name, email, clubName) {
    const res = await call("POST", "/api/auth/register", { payload: { name, email, password: "strong-password-123" } });
    if (res.statusCode !== 201) throw new Error(`register failed ${res.statusCode} ${res.body}`);
    const { createClub } = await import("../src/clubs-admin.js");
    const { club } = createClub({ name: clubName, actorId: res.json().user.id });
    return { cookie: sessionCookie(res), user: res.json().user, clubId: club.id };
  }
  async function invite(cookie, clubId, email, role = "member") {
    const res = await call("POST", `/api/clubs/${clubId}/invitations`, { cookie, payload: { email, role } });
    if (res.statusCode !== 201) throw new Error(`invite failed ${res.statusCode} ${res.body}`);
    return new URL(res.json().invitation.inviteUrl).pathname.split("/").at(-1);
  }
  return { call, registerOwner, invite };
}
