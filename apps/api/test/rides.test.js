import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { useTempDatabase, sessionCookie, makeClient } from "./helpers.js";

const { tempDir } = useTempDatabase();
const { buildApp } = await import("../src/server.js");
const { db } = await import("../src/db.js");
const app = await buildApp({ logger: false, authRateLimit: 1000, publicRateLimit: 1000 });
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

const ridesOf = (club, when) => call("GET", `/api/clubs/${club}/rides${when ? `?when=${when}` : ""}`, { cookie: owner.cookie });
const deviceCookie = (res) => {
  const set = [].concat(res.headers["set-cookie"] || []).find((c) => c.startsWith("paceup_device="));
  return set ? set.split(";")[0] : null;
};
/** A phone with no account: keeps whatever device cookie the server gives it. */
function phone() {
  let cookie;
  return {
    get cookie() { return cookie; },
    async rsvp(code, payload) {
      const res = await call("PUT", `/api/r/${code}/rsvp`, { cookie, payload });
      cookie = deviceCookie(res) || cookie;
      return res;
    },
    view: (code) => call("GET", `/api/r/${code}`, { cookie })
  };
}
const publish = async (extra = {}) => (await call("POST", `/api/clubs/${clubId}/rides`, { cookie: owner.cookie, payload: { ...rideBody, status: "published", ...extra } })).json().ride;

test("activity lifecycle: draft, publish, edit, unpublish, cancel, with an audit trail", async () => {
  const created = await call("POST", `/api/clubs/${clubId}/rides`, { cookie: owner.cookie, payload: { ...rideBody, category: "running" } });
  assert.equal(created.statusCode, 201);
  const { code, id } = created.json().ride;
  assert.equal(created.json().ride.status, "draft");
  assert.equal(created.json().ride.category, "running");
  assert.ok(code.length >= 12, "public token is long enough to be unguessable");

  assert.equal((await call("GET", `/api/r/${code}`, { cookie: arjun.cookie })).statusCode, 404, "members can't see drafts");
  assert.equal((await call("GET", `/api/r/${code}`)).statusCode, 404, "nor can visitors");
  assert.equal((await call("GET", `/api/clubs/${clubId}/rides`, { cookie: arjun.cookie })).json().rides.length, 0);
  assert.equal((await call("POST", `/api/clubs/${clubId}/rides`, { cookie: arjun.cookie, payload: rideBody })).statusCode, 404, "members can't create");

  const published = await call("PATCH", `/api/clubs/${clubId}/rides/${id}`, { cookie: owner.cookie, payload: { status: "published", title: "Nandi Hills sunrise run" } });
  assert.equal(published.statusCode, 200);
  assert.equal(published.json().ride.title, "Nandi Hills sunrise run");
  assert.equal((await call("PATCH", `/api/clubs/${clubId}/rides/${id}`, { cookie: owner.cookie, payload: { status: "draft" } })).json().ride.status, "draft", "unpublish while nobody has joined");
  await call("PATCH", `/api/clubs/${clubId}/rides/${id}`, { cookie: owner.cookie, payload: { status: "published" } });
  await phone().rsvp(code, { status: "going", name: "Rahul Verma" });
  assert.equal((await call("PATCH", `/api/clubs/${clubId}/rides/${id}`, { cookie: owner.cookie, payload: { status: "draft" } })).statusCode, 409, "can't unpublish once people joined");

  const cancelled = await call("PATCH", `/api/clubs/${clubId}/rides/${id}`, { cookie: owner.cookie, payload: { status: "cancelled" } });
  assert.equal(cancelled.json().ride.status, "cancelled");
  assert.equal((await phone().rsvp(code, { status: "going", name: "Late Comer" })).statusCode, 409);
  assert.equal((await call("PATCH", `/api/clubs/${clubId}/rides/${id}`, { cookie: owner.cookie, payload: { title: "Revived" } })).statusCode, 409);

  const history = cancelled.json().ride.history.map((h) => h.action).reverse();
  assert.deepEqual(history, ["created_draft", "published", "unpublished", "published", "cancelled"]);
  assert.equal(cancelled.json().ride.history[0].metadata.going, 1, "cancellation records how many were going");
  assert.equal(cancelled.json().ride.history[0].actor_name, "Priya Sharma");
});

test("public page: anyone with the link sees details and who's going; admins also see who is listed", async () => {
  const ride = await publish({ capacity: null });
  await call("PUT", `/api/r/${ride.code}/rsvp`, { cookie: arjun.cookie, payload: { status: "going" } });
  await phone().rsvp(ride.code, { status: "going", name: "Rahul Verma" });

  const visitor = (await call("GET", `/api/r/${ride.code}`)).json().ride;
  assert.equal(visitor.notes, "Lights mandatory");
  assert.deepEqual(visitor.participants.map((p) => p.name), ["Arjun Rao", "Rahul Verma"]);
  assert.equal(visitor.participants[0].id, undefined, "no ids for the public");
  assert.equal(visitor.history, undefined);
  assert.equal(visitor.organiser.name, "Priya S.");

  const admin = (await call("GET", `/api/r/${ride.code}`, { cookie: owner.cookie })).json().ride;
  assert.deepEqual(admin.participants.map((p) => [p.name, p.kind]), [["Arjun Rao", "member"], ["Rahul Verma", "guest"]]);
});

test("members RSVP with one tap: no duplicates, change of mind, capacity", async () => {
  const { code, id } = await publish();
  const rsvp = (who, status) => call("PUT", `/api/r/${code}/rsvp`, { cookie: who.cookie, payload: { status } });

  const first = await rsvp(arjun, "going");
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().ride.my_rsvp.name, "Arjun Rao");
  assert.equal(deviceCookie(first), null, "members need no device cookie");
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
  assert.equal((await call("PATCH", `/api/clubs/${clubId}/rides/${id}`, { cookie: owner.cookie, payload: { capacity: 1 } })).statusCode, 409);
});

test("guests RSVP by name without an account, and only their own phone can change it", async () => {
  const { code, id } = await publish({ capacity: 5 });
  const rahul = phone();
  const joined = await rahul.rsvp(code, { status: "going", name: "  Rahul   Verma " });
  assert.equal(joined.statusCode, 200);
  assert.ok(rahul.cookie, "device cookie issued");
  assert.match([].concat(joined.headers["set-cookie"]).join(), /HttpOnly/i);
  assert.equal(joined.json().ride.my_rsvp.name, "Rahul Verma");
  assert.equal((await rahul.view(code)).json().ride.participants[0].is_you, true, "reopening the link shows you're in");

  // Change name, then cancel, from the same phone.
  assert.equal((await rahul.rsvp(code, { status: "going", name: "Rahul V" })).json().ride.my_rsvp.name, "Rahul V");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ride_rsvps WHERE ride_id = ?").get(id).n, 1, "a name change edits, not adds");

  // Another phone cannot cancel it, even knowing the name.
  const stranger = phone();
  const cancelTry = await stranger.rsvp(code, { status: "cancelled" });
  assert.equal(cancelTry.statusCode, 200);
  assert.equal(cancelTry.json().ride.going_count, 1, "stranger's cancel did nothing");
  assert.equal((await stranger.rsvp(code, { status: "going", name: "rahul v" })).statusCode, 409, "same name twice is refused");
  assert.equal((await stranger.rsvp(code, { status: "going", name: "x" })).statusCode, 400);
  assert.equal((await stranger.rsvp(code, { status: "going" })).statusCode, 400, "a name is required");
  const forged = await call("PUT", `/api/r/${code}/rsvp`, { cookie: "paceup_device=not-a-real-token", payload: { status: "cancelled" } });
  assert.equal(forged.json().ride.going_count, 1);

  const gone = await rahul.rsvp(code, { status: "cancelled" });
  assert.equal(gone.json().ride.going_count, 0);
  assert.equal(gone.json().ride.my_rsvp, null);
  assert.equal((await rahul.rsvp(code, { status: "going", name: "Rahul Verma" })).json().ride.going_count, 1, "can rejoin");
});

test("signed-up members are suggested too; picking one never needs a login", async () => {
  const { code } = await publish({ capacity: null });
  const names = async (q) => (await call("GET", `/api/r/${code}/names?q=${encodeURIComponent(q)}`)).json().names;
  assert.deepEqual((await names("me")).map((m) => m.name), ["Meera Iyer"]);
  assert.deepEqual((await names("rao")).map((m) => m.name), ["Arjun Rao"], "matches surnames too");
  assert.deepEqual(await names("o"), [], "needs two letters");
  assert.deepEqual(await names("other"), [], "never suggests another club's members");
  assert.deepEqual(await names("%%"), []);

  const p = phone();
  const meeraId = (await names("meera"))[0].id;
  const picked = await p.rsvp(code, { status: "going", member_id: meeraId });
  assert.equal(picked.json().ride.my_rsvp.listed, true);
  // Meera herself, signed in, sees she's in, and can drop out.
  assert.equal((await call("GET", `/api/r/${code}`, { cookie: meera.cookie })).json().ride.my_rsvp.name, "Meera Iyer");
  // Someone else can't pick Meera again.
  assert.equal((await phone().rsvp(code, { status: "going", member_id: meeraId })).statusCode, 409);
  // A member of another club can't be picked here.
  assert.equal((await phone().rsvp(code, { status: "going", member_id: outsider.user.id })).statusCode, 400);
  // Signed-in Meera cancels; the phone's row was hers.
  assert.equal((await call("PUT", `/api/r/${code}/rsvp`, { cookie: meera.cookie, payload: { status: "cancelled" } })).json().ride.going_count, 0);
});

test("simultaneous RSVPs never exceed capacity or duplicate a person", async () => {
  const { code, id } = await publish({ capacity: 2 });
  const phones = Array.from({ length: 6 }, () => phone());
  // Give each phone its device cookie first.
  for (const [i, p] of phones.entries()) { await p.rsvp(code, { status: "going", name: `Warmup ${i}` }); await p.rsvp(code, { status: "cancelled" }); }
  const results = await Promise.all(phones.map((p, i) => p.rsvp(code, { status: "going", name: `Rider ${i}` })));
  assert.equal(results.filter((r) => r.statusCode === 200).length, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ride_rsvps WHERE ride_id = ? AND status = 'going'").get(id).n, 2);
  const again = await Promise.all([1, 2, 3].map(() => phones[0].rsvp(code, { status: "going", name: "Rider 0" })));
  assert.ok(again.every((r) => r.statusCode === 200 || r.statusCode === 409));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ride_rsvps WHERE ride_id = ? AND device_hash IS NOT NULL").get(id).n, 6, "one row per phone");
});

test("admins manage participants; other clubs can't touch them", async () => {
  const { code, id } = await publish();
  await phone().rsvp(code, { status: "going", name: "Spam Name" });
  const admin = (await call("GET", `/api/r/${code}`, { cookie: owner.cookie })).json().ride;
  const rsvpId = admin.participants[0].id;
  const url = `/api/clubs/${clubId}/rides/${id}/participants/${rsvpId}`;
  assert.equal((await call("DELETE", url, { cookie: arjun.cookie })).statusCode, 404, "members can't remove people");
  assert.equal((await call("DELETE", `/api/clubs/${outsider.clubId}/rides/${id}/participants/${rsvpId}`, { cookie: outsider.cookie })).statusCode, 404);
  const removed = await call("DELETE", url, { cookie: owner.cookie });
  assert.equal(removed.json().ride.going_count, 0);
  assert.equal(removed.json().ride.history[0].action, "participant_removed");
  assert.equal(removed.json().ride.history[0].metadata.name, "Spam Name");
});

test("club isolation: another club can't list, edit or see drafts", async () => {
  const draft = (await call("POST", `/api/clubs/${clubId}/rides`, { cookie: owner.cookie, payload: rideBody })).json().ride;
  assert.equal((await call("GET", `/api/clubs/${clubId}/rides`, { cookie: outsider.cookie })).statusCode, 404);
  assert.equal((await call("PATCH", `/api/clubs/${outsider.clubId}/rides/${draft.id}`, { cookie: outsider.cookie, payload: { title: "Hijack" } })).statusCode, 404);
  assert.equal((await call("PATCH", `/api/clubs/${clubId}/rides/${draft.id}`, { cookie: outsider.cookie, payload: { title: "Hijack" } })).statusCode, 404);
  assert.equal((await call("GET", `/api/r/${draft.code}`, { cookie: outsider.cookie })).statusCode, 404);
  assert.ok((await call("GET", `/api/clubs/${outsider.clubId}/rides`, { cookie: outsider.cookie })).json().rides.every((r) => r.id !== draft.id));
  assert.equal((await call("GET", "/api/r/doesnotexist")).statusCode, 404);
});

test("dashboard lists upcoming and past separately; started activities close RSVPs", async () => {
  const past = await publish({ starts_at: inDays(-2), title: "Last week's ride" });
  const justStarted = await publish({ starts_at: inDays(-0.01), title: "Just started" });
  assert.ok((await ridesOf(clubId, "past")).json().rides.some((r) => r.id === past.id));
  assert.ok(!(await ridesOf(clubId)).json().rides.some((r) => r.id === past.id));
  assert.ok((await ridesOf(clubId)).json().rides.some((r) => r.id === justStarted.id), "still shown until 12 h after start");
  assert.equal((await phone().rsvp(justStarted.code, { status: "going", name: "Late Rider" })).statusCode, 409);
  assert.equal((await call("GET", `/api/r/${past.code}`)).json().ride.past, true);
});

test("bad input is rejected", async () => {
  for (const bad of [{ ...rideBody, starts_at: "next saturday" }, { ...rideBody, capacity: 0 }, { ...rideBody, map_url: "javascript:alert(1)" }, { ...rideBody, title: "" }, { ...rideBody, category: "chess" }]) {
    assert.equal((await call("POST", `/api/clubs/${clubId}/rides`, { cookie: owner.cookie, payload: bad })).statusCode, 400, JSON.stringify(bad));
  }
});

test.after(async () => { await app.close(); db.close(); rmSync(tempDir, { recursive: true, force: true }); });
