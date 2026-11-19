import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { useTempDatabase, sessionCookie, makeClient } from "./helpers.js";

const { tempDir } = useTempDatabase();
const { buildApp } = await import("../src/server.js");
const { db } = await import("../src/db.js");
const app = await buildApp({ logger: false, authRateLimit: 1000 });
const { call, registerOwner, invite } = makeClient(app);

const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();
async function joinAs(owner, clubId, name, email) {
  const token = await invite(owner.cookie, clubId, email);
  const res = await call("POST", "/api/auth/register", { payload: { name, email, password: "strong-password-123", inviteToken: token } });
  assert.equal(res.statusCode, 201);
  return { cookie: sessionCookie(res), user: res.json().user };
}

const owner = await registerOwner("Priya Sharma", "priya@example.com", "Sunrise Riders");
const clubId = owner.clubId;
const arjun = await joinAs(owner, clubId, "Arjun Rao", "arjun@example.com");
const meera = await joinAs(owner, clubId, "Meera Iyer", "meera@example.com");
const outsider = await registerOwner("Other Owner", "other@example.com", "Other Club");

const rideBody = { title: "Nandi Hills long ride", starts_at: inDays(3), meeting_point: "Hebbal flyover", distance_km: 62, pace: "24-26 km/h", capacity: 2, notes: "Lights mandatory" };

test("ride lifecycle: draft, publish, edit, cancel", async () => {
  const created = await call("POST", `/api/clubs/${clubId}/rides`, { cookie: owner.cookie, payload: rideBody });
  assert.equal(created.statusCode, 201);
  const { code, id } = created.json().ride;
  assert.equal(created.json().ride.status, "draft");

  assert.equal((await call("GET", `/api/r/${code}`, { cookie: arjun.cookie })).statusCode, 404, "members can't see drafts");
  assert.equal((await call("GET", `/api/clubs/${clubId}/rides`, { cookie: arjun.cookie })).json().rides.length, 0);
  assert.equal((await call("POST", `/api/clubs/${clubId}/rides`, { cookie: arjun.cookie, payload: rideBody })).statusCode, 404, "members can't post rides");

  const published = await call("PATCH", `/api/clubs/${clubId}/rides/${id}`, { cookie: owner.cookie, payload: { status: "published", title: "Nandi Hills sunrise ride" } });
  assert.equal(published.statusCode, 200);
  assert.equal(published.json().ride.title, "Nandi Hills sunrise ride");
  assert.equal((await call("PATCH", `/api/clubs/${clubId}/rides/${id}`, { cookie: owner.cookie, payload: { status: "draft" } })).statusCode, 409);

  const forMember = (await call("GET", `/api/r/${code}`, { cookie: arjun.cookie })).json().ride;
  assert.equal(forMember.organiser.name, "Priya S.");
  assert.equal(forMember.notes, "Lights mandatory");

  const cancelled = await call("PATCH", `/api/clubs/${clubId}/rides/${id}`, { cookie: owner.cookie, payload: { status: "cancelled" } });
  assert.equal(cancelled.json().ride.status, "cancelled");
  assert.equal((await call("PUT", `/api/r/${code}/rsvp`, { cookie: arjun.cookie, payload: { status: "going" } })).statusCode, 409);
  assert.equal((await call("PATCH", `/api/clubs/${clubId}/rides/${id}`, { cookie: owner.cookie, payload: { title: "Revived" } })).statusCode, 409);
});

test("RSVP: one tap, no duplicates, change of mind, capacity", async () => {
  const created = await call("POST", `/api/clubs/${clubId}/rides`, { cookie: owner.cookie, payload: { ...rideBody, status: "published" } });
  const { code, id } = created.json().ride;
  const rsvp = (who, status) => call("PUT", `/api/r/${code}/rsvp`, { cookie: who.cookie, payload: { status } });

  const first = await rsvp(arjun, "going");
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().ride.my_rsvp, "going");
  assert.equal((await rsvp(arjun, "going")).json().ride.going_count, 1, "repeat tap does not double count");
  await Promise.all([rsvp(arjun, "going"), rsvp(arjun, "going")]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ride_rsvps WHERE ride_id = ?").get(id).n, 1);

  assert.equal((await rsvp(meera, "going")).json().ride.is_full, true);
  const full = await rsvp(owner, "going");
  assert.equal(full.statusCode, 409);
  assert.match(full.json().error, /full/);

  const changed = await rsvp(arjun, "cancelled");
  assert.equal(changed.json().ride.my_rsvp, null);
  assert.equal(changed.json().ride.going_count, 1);
  assert.equal((await rsvp(owner, "going")).statusCode, 200, "freed spot can be taken");

  // Organiser view: full names, accurate list.
  const organiser = (await call("GET", `/api/r/${code}`, { cookie: owner.cookie })).json().ride;
  assert.deepEqual(organiser.riders.map((r) => r.name), ["Meera Iyer", "Priya Sharma"]);
  // Spots can't be cut below who's already going.
  assert.equal((await call("PATCH", `/api/clubs/${clubId}/rides/${id}`, { cookie: owner.cookie, payload: { capacity: 1 } })).statusCode, 409);
});

test("simultaneous RSVPs never exceed capacity", async () => {
  const created = await call("POST", `/api/clubs/${clubId}/rides`, { cookie: owner.cookie, payload: { ...rideBody, capacity: 1, status: "published" } });
  const { code, id } = created.json().ride;
  const results = await Promise.all([arjun, meera, owner].map((who) => call("PUT", `/api/r/${code}/rsvp`, { cookie: who.cookie, payload: { status: "going" } })));
  assert.equal(results.filter((r) => r.statusCode === 200).length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ride_rsvps WHERE ride_id = ? AND status = 'going'").get(id).n, 1);
});

test("outsiders and visitors see the basics only and cannot RSVP", async () => {
  const created = await call("POST", `/api/clubs/${clubId}/rides`, { cookie: owner.cookie, payload: { ...rideBody, status: "published" } });
  const { code } = created.json().ride;
  await call("PUT", `/api/r/${code}/rsvp`, { cookie: arjun.cookie, payload: { status: "going" } });

  for (const cookie of [undefined, outsider.cookie]) {
    const view = (await call("GET", `/api/r/${code}`, { cookie })).json().ride;
    assert.equal(view.going_count, 1);
    assert.equal(view.riders, undefined, "rider list is private");
    assert.equal(view.notes, undefined);
    assert.equal(view.viewer.member, false);
  }
  assert.equal((await call("PUT", `/api/r/${code}/rsvp`, { payload: { status: "going" } })).statusCode, 401);
  const blocked = await call("PUT", `/api/r/${code}/rsvp`, { cookie: outsider.cookie, payload: { status: "going" } });
  assert.equal(blocked.statusCode, 403);
  assert.equal((await call("GET", `/api/clubs/${clubId}/rides`, { cookie: outsider.cookie })).statusCode, 404);
  assert.equal((await call("PATCH", `/api/clubs/${outsider.clubId}/rides/${created.json().ride.id}`, { cookie: outsider.cookie, payload: { title: "Hijack" } })).statusCode, 404, "can't edit another club's ride via own club");
  assert.equal((await call("GET", "/api/r/doesnotexist")).statusCode, 404);
});

test("rides that already started cannot be RSVPed and bad input is rejected", async () => {
  const past = await call("POST", `/api/clubs/${clubId}/rides`, { cookie: owner.cookie, payload: { ...rideBody, starts_at: inDays(-0.01), status: "published" } });
  assert.equal((await call("PUT", `/api/r/${past.json().ride.code}/rsvp`, { cookie: arjun.cookie, payload: { status: "going" } })).statusCode, 409);
  for (const bad of [{ ...rideBody, starts_at: "next saturday" }, { ...rideBody, capacity: 0 }, { ...rideBody, map_url: "javascript:alert(1)" }, { ...rideBody, title: "" }]) {
    assert.equal((await call("POST", `/api/clubs/${clubId}/rides`, { cookie: owner.cookie, payload: bad })).statusCode, 400, JSON.stringify(bad));
  }
});

test.after(async () => { await app.close(); db.close(); rmSync(tempDir, { recursive: true, force: true }); });
